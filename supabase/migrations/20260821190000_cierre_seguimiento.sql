-- Cierre del día de Seguimiento — Fase 3 del plan "de pantalla a proceso".
--
-- ADITIVA: crea UNA tabla y UNA función nuevas. **No toca
-- `submit_closing_report`** ni ninguna otra función viva (⛔ REGLA #1) — esa
-- fue reescrita en cuatro migraciones distintas y no se sabe cuál está
-- desplegada, así que ni se la mira.
--
-- ── Por qué hace falta ──────────────────────────────────────────────────────
-- `ClosingReportDialog` existe SOLO en `/confirmar`. El trabajo de Confirmar
-- tiene un final —la asesora declara "terminé" y queda escrito qué pasó— y el
-- de Seguimiento no tiene ninguno: simplemente se apaga la computadora. Un
-- trabajo que nadie declara terminado tampoco se declara incompleto nunca.
--
-- La regla del dueño para esa pantalla es "Seguimiento se deja en 0". Esto la
-- vuelve verificable: **o queda en cero, o queda escrito el motivo.**
--
-- ── Lo que NO es ────────────────────────────────────────────────────────────
-- No es un candado. Nadie queda bloqueado por no cerrar, igual que la
-- asignación es etiqueta y no candado. Si alguien lo convierte en un requisito
-- para salir de la pantalla, repite el error de `OpeningReportGate`, que
-- bloqueaba con `fixed inset-0` sin Esc y terminó desmontado.

-- ── Tabla ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.seg_cierres (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id     uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  operator_id  uuid NOT NULL REFERENCES auth.users(id)    ON DELETE CASCADE,
  -- Día Bogotá, calculado en el SERVIDOR. Nunca del reloj del navegador: entre
  -- las 19:00 y la medianoche de Bogotá la fecha UTC ya es la del día
  -- siguiente, y el cierre de hoy se archivaría como el de mañana. Es el mismo
  -- error de zona horaria que ya se pagó en el dashboard.
  dia          date NOT NULL DEFAULT ((now() AT TIME ZONE 'America/Bogota')::date),
  -- Foto del momento del cierre. Se guardan los números y no se recalculan
  -- después: lo que la persona firmó es lo que tenía delante.
  cola         int  NOT NULL CHECK (cola >= 0),
  gestionados  int  NOT NULL CHECK (gestionados >= 0),
  faltaron     int  NOT NULL CHECK (faltaron >= 0),
  -- Obligatorio SOLO si quedó algo sin gestionar. El CHECK es la mitad
  -- servidor de la regla "o en cero, o con motivo": el cliente ya lo exige,
  -- pero un cliente se puede saltar.
  motivo       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seg_cierres_motivo_si_faltaron
    CHECK (faltaron = 0 OR (motivo IS NOT NULL AND length(btrim(motivo)) >= 15))
);

-- Un cierre por persona por día. Volver a enviarlo CORRIGE el anterior (la RPC
-- hace DO UPDATE): si alguien cierra a las 5 y después trabaja media hora más,
-- lo honesto es que pueda actualizar su cierre, no que quede el número viejo.
CREATE UNIQUE INDEX IF NOT EXISTS seg_cierres_store_op_dia_uk
  ON public.seg_cierres (store_id, operator_id, dia);

CREATE INDEX IF NOT EXISTS seg_cierres_store_dia_idx
  ON public.seg_cierres (store_id, dia DESC);

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Lectura: cualquier miembro de la tienda. El cierre existe para que el dueño
-- no tenga que preguntar; esconderlo lo devolvería al punto de partida. Y que
-- el equipo vea los cierres de sus compañeras es sano: es el mismo turno.
-- Escritura: SOLO por la RPC (SECURITY DEFINER). Sin policy de INSERT/UPDATE
-- para `authenticated`, nadie firma un cierre por REST a nombre de otra.

ALTER TABLE public.seg_cierres ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "miembros leen cierres de su tienda" ON public.seg_cierres;
CREATE POLICY "miembros leen cierres de su tienda"
  ON public.seg_cierres FOR SELECT TO authenticated
  USING (public.is_store_member(store_id));

REVOKE ALL ON public.seg_cierres FROM anon;
GRANT SELECT ON public.seg_cierres TO authenticated;

-- ── Firmar el cierre ────────────────────────────────────────────────────────
-- La decisión de si se puede cerrar y si hace falta motivo vive en
-- `src/lib/cierreSeguimiento.ts` (puro y testeado). Esta función escribe y
-- valida que lo que llega sea legítimo.

CREATE OR REPLACE FUNCTION public.cerrar_seguimiento(
  p_store_id    uuid,
  p_cola        int,
  p_gestionados int,
  p_motivo      text DEFAULT NULL
)
RETURNS TABLE (dia date, faltaron int)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dia      date;
  v_faltaron int;
  v_motivo   text;
BEGIN
  -- Miembro, no manager: la asesora cierra SU día. El dueño también puede,
  -- porque también puede trabajar la cola.
  IF NOT public.is_store_member(p_store_id) THEN
    RAISE EXCEPTION 'No autorizado para cerrar el día de esta tienda'
      USING ERRCODE = '42501';
  END IF;

  IF p_cola < 0 OR p_gestionados < 0 THEN
    RAISE EXCEPTION 'Números de cierre inválidos' USING ERRCODE = '22023';
  END IF;

  v_dia      := (now() AT TIME ZONE 'America/Bogota')::date;
  v_faltaron := GREATEST(p_cola - p_gestionados, 0);
  v_motivo   := NULLIF(btrim(COALESCE(p_motivo, '')), '');

  -- La otra mitad de "o en cero, o con motivo". El CHECK de la tabla lo
  -- garantiza igual; acá se hace para devolver un mensaje que se entienda en
  -- vez de un error de constraint.
  IF v_faltaron > 0 AND (v_motivo IS NULL OR length(v_motivo) < 15) THEN
    RAISE EXCEPTION 'Quedaron % pedidos sin gestionar: hace falta escribir por qué', v_faltaron
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.seg_cierres (store_id, operator_id, dia, cola, gestionados, faltaron, motivo)
  VALUES (p_store_id, auth.uid(), v_dia, p_cola, p_gestionados, v_faltaron, v_motivo)
  ON CONFLICT (store_id, operator_id, dia) DO UPDATE SET
    cola        = EXCLUDED.cola,
    gestionados = EXCLUDED.gestionados,
    faltaron    = EXCLUDED.faltaron,
    motivo      = EXCLUDED.motivo,
    created_at  = now();

  RETURN QUERY SELECT v_dia, v_faltaron;
END;
$$;

REVOKE ALL ON FUNCTION public.cerrar_seguimiento(uuid, int, int, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.cerrar_seguimiento(uuid, int, int, text) TO authenticated;

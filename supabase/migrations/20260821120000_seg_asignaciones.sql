-- Asignación de la cola de Seguimiento — pieza C del protocolo del turno.
--
-- ADITIVA: crea UNA tabla y DOS funciones nuevas. No reescribe ni toca ninguna
-- función existente (⛔ REGLA #1 de CLAUDE.md), ni el trigger de `orders`, ni
-- las RPC vestigiales claim_seg_order/release_seg_order, ni el cron
-- `release-stale-seg-assignments`.
--
-- ── Por qué tabla propia y NO `orders.assigned_to` ──────────────────────────
-- El cron `release-stale-seg-assignments` (cada hora, migration 20260426160000)
-- pone `assigned_to = NULL` cuando el asignado no dejó un touchpoint en 48 h.
-- O sea: borraría exactamente los pedidos que NADIE tocó — que son justo los
-- que hay que poder rastrear. Escribir la asignación ahí la haría desaparecer
-- sola cada hora, en silencio.
--
-- ── Por qué NO se repite el error de mayo ───────────────────────────────────
-- La auto-asignación se apagó el 24-may-2026
-- (`20260524120000_disable_auto_assign_operator.sql`): un trigger estampaba
-- dueño en CADA pedido al nacer y la pantalla lo trataba como CANDADO
-- ("Atendido por X — no puedes ejecutar acciones"). Todo tenía dueño, casi nada
-- tenía trabajo hecho, y las demás quedaban bloqueadas.
--
-- Acá:
--   · Se reparte la COLA ACCIONABLE DEL DÍA, no los pedidos al nacer.
--   · La asignación es una ETIQUETA DE RESPONSABILIDAD, NUNCA UN CANDADO.
--     Esta migración no crea ninguna política ni chequeo que impida a otra
--     operadora gestionar un pedido asignado. Si algún día alguien agrega ese
--     bloqueo, está repitiendo el error de mayo.
--   · La clave incluye el DÍA: la asignación de ayer no arrastra para siempre.
--     Cada día se reparte de nuevo y lo de ayer queda como registro.

-- ── Tabla ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.seg_asignaciones (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  order_id    uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  operator_id uuid NOT NULL REFERENCES auth.users(id)   ON DELETE CASCADE,
  -- Día Bogotá del reparto. CO y EC comparten wall-clock (UTC-5); GT va en
  -- UTC-6 y podría correrse unas horas. Se acepta: el reparto es una decisión
  -- de turno, no un asiento contable.
  dia         date NOT NULL DEFAULT ((now() AT TIME ZONE 'America/Bogota')::date),
  origen      text NOT NULL DEFAULT 'auto' CHECK (origen IN ('auto', 'manual')),
  assigned_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  assigned_at timestamptz NOT NULL DEFAULT now()
);

-- Un pedido tiene UN dueño por día. Es lo que hace idempotente volver a correr
-- el reparto: el segundo intento choca y no pisa a quien ya lo empezó.
CREATE UNIQUE INDEX IF NOT EXISTS seg_asignaciones_order_dia_uk
  ON public.seg_asignaciones (order_id, dia);

-- "Mi lista de hoy" y el reparto leen por acá.
CREATE INDEX IF NOT EXISTS seg_asignaciones_store_dia_op_idx
  ON public.seg_asignaciones (store_id, dia, operator_id);

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Lectura: cualquier miembro de la tienda. A propósito TODOS ven TODAS las
-- asignaciones, no solo las suyas: la tarjeta muestra de quién es el pedido, y
-- esconderlo devolvería el pool anónimo que este trabajo viene a arreglar.
-- Escritura: solo por la RPC (SECURITY DEFINER). No hay policy de INSERT/UPDATE
-- para `authenticated` — así nadie se auto-asigna la cola por REST.

ALTER TABLE public.seg_asignaciones ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "miembros leen asignaciones de su tienda" ON public.seg_asignaciones;
CREATE POLICY "miembros leen asignaciones de su tienda"
  ON public.seg_asignaciones FOR SELECT TO authenticated
  USING (public.is_store_member(store_id));

REVOKE ALL ON public.seg_asignaciones FROM anon;
GRANT SELECT ON public.seg_asignaciones TO authenticated;

-- ── Escribir el reparto ─────────────────────────────────────────────────────
-- El QUÉ se reparte y a QUIÉN lo decide `src/lib/repartoEquitativo.ts` (puro y
-- testeado). Esta función solo escribe, y valida que lo que llega sea legítimo.
--
-- Fail-closed en tres puntos: quien llama tiene que ser manager de ESA tienda;
-- cada pedido tiene que ser de ESA tienda; y cada operador tiene que ser
-- miembro de ESA tienda. Sin lo último, un manager podría asignarle trabajo al
-- usuario de otra empresa y ese usuario vería el pedido en su lista.

CREATE OR REPLACE FUNCTION public.repartir_seguimiento(
  p_store_id      uuid,
  p_asignaciones  jsonb,              -- [{"order_id": "...", "operator_id": "..."}]
  p_origen        text DEFAULT 'auto'
)
RETURNS TABLE (asignados int, ignorados int)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dia         date;
  v_insertados  int := 0;
  v_total       int := 0;
BEGIN
  IF NOT public.is_store_manager(p_store_id) THEN
    RAISE EXCEPTION 'No autorizado para repartir la cola de esta tienda'
      USING ERRCODE = '42501';
  END IF;

  IF p_origen NOT IN ('auto', 'manual') THEN
    RAISE EXCEPTION 'origen inválido: %', p_origen USING ERRCODE = '22023';
  END IF;

  v_dia := (now() AT TIME ZONE 'America/Bogota')::date;

  SELECT count(*) INTO v_total
  FROM jsonb_array_elements(COALESCE(p_asignaciones, '[]'::jsonb));

  WITH entrada AS (
    SELECT
      (e ->> 'order_id')::uuid    AS order_id,
      (e ->> 'operator_id')::uuid AS operator_id
    FROM jsonb_array_elements(COALESCE(p_asignaciones, '[]'::jsonb)) e
  ),
  -- Solo pedidos de esta tienda y operadores miembros de esta tienda. Lo que no
  -- pasa el filtro se IGNORA en silencio (y se reporta en `ignorados`): abortar
  -- el lote entero por una fila vieja dejaría el reparto sin correr.
  validas AS (
    SELECT en.order_id, en.operator_id
    FROM entrada en
    JOIN public.orders o        ON o.id = en.order_id AND o.store_id = p_store_id
    JOIN public.store_members sm ON sm.user_id = en.operator_id AND sm.store_id = p_store_id
  )
  INSERT INTO public.seg_asignaciones (store_id, order_id, operator_id, dia, origen, assigned_by)
  SELECT DISTINCT p_store_id, v.order_id, v.operator_id, v_dia, p_origen, auth.uid()
  FROM validas v
  -- DO NOTHING y no DO UPDATE: si el pedido YA tiene dueño hoy, no se le roba.
  -- Es lo que hace seguro volver a correr el reparto durante el día.
  ON CONFLICT (order_id, dia) DO NOTHING;

  GET DIAGNOSTICS v_insertados = ROW_COUNT;

  RETURN QUERY SELECT v_insertados, GREATEST(v_total - v_insertados, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.repartir_seguimiento(uuid, jsonb, text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.repartir_seguimiento(uuid, jsonb, text) TO authenticated;

COMMENT ON FUNCTION public.repartir_seguimiento(uuid, jsonb, text) IS
  'Escribe el reparto de la cola de Seguimiento del día (Bogotá). Manager-only. '
  'ON CONFLICT DO NOTHING: nunca le roba un pedido a quien ya lo tiene hoy. '
  'La asignación es una etiqueta de responsabilidad, NO un candado: nada acá '
  'impide que otra operadora gestione un pedido asignado (ver 20260524120000).';

-- ── Reasignar / soltar un pedido puntual ────────────────────────────────────
-- `p_operator_id NULL` borra la asignación del día (vuelve al pool sin dueño).

CREATE OR REPLACE FUNCTION public.reasignar_seguimiento(
  p_store_id    uuid,
  p_order_id    uuid,
  p_operator_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dia date;
BEGIN
  IF NOT public.is_store_manager(p_store_id) THEN
    RAISE EXCEPTION 'No autorizado para reasignar en esta tienda'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.orders WHERE id = p_order_id AND store_id = p_store_id) THEN
    RAISE EXCEPTION 'El pedido no pertenece a esta tienda' USING ERRCODE = '42501';
  END IF;

  v_dia := (now() AT TIME ZONE 'America/Bogota')::date;

  IF p_operator_id IS NULL THEN
    DELETE FROM public.seg_asignaciones WHERE order_id = p_order_id AND dia = v_dia;
    RETURN true;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.store_members
    WHERE user_id = p_operator_id AND store_id = p_store_id
  ) THEN
    RAISE EXCEPTION 'Esa persona no es miembro de esta tienda' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.seg_asignaciones (store_id, order_id, operator_id, dia, origen, assigned_by)
  VALUES (p_store_id, p_order_id, p_operator_id, v_dia, 'manual', auth.uid())
  ON CONFLICT (order_id, dia)
  DO UPDATE SET operator_id = EXCLUDED.operator_id,
                origen      = 'manual',
                assigned_by = EXCLUDED.assigned_by,
                assigned_at = now();

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.reasignar_seguimiento(uuid, uuid, uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.reasignar_seguimiento(uuid, uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.reasignar_seguimiento(uuid, uuid, uuid) IS
  'Mueve un pedido a otra asesora (o lo suelta al pool con operator_id NULL). '
  'Manager-only. A diferencia de repartir_seguimiento, este SÍ pisa al dueño '
  'anterior: es una decisión explícita de una persona, no un reparto automático.';

-- Nunca más mezclar Colombia con Ecuador: el scope de admin falla CERRADO.
--
-- Queja del dueño (2026-07-21): estando en Ecuador vio a "Mayra portillo" —
-- operadora de COLOMBIA — en la Jornada y en Reportes diarios. Ya había pasado
-- antes y se creía cubierto.
--
-- ════ CAUSA RAÍZ ════
--
-- `_resolve_scope_store()` tiene dos caminos y NO son igual de estrictos:
--
--   · NO-admin: valida membresía, cae a su tienda, y si no puede resolver
--     LANZA 'No autorizado'. Riguroso.
--   · admin:    `SELECT active_store_id ... ; RETURN v_store;`  ← tal cual,
--     pudiendo devolver NULL.
--
-- Y NULL, para casi todos los consumidores, significa TODAS las tiendas:
--
--     AND (v_store IS NULL OR dr.store_id = v_store)
--
-- O sea que el único usuario que maneja los dos países es justo el que tiene el
-- camino flojo. Si `profiles.active_store_id` no está sincronizado —la sync es
-- best-effort desde StoreContext y puede fallar por red o por una carrera— el
-- panel dice "Rushmira Ecuador" arriba mientras las tablas traen CO+EC juntas.
-- Eso explica por qué aparecía de forma intermitente.
--
-- ════ POR QUÉ SE ARREGLA ACÁ Y NO EN CADA RPC ════
--
-- El patrón `(v_store IS NULL OR ...)` está repetido en admin_daily_reports_range,
-- admin_operator_shifts_range, operator_productivity_stats, operator_activity_stats
-- y varias más. Reescribirlas desde el repo sería PELIGROSO: hay drift conocido
-- entre lo desplegado y estos archivos (varias fueron editadas por Lovable), así
-- que copiar los cuerpos de acá revertiría arreglos que hoy están en producción.
--
-- Cambiando el RESOLVEDOR se corrigen todas de una, sin tocar ningún cuerpo.
--
-- ════ QUÉ HACE AHORA EL CAMINO DE ADMIN ════
--
--   1. ¿Hay `active_store_id`? → esa. (El caso normal.)
--   2. ¿No hay, pero es miembro de UNA sola tienda? → esa. No hay ambigüedad
--      posible, y así un admin de una sola tienda nunca ve la pantalla vacía.
--   3. ¿No hay, y es miembro de VARIAS? → CENTINELA que no coincide con ninguna
--      tienda → los consumidores devuelven VACÍO.
--
-- El punto 3 es el cambio de fondo: ante la duda, NADA en vez de TODO. Mostrar
-- los datos de otro país creyendo que son los tuyos es peor que no mostrar nada
-- — con esto se decide plata y se evalúa gente. Una pantalla vacía se nota y se
-- reporta; una mezclada se cree.
--
-- El centinela es el UUID cero. `store_id = '000...000'` no matchea ninguna fila
-- real, así que sirve igual para los consumidores que comparan (`= v_store`) y
-- para los que ya cortan en seco (`IF v_store IS NULL THEN RETURN`). No hace
-- falta que todos usen el mismo estilo.
--
-- NO se toca el camino de no-admin: ya era estricto.

CREATE OR REPLACE FUNCTION public._resolve_scope_store()
RETURNS uuid
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_store uuid;
  v_count int;
BEGIN
  IF public.has_role(auth.uid(), 'admin') THEN
    -- 1. Tienda activa sincronizada (el caso normal).
    SELECT active_store_id INTO v_store FROM public.profiles WHERE user_id = auth.uid();
    IF v_store IS NOT NULL THEN
      RETURN v_store;
    END IF;

    -- 2. Sin sincronizar: si es miembro de UNA sola tienda no hay ambigüedad.
    SELECT COUNT(*) INTO v_count FROM public.store_members WHERE user_id = auth.uid();
    IF v_count = 1 THEN
      SELECT store_id INTO v_store FROM public.store_members WHERE user_id = auth.uid();
      RETURN v_store;
    END IF;

    -- 3. Varias tiendas y no sabemos cuál: CENTINELA (no matchea ninguna) para
    --    que las pantallas salgan VACÍAS en vez de mezclar países.
    RETURN '00000000-0000-0000-0000-000000000000'::uuid;
  END IF;

  -- ── Camino NO-admin: intacto, ya era estricto ──
  SELECT p.active_store_id INTO v_store
  FROM public.profiles p
  WHERE p.user_id = auth.uid()
    AND p.active_store_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.store_members m
      WHERE m.user_id = auth.uid()
        AND m.store_id = p.active_store_id
        AND m.role IN ('owner','supervisor')
    );
  IF v_store IS NOT NULL THEN
    RETURN v_store;
  END IF;

  SELECT store_id INTO v_store FROM public.store_members
   WHERE user_id = auth.uid() AND role IN ('owner','supervisor')
   ORDER BY store_id ASC
   LIMIT 1;
  IF v_store IS NULL THEN
    RAISE EXCEPTION 'No autorizado' USING ERRCODE = '42501';
  END IF;
  RETURN v_store;
END $$;

-- operator_productivity_stats v4 — esfuerzo + pendientes sin tocar (2026-05-28).
--
-- Problema: el dashboard ocultaba el esfuerzo real. Mayra confirmó 9 pedidos
-- pero la columna N/R aparecía en 0 porque el filtro `noresp` (v3, líneas
-- 73-81) hace `NOT EXISTS conf/canc posterior` — un noresp que después se
-- cierra como conf desaparece. Eso está bien para el ESTADO ACTUAL del pedido,
-- pero esconde el ESFUERZO ("llamé y no me contestaron en el primer intento").
--
-- Esta migración AGREGA 3 columnas al RETURNS TABLE sin tocar las existentes:
--
--   intentos_noresp      = COUNT(DISTINCT order_id) FILTER (result='noresp')
--                          → ESFUERZO: pedidos donde no contestó al menos una
--                          vez, aunque después haya terminado en conf.
--
--   intentos_total       = COUNT(*) FILTER (module='confirmar')
--                          → Acciones totales (no distinct). Si llamó 3 veces
--                          al mismo pedido = 3.
--
--   pendientes_sin_tocar = max(entrantes_global - atendidos_del_operador, 0)
--                          → Cuánto le falta. El valor es GLOBAL del store
--                          (la fila TOTAL del dashboard suma esto a ojo;
--                          cada row trae el mismo número porque depende del
--                          inflow global, no del operador).
--
-- Cambia la firma RETURNS TABLE (+3 columnas al final) → DROP + CREATE + GRANT.

DROP FUNCTION IF EXISTS public.operator_productivity_stats(text);

CREATE OR REPLACE FUNCTION public.operator_productivity_stats(p_range text DEFAULT 'today'::text)
 RETURNS TABLE(
   operator_id uuid, display_name text,
   confirmados bigint, cancelados bigint, noresp bigint, novedades_resueltas bigint,
   seg_acciones bigint, seg_resueltos bigint, rescate_acciones bigint, rescate_resueltos bigint,
   total_atendidos bigint, total_entrantes bigint, tasa_contacto numeric, tasa_confirmacion numeric,
   seg_pedidos bigint, seg_resueltos_dist bigint, rescate_pedidos bigint, rescate_resueltos_dist bigint,
   intentos_noresp bigint, intentos_total bigint, pendientes_sin_tocar bigint
 )
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_since timestamptz;
  v_total_entrantes bigint;
  v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();

  -- Ventanas alineadas a medianoche Bogotá (calendario), no rodantes — igual
  -- que v3 (20260526140000). 'today'/'7d'/'30d' arrancan en medianoche del día
  -- correspondiente, así productividad reconcilia con el cohorte diario.
  v_since := CASE p_range
    WHEN 'today' THEN (((NOW() AT TIME ZONE 'America/Bogota')::date)::timestamp AT TIME ZONE 'America/Bogota')
    WHEN '7d'    THEN ((((NOW() AT TIME ZONE 'America/Bogota')::date) - 6)::timestamp AT TIME ZONE 'America/Bogota')
    WHEN '30d'   THEN ((((NOW() AT TIME ZONE 'America/Bogota')::date) - 29)::timestamp AT TIME ZONE 'America/Bogota')
    ELSE (((NOW() AT TIME ZONE 'America/Bogota')::date)::timestamp AT TIME ZONE 'America/Bogota')
  END;

  SELECT COUNT(DISTINCT o.id) INTO v_total_entrantes
  FROM public.orders o
  WHERE o.created_at >= v_since
    AND (v_store IS NULL OR o.store_id = v_store)
    AND (
      o.estado = 'PENDIENTE CONFIRMACION'
      OR EXISTS (
        SELECT 1 FROM public.order_results r
        WHERE r.order_id = o.id AND r.module='confirmar'
          AND (v_store IS NULL OR r.store_id = v_store)
      )
    );

  RETURN QUERY
  WITH base AS (
    SELECT
      r.operator_id AS op_id,
      COUNT(DISTINCT r.order_id) FILTER (WHERE r.module='confirmar' AND r.result='conf') AS confirmados,
      COUNT(DISTINCT r.order_id) FILTER (WHERE r.module='confirmar' AND r.result='canc') AS cancelados,
      -- noresp ABIERTOS: el último intento fue 'no contestó' (no hay conf/canc posterior).
      -- Métrica de estado actual del pedido. Esta NO cambia respecto a v3.
      COUNT(DISTINCT r.order_id) FILTER (
        WHERE r.module='confirmar' AND r.result='noresp'
          AND NOT EXISTS (
            SELECT 1 FROM public.order_results r2
            WHERE r2.order_id = r.order_id AND r2.module='confirmar'
              AND r2.result IN ('conf','canc') AND r2.created_at >= v_since
              AND (v_store IS NULL OR r2.store_id = v_store)
          )
      ) AS noresp,
      COUNT(*) FILTER (WHERE r.module='novedades' AND r.result='conf') AS novedades_resueltas,
      COUNT(DISTINCT r.order_id) FILTER (WHERE r.module='confirmar') AS total_atendidos,
      -- ESFUERZO: pedidos distintos donde marcó noresp al menos una vez,
      -- INCLUSO si después los terminó en conf/canc. Esto sí cuenta el "llamé
      -- y no me contestaron en el primer intento".
      COUNT(DISTINCT r.order_id) FILTER (WHERE r.module='confirmar' AND r.result='noresp') AS intentos_noresp,
      -- ESFUERZO bruto: cada acción suma. Si llamó 3 veces al mismo pedido = 3.
      COUNT(*) FILTER (WHERE r.module='confirmar') AS intentos_total
    FROM public.order_results r
    WHERE r.created_at >= v_since
      AND (v_store IS NULL OR r.store_id = v_store)
    GROUP BY r.operator_id
  ),
  tp_stats AS (
    SELECT
      t.operator_id AS op_id,
      COUNT(*) FILTER (WHERE t.action LIKE 'SEG:%') AS seg_acciones,
      COUNT(*) FILTER (WHERE t.action IN ('SEG: Resuelto','SEG: Devolución','SEG: Devolucion solicitada','SEG: Solicite devolucion')) AS seg_resueltos,
      COUNT(DISTINCT t.phone) FILTER (WHERE t.action LIKE 'SEG:%') AS seg_pedidos,
      COUNT(DISTINCT t.phone) FILTER (WHERE t.action IN ('SEG: Resuelto','SEG: Devolución','SEG: Devolucion solicitada','SEG: Solicite devolucion')) AS seg_resueltos_dist,
      COUNT(*) FILTER (WHERE t.action LIKE 'RESCUE:%') AS rescate_acciones,
      COUNT(*) FILTER (WHERE t.action IN ('RESCUE: Resuelto','RESCUE: Devolución','RESCUE: Devolucion solicitada','RESCUE: Solicite devolucion')) AS rescate_resueltos,
      COUNT(DISTINCT t.phone) FILTER (WHERE t.action LIKE 'RESCUE:%') AS rescate_pedidos,
      COUNT(DISTINCT t.phone) FILTER (WHERE t.action IN ('RESCUE: Resuelto','RESCUE: Devolución','RESCUE: Devolucion solicitada','RESCUE: Solicite devolucion')) AS rescate_resueltos_dist
    FROM public.touchpoints t
    WHERE t.created_at >= v_since
      AND (v_store IS NULL OR t.store_id = v_store)
    GROUP BY t.operator_id
  ),
  all_ops AS (
    SELECT op_id FROM base
    UNION
    SELECT op_id FROM tp_stats
  )
  SELECT
    ao.op_id,
    COALESCE(p.display_name,'Operador'),
    COALESCE(b.confirmados,0)::bigint,
    COALESCE(b.cancelados,0)::bigint,
    COALESCE(b.noresp,0)::bigint,
    COALESCE(b.novedades_resueltas,0)::bigint,
    COALESCE(t.seg_acciones,0)::bigint,
    COALESCE(t.seg_resueltos,0)::bigint,
    COALESCE(t.rescate_acciones,0)::bigint,
    COALESCE(t.rescate_resueltos,0)::bigint,
    COALESCE(b.total_atendidos,0)::bigint,
    v_total_entrantes,
    CASE WHEN COALESCE(b.total_atendidos,0)=0 THEN 0
         ELSE ROUND(((COALESCE(b.confirmados,0)+COALESCE(b.cancelados,0))::numeric/b.total_atendidos::numeric)*100,1) END,
    CASE WHEN v_total_entrantes=0 THEN 0
         ELSE ROUND((COALESCE(b.confirmados,0)::numeric/v_total_entrantes::numeric)*100,1) END,
    COALESCE(t.seg_pedidos,0)::bigint,
    COALESCE(t.seg_resueltos_dist,0)::bigint,
    COALESCE(t.rescate_pedidos,0)::bigint,
    COALESCE(t.rescate_resueltos_dist,0)::bigint,
    -- NUEVAS COLUMNAS (v4):
    COALESCE(b.intentos_noresp,0)::bigint,
    COALESCE(b.intentos_total,0)::bigint,
    -- pendientes_sin_tocar: entrantes globales menos atendidos del operador.
    -- Es el mismo número que pone "cuántos pedidos del período este operador
    -- todavía no ha tocado". GREATEST evita negativos si hay race conditions.
    GREATEST(v_total_entrantes - COALESCE(b.total_atendidos,0), 0)::bigint
  FROM all_ops ao
  LEFT JOIN base b ON b.op_id = ao.op_id
  LEFT JOIN tp_stats t ON t.op_id = ao.op_id
  LEFT JOIN public.profiles p ON p.user_id = ao.op_id
  WHERE (v_store IS NULL OR EXISTS (
    SELECT 1 FROM public.store_members sm
    WHERE sm.user_id = ao.op_id AND sm.store_id = v_store AND sm.role = 'operator'
  ))
  ORDER BY (COALESCE(b.confirmados,0)+COALESCE(t.seg_acciones,0)+COALESCE(t.rescate_acciones,0)) DESC, 2;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.operator_productivity_stats(text) TO authenticated;

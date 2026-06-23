-- operator_productivity_stats v5 — `novedades_resueltas` desde touchpoints
-- (2026-06-23).
--
-- Problema: la columna `novedades_resueltas` contaba
--   COUNT(*) FILTER (WHERE r.module='novedades' AND r.result='conf')
-- sobre `order_results`. PERO ninguna parte de la app escribe order_results con
-- module='novedades' (de hecho el CHECK de la tabla solo permite
-- 'confirmar'/'seguimiento'/'rescate'), así que ese contador estaba SIEMPRE en 0
-- y la sección "Novedades" del dashboard de Productividad nunca aparecía.
--
-- La gestión de novedades vive en `touchpoints` con action 'NOVEDAD: ...'
-- (igual que SEG/RESCUE), escrita por /novedades (useMarkNovedadResolved +
-- el flujo legacy de useNovedades/OrderDetailPage). Este es el patrón de marca
-- ya consolidado.
--
-- Fix (Approach A): contar `novedades_resueltas` desde `touchpoints` en el CTE
-- `tp_stats` (que ya lee touchpoints), reconociendo el formato nuevo
-- ('NOVEDAD: Resuelta%') y el legacy ('NOVEDAD: Volver a ofrecer%'). Las
-- DEVOLUCIONES y los 'Sin respuesta' NO cuentan como resueltas (devolución es
-- otro outcome; sin respuesta es solo un intento) — igual criterio que el
-- result='conf' original.
--
-- La firma RETURNS TABLE NO cambia (mismas columnas, mismo orden) → se usa
-- CREATE OR REPLACE (sin DROP) y el frontend sigue igual. Solo cambia el ORIGEN
-- de `novedades_resueltas`: antes `base` (order_results), ahora `tp_stats`
-- (touchpoints).

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
      COUNT(DISTINCT t.phone) FILTER (WHERE t.action IN ('RESCUE: Resuelto','RESCUE: Devolución','RESCUE: Devolucion solicitada','RESCUE: Solicite devolucion')) AS rescate_resueltos_dist,
      -- NOVEDADES RESUELTAS (v5): desde touchpoints, no order_results.
      -- Cuenta las gestiones que cierran la novedad como RESUELTA (formato nuevo
      -- 'NOVEDAD: Resuelta%' + legacy 'NOVEDAD: Volver a ofrecer%'). Devoluciones
      -- y 'Sin respuesta' NO cuentan (otro outcome / solo intento).
      COUNT(*) FILTER (
        WHERE t.action ILIKE 'NOVEDAD: Resuelta%'
           OR t.action ILIKE 'NOVEDAD: Volver a ofrecer%'
      ) AS novedades_resueltas
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
    -- v5: novedades_resueltas ahora viene de tp_stats (touchpoints), no de base.
    COALESCE(t.novedades_resueltas,0)::bigint,
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
    -- COLUMNAS v4:
    COALESCE(b.intentos_noresp,0)::bigint,
    COALESCE(b.intentos_total,0)::bigint,
    -- pendientes_sin_tocar: entrantes globales menos atendidos del operador.
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

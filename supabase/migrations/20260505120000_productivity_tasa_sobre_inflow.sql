-- Cambia tasa_confirmacion para que el denominador sea el TOTAL DE PEDIDOS
-- QUE ENTRARON al período (inflow), NO solo lo que cada operadora gestionó.
--
-- Bug reportado por el usuario (2026-05-05): "el rendimiento de confirmación
-- no se tiene que medir por lo que la operadora gestione. Ejemplo: entraron
-- 100 y ella gestionó 50 — el % tiene que ser sobre 100, no sobre 50."
--
-- Razonamiento: la fórmula vieja (confirmados / (conf+canc+noresp)) sólo
-- penalizaba malas conversiones, pero NO penalizaba dejar pedidos sin
-- gestionar. Operadora que sólo toca 50 de 100 y los confirma todos quedaba
-- con 100% de tasa, igual que una que gestiona los 100. La nueva fórmula
-- (confirmados / total_entrantes) refleja productividad real: cuántos del
-- inflow del período terminó confirmando esta operadora.
--
-- Inflow = pedidos creados en el período que pasaron (o están) por el flujo
-- de confirmación. Excluye pedidos sincronizados desde Dropi en estados ya
-- avanzados (ej. ENTREGADO directo) que nunca entraron a la cola.
--
-- Cambios:
--   1. Nueva columna `total_entrantes bigint` en el RETURNS — global, mismo
--      valor para todas las filas. UI lo lee de rows[0] para mostrar la N.
--   2. tasa_confirmacion ahora usa total_entrantes como denominador.
--   3. tasa_contacto NO cambia — sigue midiendo efectividad de contacto sobre
--      lo gestionado (cuando llamó, ¿logró hablar con el cliente?).

DROP FUNCTION IF EXISTS public.operator_productivity_stats(text);

CREATE OR REPLACE FUNCTION public.operator_productivity_stats(p_range text DEFAULT 'today')
RETURNS TABLE (
  operator_id uuid,
  display_name text,
  confirmados bigint,
  cancelados bigint,
  noresp bigint,
  novedades_resueltas bigint,
  seg_acciones bigint,
  seg_resueltos bigint,
  rescate_acciones bigint,
  rescate_resueltos bigint,
  total_atendidos bigint,
  total_entrantes bigint,
  tasa_contacto numeric,
  tasa_confirmacion numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_since timestamptz;
  v_total_entrantes bigint;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores pueden ver estas métricas';
  END IF;

  v_since := CASE p_range
    WHEN 'today' THEN (((NOW() AT TIME ZONE 'America/Bogota')::date)::timestamp AT TIME ZONE 'America/Bogota')
    WHEN '7d'    THEN NOW() - INTERVAL '7 days'
    WHEN '30d'   THEN NOW() - INTERVAL '30 days'
    ELSE NOW() - INTERVAL '24 hours'
  END;

  -- Inflow global del período: pedidos creados en el rango que entraron al
  -- flujo de confirmación. Un pedido cuenta si está PENDIENTE CONFIRMACION
  -- o si tiene al menos un order_result de módulo 'confirmar' (gestionado
  -- por alguna operadora). Esto excluye pedidos sincronizados desde Dropi
  -- en estados avanzados (ENTREGADO, etc.) que nunca pasaron por la cola.
  SELECT COUNT(DISTINCT o.id) INTO v_total_entrantes
  FROM public.orders o
  WHERE o.created_at >= v_since
    AND (
      o.estado = 'PENDIENTE CONFIRMACION'
      OR EXISTS (
        SELECT 1
        FROM public.order_results r
        WHERE r.order_id = o.id
          AND r.module = 'confirmar'
      )
    );

  RETURN QUERY
  WITH base AS (
    SELECT
      r.operator_id,
      COUNT(*) FILTER (WHERE r.module = 'confirmar' AND r.result = 'conf')   AS confirmados,
      COUNT(*) FILTER (WHERE r.module = 'confirmar' AND r.result = 'canc')   AS cancelados,
      COUNT(*) FILTER (WHERE r.module = 'confirmar' AND r.result = 'noresp') AS noresp,
      COUNT(*) FILTER (WHERE r.module = 'novedades' AND r.result = 'conf')   AS novedades_resueltas,
      COUNT(DISTINCT r.order_id) FILTER (WHERE r.module = 'confirmar')       AS total_atendidos
    FROM public.order_results r
    WHERE r.created_at >= v_since
    GROUP BY r.operator_id
  ),
  tp_stats AS (
    SELECT
      t.operator_id,
      COUNT(*) FILTER (WHERE t.action LIKE 'SEG:%')    AS seg_acciones,
      COUNT(*) FILTER (WHERE
        t.action = 'SEG: Resuelto'
        OR t.action = 'SEG: Devolucion solicitada'
        OR t.action = 'SEG: Solicite devolucion'
      ) AS seg_resueltos,
      COUNT(*) FILTER (WHERE t.action LIKE 'RESCUE:%') AS rescate_acciones,
      COUNT(*) FILTER (WHERE
        t.action = 'RESCUE: Resuelto'
        OR t.action = 'RESCUE: Devolucion solicitada'
        OR t.action = 'RESCUE: Solicite devolucion'
      ) AS rescate_resueltos
    FROM public.touchpoints t
    WHERE t.created_at >= v_since
    GROUP BY t.operator_id
  ),
  all_ops AS (
    SELECT operator_id FROM base
    UNION
    SELECT operator_id FROM tp_stats
  )
  SELECT
    ao.operator_id,
    COALESCE(p.display_name, 'Operador') AS display_name,
    COALESCE(b.confirmados, 0)::bigint        AS confirmados,
    COALESCE(b.cancelados, 0)::bigint         AS cancelados,
    COALESCE(b.noresp, 0)::bigint             AS noresp,
    COALESCE(b.novedades_resueltas, 0)::bigint AS novedades_resueltas,
    COALESCE(t.seg_acciones, 0)::bigint        AS seg_acciones,
    COALESCE(t.seg_resueltos, 0)::bigint       AS seg_resueltos,
    COALESCE(t.rescate_acciones, 0)::bigint    AS rescate_acciones,
    COALESCE(t.rescate_resueltos, 0)::bigint   AS rescate_resueltos,
    COALESCE(b.total_atendidos, 0)::bigint     AS total_atendidos,
    v_total_entrantes                          AS total_entrantes,
    -- tasa_contacto: SIN cambio. Mide efectividad de contacto sobre lo
    -- gestionado por la operadora — cuando llamó, ¿logró hablar con el
    -- cliente? (vs. no contestó). Es una métrica de calidad de llamada,
    -- no de productividad — denominador correcto sigue siendo gestionados.
    CASE WHEN COALESCE(b.confirmados + b.cancelados + b.noresp, 0) = 0 THEN 0
         ELSE ROUND(((COALESCE(b.confirmados, 0) + COALESCE(b.cancelados, 0))::numeric
                     / (b.confirmados + b.cancelados + b.noresp)::numeric) * 100, 1)
    END AS tasa_contacto,
    -- tasa_confirmacion: nueva fórmula. Confirmados sobre TOTAL ENTRANTES
    -- al período (inflow global), no sobre lo gestionado. Si entraron 100 y
    -- la operadora confirmó 40, su rendimiento es 40% — independiente de
    -- cuántos tocó. Esto refleja productividad real (incluye penalización
    -- por dejar pedidos sin gestionar).
    CASE WHEN v_total_entrantes = 0 THEN 0
         ELSE ROUND((COALESCE(b.confirmados, 0)::numeric
                     / v_total_entrantes::numeric) * 100, 1)
    END AS tasa_confirmacion
  FROM all_ops ao
  LEFT JOIN base b      ON b.operator_id = ao.operator_id
  LEFT JOIN tp_stats t  ON t.operator_id = ao.operator_id
  LEFT JOIN public.profiles p ON p.user_id = ao.operator_id
  ORDER BY (COALESCE(b.confirmados, 0) + COALESCE(t.seg_acciones, 0) + COALESCE(t.rescate_acciones, 0)) DESC, display_name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.operator_productivity_stats(text) TO authenticated;

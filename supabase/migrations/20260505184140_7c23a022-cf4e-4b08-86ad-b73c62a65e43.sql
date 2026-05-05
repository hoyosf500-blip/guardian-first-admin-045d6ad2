-- Fix doble-conteo: noresp y tasa_contacto ahora deduplican por order_id
-- para no penalizar a la operadora por reintentos legítimos del flujo de
-- cooldown 2h. Reportado por Mayra 2026-05-05.

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

  SELECT COUNT(DISTINCT o.id) INTO v_total_entrantes
  FROM public.orders o
  WHERE o.created_at >= v_since
    AND (
      o.estado = 'PENDIENTE CONFIRMACION'
      OR EXISTS (
        SELECT 1 FROM public.order_results r
        WHERE r.order_id = o.id AND r.module = 'confirmar'
      )
    );

  RETURN QUERY
  WITH base AS (
    SELECT
      r.operator_id AS op_id,
      COUNT(DISTINCT r.order_id) FILTER (WHERE r.module = 'confirmar' AND r.result = 'conf') AS confirmados,
      COUNT(DISTINCT r.order_id) FILTER (WHERE r.module = 'confirmar' AND r.result = 'canc') AS cancelados,
      COUNT(DISTINCT r.order_id) FILTER (
        WHERE r.module = 'confirmar'
          AND r.result = 'noresp'
          AND NOT EXISTS (
            SELECT 1 FROM public.order_results r2
            WHERE r2.order_id = r.order_id
              AND r2.module = 'confirmar'
              AND r2.result IN ('conf','canc')
              AND r2.created_at >= v_since
          )
      ) AS noresp,
      COUNT(*) FILTER (WHERE r.module = 'novedades' AND r.result = 'conf') AS novedades_resueltas,
      COUNT(DISTINCT r.order_id) FILTER (WHERE r.module = 'confirmar') AS total_atendidos
    FROM public.order_results r
    WHERE r.created_at >= v_since
    GROUP BY r.operator_id
  ),
  tp_stats AS (
    SELECT
      t.operator_id AS op_id,
      COUNT(*) FILTER (WHERE t.action LIKE 'SEG:%') AS seg_acciones,
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
    SELECT op_id FROM base
    UNION
    SELECT op_id FROM tp_stats
  )
  SELECT
    ao.op_id AS operator_id,
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
    CASE WHEN COALESCE(b.total_atendidos, 0) = 0 THEN 0
         ELSE ROUND(((COALESCE(b.confirmados, 0) + COALESCE(b.cancelados, 0))::numeric
                     / b.total_atendidos::numeric) * 100, 1)
    END AS tasa_contacto,
    CASE WHEN v_total_entrantes = 0 THEN 0
         ELSE ROUND((COALESCE(b.confirmados, 0)::numeric
                     / v_total_entrantes::numeric) * 100, 1)
    END AS tasa_confirmacion
  FROM all_ops ao
  LEFT JOIN base b      ON b.op_id = ao.op_id
  LEFT JOIN tp_stats t  ON t.op_id = ao.op_id
  LEFT JOIN public.profiles p ON p.user_id = ao.op_id
  ORDER BY (COALESCE(b.confirmados, 0) + COALESCE(t.seg_acciones, 0) + COALESCE(t.rescate_acciones, 0)) DESC, display_name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.operator_productivity_stats(text) TO authenticated;
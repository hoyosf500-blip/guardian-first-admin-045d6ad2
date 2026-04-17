CREATE OR REPLACE FUNCTION public.operator_productivity_stats(p_range text DEFAULT '24h')
RETURNS TABLE (
  operator_id uuid,
  display_name text,
  confirmados bigint,
  cancelados bigint,
  novedades_resueltas bigint,
  total_asignados bigint,
  tasa_contacto numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_since timestamptz;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores pueden ver estas métricas';
  END IF;

  v_since := CASE p_range
    WHEN '7d'  THEN NOW() - INTERVAL '7 days'
    WHEN '30d' THEN NOW() - INTERVAL '30 days'
    ELSE NOW() - INTERVAL '24 hours'
  END;

  RETURN QUERY
  WITH results AS (
    SELECT
      r.operator_id,
      COUNT(*) FILTER (WHERE r.module = 'confirmar' AND r.result = 'conf') AS confirmados,
      COUNT(*) FILTER (WHERE r.module = 'confirmar' AND r.result = 'canc') AS cancelados,
      COUNT(*) FILTER (WHERE r.module = 'novedades' AND r.result = 'conf') AS novedades_resueltas,
      COUNT(*) FILTER (WHERE r.module = 'confirmar' AND r.result IN ('conf','canc')) AS efectivos,
      COUNT(*) FILTER (WHERE r.module = 'confirmar') AS total_confirmar
    FROM public.order_results r
    WHERE r.created_at >= v_since
    GROUP BY r.operator_id
  ),
  asignados AS (
    SELECT o.assigned_to AS operator_id, COUNT(*) AS total
    FROM public.orders o
    WHERE o.assigned_to IS NOT NULL
      AND o.created_at >= v_since
    GROUP BY o.assigned_to
  )
  SELECT
    COALESCE(res.operator_id, a.operator_id) AS operator_id,
    COALESCE(p.display_name, 'Operador') AS display_name,
    COALESCE(res.confirmados, 0) AS confirmados,
    COALESCE(res.cancelados, 0) AS cancelados,
    COALESCE(res.novedades_resueltas, 0) AS novedades_resueltas,
    COALESCE(a.total, 0) AS total_asignados,
    CASE
      WHEN COALESCE(res.total_confirmar, 0) = 0 THEN 0
      ELSE ROUND((res.efectivos::numeric / res.total_confirmar::numeric) * 100, 1)
    END AS tasa_contacto
  FROM results res
  FULL OUTER JOIN asignados a ON a.operator_id = res.operator_id
  LEFT JOIN public.profiles p ON p.user_id = COALESCE(res.operator_id, a.operator_id)
  WHERE COALESCE(res.operator_id, a.operator_id) IS NOT NULL
  ORDER BY confirmados DESC, display_name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.operator_productivity_stats(text) TO authenticated;
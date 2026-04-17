-- A) Per-operator today's rate (Colombia timezone)
CREATE OR REPLACE FUNCTION public.operator_today_tasa()
RETURNS TABLE (
  confirmados bigint,
  cancelados bigint,
  noresp bigint,
  total bigint,
  tasa_confirmacion numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_today DATE := (NOW() AT TIME ZONE 'America/Bogota')::date;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT
      COUNT(*) FILTER (WHERE r.result = 'conf')   AS confirmados,
      COUNT(*) FILTER (WHERE r.result = 'canc')   AS cancelados,
      COUNT(*) FILTER (WHERE r.result = 'noresp') AS noresp
    FROM public.order_results r
    WHERE r.operator_id = v_uid
      AND r.module = 'confirmar'
      AND r.result_date = v_today
  )
  SELECT
    b.confirmados,
    b.cancelados,
    b.noresp,
    (b.confirmados + b.cancelados + b.noresp) AS total,
    CASE WHEN (b.confirmados + b.cancelados + b.noresp) = 0 THEN 0
         ELSE ROUND((b.confirmados::numeric / (b.confirmados + b.cancelados + b.noresp)::numeric) * 100, 1)
    END AS tasa_confirmacion
  FROM base b;
END;
$$;

GRANT EXECUTE ON FUNCTION public.operator_today_tasa() TO authenticated;

-- B) Add 'today' range support to operator_productivity_stats
DROP FUNCTION IF EXISTS public.operator_productivity_stats(text);

CREATE OR REPLACE FUNCTION public.operator_productivity_stats(p_range text DEFAULT 'today')
RETURNS TABLE (
  operator_id uuid,
  display_name text,
  confirmados bigint,
  cancelados bigint,
  noresp bigint,
  novedades_resueltas bigint,
  total_atendidos bigint,
  tasa_contacto numeric,
  tasa_confirmacion numeric
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
    WHEN 'today' THEN (((NOW() AT TIME ZONE 'America/Bogota')::date)::timestamp AT TIME ZONE 'America/Bogota')
    WHEN '7d'    THEN NOW() - INTERVAL '7 days'
    WHEN '30d'   THEN NOW() - INTERVAL '30 days'
    ELSE NOW() - INTERVAL '24 hours'
  END;

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
  )
  SELECT
    b.operator_id,
    COALESCE(p.display_name, 'Operador') AS display_name,
    b.confirmados, b.cancelados, b.noresp, b.novedades_resueltas,
    b.total_atendidos,
    CASE WHEN (b.confirmados + b.cancelados + b.noresp) = 0 THEN 0
         ELSE ROUND(((b.confirmados + b.cancelados)::numeric / (b.confirmados + b.cancelados + b.noresp)::numeric) * 100, 1)
    END AS tasa_contacto,
    CASE WHEN (b.confirmados + b.cancelados + b.noresp) = 0 THEN 0
         ELSE ROUND((b.confirmados::numeric / (b.confirmados + b.cancelados + b.noresp)::numeric) * 100, 1)
    END AS tasa_confirmacion
  FROM base b
  LEFT JOIN public.profiles p ON p.user_id = b.operator_id
  ORDER BY b.confirmados DESC, display_name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.operator_productivity_stats(text) TO authenticated;
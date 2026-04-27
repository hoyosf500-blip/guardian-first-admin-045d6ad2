-- RPC: get_daily_operator_stats
-- Returns aggregated results per operator for a given date.
-- Any authenticated user can call this — it only exposes totals (conf/canc/noresp),
-- never individual order_results rows, so it's safe without row-level filtering.

CREATE OR REPLACE FUNCTION public.get_daily_operator_stats(p_date DATE)
RETURNS TABLE (
  operator_id UUID,
  display_name TEXT,
  conf        BIGINT,
  canc        BIGINT,
  noresp      BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    r.operator_id,
    COALESCE(p.display_name, 'Operador') AS display_name,
    COUNT(*) FILTER (WHERE r.result = 'conf')   AS conf,
    COUNT(*) FILTER (WHERE r.result = 'canc')   AS canc,
    COUNT(*) FILTER (WHERE r.result = 'noresp') AS noresp
  FROM public.order_results r
  LEFT JOIN public.profiles p ON p.user_id = r.operator_id
  WHERE r.result_date = p_date
  GROUP BY r.operator_id, p.display_name;
$$;

-- Allow any authenticated user to call this function
GRANT EXECUTE ON FUNCTION public.get_daily_operator_stats(DATE) TO authenticated;

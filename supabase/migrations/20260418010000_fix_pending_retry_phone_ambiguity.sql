-- Fix: "column reference 'phone' is ambiguous" en pending_retry_list.
-- Causa: phone es OUT parameter de RETURNS TABLE y tambien columna en el CTE.
-- Solucion: renombrar la columna del CTE a ph y calificar explicitamente.

CREATE OR REPLACE FUNCTION public.pending_retry_list()
RETURNS TABLE (phone TEXT, nombre TEXT, external_id TEXT, attempts BIGINT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_today DATE := (NOW() AT TIME ZONE 'America/Bogota')::date;
BEGIN
  RETURN QUERY
  WITH today_calls AS (
    SELECT r.phone AS ph, r.result
    FROM public.order_results r
    WHERE r.operator_id = auth.uid()
      AND r.module = 'confirmar'
      AND r.result_date = v_today
  ), grouped AS (
    SELECT tc.ph,
      COUNT(*) FILTER (WHERE tc.result = 'noresp') AS nr
    FROM today_calls tc
    GROUP BY tc.ph
    HAVING COUNT(*) FILTER (WHERE tc.result = 'noresp') BETWEEN 1 AND 2
       AND COUNT(*) FILTER (WHERE tc.result IN ('conf','canc')) = 0
  )
  SELECT
    g.ph::text,
    COALESCE(o.nombre, 'Sin nombre')::text,
    COALESCE(o.external_id, '')::text,
    g.nr
  FROM grouped g
  LEFT JOIN LATERAL (
    SELECT o2.nombre, o2.external_id
    FROM public.orders o2
    WHERE o2.phone = g.ph
    ORDER BY o2.created_at DESC
    LIMIT 1
  ) o ON true;
END; $$;

GRANT EXECUTE ON FUNCTION public.pending_retry_list() TO authenticated;

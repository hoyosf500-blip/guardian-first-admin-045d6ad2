ALTER TABLE public.operator_daily_reports
  ADD COLUMN IF NOT EXISTS opening_new_orders INT,
  ADD COLUMN IF NOT EXISTS opening_guides_yesterday INT,
  ADD COLUMN IF NOT EXISTS opening_pending_yesterday INT;

DROP FUNCTION IF EXISTS public.submit_opening_report(TEXT);
DROP FUNCTION IF EXISTS public.submit_opening_report(INT,INT,INT,TEXT);

CREATE OR REPLACE FUNCTION public.submit_opening_report(
  p_new_orders INT,
  p_guides_yesterday INT,
  p_pending_yesterday INT,
  p_notes TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_today DATE := (NOW() AT TIME ZONE 'America/Bogota')::date;
BEGIN
  IF p_new_orders IS NULL OR p_new_orders < 0
     OR p_guides_yesterday IS NULL OR p_guides_yesterday < 0
     OR p_pending_yesterday IS NULL OR p_pending_yesterday < 0 THEN
    RAISE EXCEPTION 'Todos los campos numéricos son obligatorios y no negativos';
  END IF;

  INSERT INTO operator_daily_reports (
    user_id, report_date,
    opening_new_orders, opening_guides_yesterday, opening_pending_yesterday,
    opening_notes, opening_at
  ) VALUES (
    auth.uid(), v_today,
    p_new_orders, p_guides_yesterday, p_pending_yesterday,
    NULLIF(p_notes,''), NOW()
  )
  ON CONFLICT (user_id, report_date) DO UPDATE SET
    opening_new_orders = EXCLUDED.opening_new_orders,
    opening_guides_yesterday = EXCLUDED.opening_guides_yesterday,
    opening_pending_yesterday = EXCLUDED.opening_pending_yesterday,
    opening_notes = EXCLUDED.opening_notes,
    opening_at = COALESCE(operator_daily_reports.opening_at, EXCLUDED.opening_at);
END; $$;

GRANT EXECUTE ON FUNCTION public.submit_opening_report(INT,INT,INT,TEXT) TO authenticated;

DROP FUNCTION IF EXISTS public.admin_daily_reports(DATE);
CREATE OR REPLACE FUNCTION public.admin_daily_reports(p_date DATE)
RETURNS TABLE (
  user_id UUID, display_name TEXT,
  opening_at TIMESTAMPTZ, opening_notes TEXT,
  opening_new_orders INT, opening_guides_yesterday INT, opening_pending_yesterday INT,
  closing_at TIMESTAMPTZ, closing_notes TEXT,
  status TEXT,
  confirmados BIGINT, cancelados BIGINT, noresp BIGINT, tasa_confirmacion NUMERIC
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_role(auth.uid(),'admin') THEN RAISE EXCEPTION 'Solo admins'; END IF;
  RETURN QUERY
  WITH operators AS (
    SELECT ur.user_id, COALESCE(p.display_name,'Operador') AS display_name
    FROM user_roles ur LEFT JOIN profiles p ON p.user_id = ur.user_id
    WHERE ur.role='operator'
  ),
  calls AS (
    SELECT r.operator_id,
      COUNT(*) FILTER (WHERE r.module='confirmar' AND r.result='conf') AS confirmados,
      COUNT(*) FILTER (WHERE r.module='confirmar' AND r.result='canc') AS cancelados,
      COUNT(*) FILTER (WHERE r.module='confirmar' AND r.result='noresp') AS noresp
    FROM order_results r WHERE r.result_date = p_date GROUP BY r.operator_id
  )
  SELECT o.user_id, o.display_name,
    dr.opening_at, dr.opening_notes,
    dr.opening_new_orders, dr.opening_guides_yesterday, dr.opening_pending_yesterday,
    dr.closing_at, dr.closing_notes,
    CASE WHEN dr.closing_at IS NOT NULL THEN 'cerrado'
         WHEN dr.opening_at IS NOT NULL THEN 'abierto'
         ELSE 'sin_abrir' END,
    COALESCE(c.confirmados,0), COALESCE(c.cancelados,0), COALESCE(c.noresp,0),
    CASE WHEN COALESCE(c.confirmados+c.cancelados+c.noresp,0)=0 THEN 0
         ELSE ROUND((COALESCE(c.confirmados,0)::numeric/(c.confirmados+c.cancelados+c.noresp)::numeric)*100,1) END
  FROM operators o
  LEFT JOIN operator_daily_reports dr ON dr.user_id=o.user_id AND dr.report_date=p_date
  LEFT JOIN calls c ON c.operator_id=o.user_id
  ORDER BY dr.opening_at ASC NULLS LAST, o.display_name;
END; $$;
GRANT EXECUTE ON FUNCTION public.admin_daily_reports(DATE) TO authenticated;
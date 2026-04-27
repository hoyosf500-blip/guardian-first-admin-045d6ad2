ALTER TABLE public.operator_daily_reports
  ADD COLUMN IF NOT EXISTS closing_pending_tomorrow INT,
  ADD COLUMN IF NOT EXISTS closing_confirmados INT,
  ADD COLUMN IF NOT EXISTS closing_cancelados INT,
  ADD COLUMN IF NOT EXISTS closing_noresp INT;

CREATE OR REPLACE FUNCTION public.today_call_stats()
RETURNS TABLE (confirmados BIGINT, cancelados BIGINT, noresp BIGINT, total BIGINT, tasa_conf NUMERIC)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_today DATE := (NOW() AT TIME ZONE 'America/Bogota')::date;
BEGIN
  RETURN QUERY
  WITH s AS (
    SELECT
      COUNT(*) FILTER (WHERE result='conf')   AS c,
      COUNT(*) FILTER (WHERE result='canc')   AS x,
      COUNT(*) FILTER (WHERE result='noresp') AS n
    FROM order_results
    WHERE operator_id = auth.uid() AND module='confirmar' AND result_date = v_today
  )
  SELECT s.c, s.x, s.n, (s.c+s.x+s.n),
    CASE WHEN (s.c+s.x+s.n)=0 THEN 0
         ELSE ROUND((s.c::numeric/(s.c+s.x+s.n)::numeric)*100, 1) END
  FROM s;
END; $$;
GRANT EXECUTE ON FUNCTION public.today_call_stats() TO authenticated;

DROP FUNCTION IF EXISTS public.submit_closing_report(TEXT);
DROP FUNCTION IF EXISTS public.submit_closing_report(INT,TEXT);
CREATE OR REPLACE FUNCTION public.submit_closing_report(
  p_pending_tomorrow INT,
  p_notes TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today DATE := (NOW() AT TIME ZONE 'America/Bogota')::date;
  v_pending INT;
  v_already BOOLEAN;
  v_c INT; v_x INT; v_n INT;
BEGIN
  IF p_pending_tomorrow IS NULL OR p_pending_tomorrow < 0 THEN
    RAISE EXCEPTION 'Pendientes para mañana es obligatorio y no negativo';
  END IF;

  SELECT EXISTS(SELECT 1 FROM operator_daily_reports
    WHERE user_id=auth.uid() AND report_date=v_today AND closing_at IS NOT NULL) INTO v_already;
  IF v_already THEN RAISE EXCEPTION 'Ya cerraste el turno de hoy.'; END IF;

  SELECT COUNT(*) INTO v_pending FROM public.pending_retry_list();
  IF v_pending > 0 THEN
    RAISE EXCEPTION 'Tienes % cliente(s) con llamadas pendientes. Complétalas antes de cerrar.', v_pending;
  END IF;

  SELECT COUNT(*) FILTER (WHERE result='conf'),
         COUNT(*) FILTER (WHERE result='canc'),
         COUNT(*) FILTER (WHERE result='noresp')
    INTO v_c, v_x, v_n
  FROM order_results
  WHERE operator_id=auth.uid() AND module='confirmar' AND result_date=v_today;

  INSERT INTO operator_daily_reports (
    user_id, report_date,
    closing_notes, closing_at,
    closing_pending_tomorrow, closing_confirmados, closing_cancelados, closing_noresp
  ) VALUES (
    auth.uid(), v_today,
    NULLIF(p_notes,''), NOW(),
    p_pending_tomorrow, v_c, v_x, v_n
  )
  ON CONFLICT (user_id, report_date) DO UPDATE SET
    closing_notes = EXCLUDED.closing_notes,
    closing_at = NOW(),
    closing_pending_tomorrow = EXCLUDED.closing_pending_tomorrow,
    closing_confirmados = EXCLUDED.closing_confirmados,
    closing_cancelados = EXCLUDED.closing_cancelados,
    closing_noresp = EXCLUDED.closing_noresp;
END; $$;
GRANT EXECUTE ON FUNCTION public.submit_closing_report(INT,TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_daily_reports_range(p_from DATE, p_to DATE)
RETURNS TABLE (
  fecha DATE, tipo TEXT, operadora TEXT, hora TIMESTAMPTZ,
  pedidos_nuevos INT, guias_apertura INT, pendientes_ayer INT,
  confirmados INT, noresp INT, cancelados INT, total_gestionados INT,
  pct_confirmacion NUMERIC, pct_cancelados NUMERIC, pendientes_manana INT,
  notas TEXT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_role(auth.uid(),'admin') THEN RAISE EXCEPTION 'Solo admins'; END IF;
  RETURN QUERY
  SELECT dr.report_date, 'apertura'::text, COALESCE(p.display_name,'Operador'), dr.opening_at,
    dr.opening_new_orders, dr.opening_guides_yesterday, dr.opening_pending_yesterday,
    NULL::int, NULL::int, NULL::int, NULL::int,
    NULL::numeric, NULL::numeric, NULL::int, dr.opening_notes
  FROM operator_daily_reports dr
  LEFT JOIN profiles p ON p.user_id=dr.user_id
  WHERE dr.report_date BETWEEN p_from AND p_to AND dr.opening_at IS NOT NULL
  UNION ALL
  SELECT dr.report_date, 'cierre'::text, COALESCE(p.display_name,'Operador'), dr.closing_at,
    NULL::int, NULL::int, NULL::int,
    dr.closing_confirmados, dr.closing_noresp, dr.closing_cancelados,
    COALESCE(dr.closing_confirmados,0)+COALESCE(dr.closing_cancelados,0)+COALESCE(dr.closing_noresp,0),
    CASE WHEN COALESCE(dr.closing_confirmados+dr.closing_cancelados+dr.closing_noresp,0)=0 THEN 0
         ELSE ROUND((dr.closing_confirmados::numeric/(dr.closing_confirmados+dr.closing_cancelados+dr.closing_noresp)::numeric)*100,0) END,
    CASE WHEN COALESCE(dr.closing_confirmados+dr.closing_cancelados+dr.closing_noresp,0)=0 THEN 0
         ELSE ROUND((dr.closing_cancelados::numeric/(dr.closing_confirmados+dr.closing_cancelados+dr.closing_noresp)::numeric)*100,0) END,
    dr.closing_pending_tomorrow, dr.closing_notes
  FROM operator_daily_reports dr
  LEFT JOIN profiles p ON p.user_id=dr.user_id
  WHERE dr.report_date BETWEEN p_from AND p_to AND dr.closing_at IS NOT NULL
  ORDER BY 1 ASC, 3 ASC, 2 ASC;
END; $$;
GRANT EXECUTE ON FUNCTION public.admin_daily_reports_range(DATE,DATE) TO authenticated;
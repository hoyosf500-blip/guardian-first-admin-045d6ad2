DROP POLICY IF EXISTS "Operadora gestiona sus reportes" ON public.operator_daily_reports;

CREATE OR REPLACE FUNCTION public.submit_closing_report(p_notes TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today DATE := (NOW() AT TIME ZONE 'America/Bogota')::date;
  v_pending INT;
  v_already_closed BOOLEAN;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM operator_daily_reports
    WHERE user_id = auth.uid() AND report_date = v_today AND closing_at IS NOT NULL
  ) INTO v_already_closed;
  IF v_already_closed THEN
    RAISE EXCEPTION 'Ya cerraste el turno de hoy. No se puede cerrar dos veces.';
  END IF;

  SELECT COUNT(*) INTO v_pending FROM public.pending_retry_list();
  IF v_pending > 0 THEN
    RAISE EXCEPTION 'Tienes % cliente(s) con llamadas pendientes. Complétalas antes de cerrar.', v_pending;
  END IF;

  INSERT INTO operator_daily_reports (user_id, report_date, closing_notes, closing_at)
  VALUES (auth.uid(), v_today, NULLIF(p_notes,''), NOW())
  ON CONFLICT (user_id, report_date) DO UPDATE
    SET closing_notes = EXCLUDED.closing_notes, closing_at = NOW();
END; $$;
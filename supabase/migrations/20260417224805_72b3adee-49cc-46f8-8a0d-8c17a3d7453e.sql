CREATE TABLE public.operator_daily_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  report_date DATE NOT NULL,
  opening_notes TEXT,
  opening_at TIMESTAMPTZ,
  closing_notes TEXT,
  closing_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, report_date)
);

ALTER TABLE public.operator_daily_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Operadora ve sus reportes" ON public.operator_daily_reports
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Operadora gestiona sus reportes" ON public.operator_daily_reports
  FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.opening_report_status()
RETURNS TABLE (has_opening BOOLEAN, has_closing BOOLEAN)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_today DATE := (NOW() AT TIME ZONE 'America/Bogota')::date;
BEGIN
  RETURN QUERY
  SELECT
    EXISTS(SELECT 1 FROM operator_daily_reports WHERE user_id = auth.uid() AND report_date = v_today AND opening_at IS NOT NULL),
    EXISTS(SELECT 1 FROM operator_daily_reports WHERE user_id = auth.uid() AND report_date = v_today AND closing_at IS NOT NULL);
END; $$;
GRANT EXECUTE ON FUNCTION public.opening_report_status() TO authenticated;

CREATE OR REPLACE FUNCTION public.submit_opening_report(p_notes TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_today DATE := (NOW() AT TIME ZONE 'America/Bogota')::date;
BEGIN
  INSERT INTO operator_daily_reports (user_id, report_date, opening_notes, opening_at)
  VALUES (auth.uid(), v_today, NULLIF(p_notes,''), NOW())
  ON CONFLICT (user_id, report_date) DO UPDATE
    SET opening_notes = EXCLUDED.opening_notes,
        opening_at = COALESCE(operator_daily_reports.opening_at, EXCLUDED.opening_at);
END; $$;
GRANT EXECUTE ON FUNCTION public.submit_opening_report(TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.pending_retry_list()
RETURNS TABLE (phone TEXT, nombre TEXT, external_id TEXT, attempts BIGINT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_today DATE := (NOW() AT TIME ZONE 'America/Bogota')::date;
BEGIN
  RETURN QUERY
  WITH today_calls AS (
    SELECT r.phone, r.result FROM order_results r
    WHERE r.operator_id = auth.uid()
      AND r.module = 'confirmar' AND r.result_date = v_today
  ), grouped AS (
    SELECT phone,
      COUNT(*) FILTER (WHERE result = 'noresp') AS nr
    FROM today_calls GROUP BY phone
    HAVING COUNT(*) FILTER (WHERE result = 'noresp') BETWEEN 1 AND 2
       AND COUNT(*) FILTER (WHERE result IN ('conf','canc')) = 0
  )
  SELECT g.phone, COALESCE(o.nombre,'Sin nombre'), COALESCE(o.external_id,''), g.nr
  FROM grouped g
  LEFT JOIN LATERAL (
    SELECT nombre, external_id FROM orders
    WHERE orders.phone = g.phone ORDER BY created_at DESC LIMIT 1
  ) o ON true;
END; $$;
GRANT EXECUTE ON FUNCTION public.pending_retry_list() TO authenticated;

CREATE OR REPLACE FUNCTION public.submit_closing_report(p_notes TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today DATE := (NOW() AT TIME ZONE 'America/Bogota')::date;
  v_pending INT;
BEGIN
  SELECT COUNT(*) INTO v_pending FROM public.pending_retry_list();
  IF v_pending > 0 THEN
    RAISE EXCEPTION 'Tienes % cliente(s) con llamadas pendientes. Complétalas antes de cerrar.', v_pending;
  END IF;
  INSERT INTO operator_daily_reports (user_id, report_date, closing_notes, closing_at)
  VALUES (auth.uid(), v_today, NULLIF(p_notes,''), NOW())
  ON CONFLICT (user_id, report_date) DO UPDATE
    SET closing_notes = EXCLUDED.closing_notes, closing_at = NOW();
END; $$;
GRANT EXECUTE ON FUNCTION public.submit_closing_report(TEXT) TO authenticated;
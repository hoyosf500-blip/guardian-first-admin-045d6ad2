-- Closing report fully automatic: stats + pendientes mañana computed server-side.
-- Operator only submits optional notes.

CREATE OR REPLACE FUNCTION public.pending_tomorrow_count()
RETURNS INT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today DATE := (NOW() AT TIME ZONE 'America/Bogota')::date;
  v_count INT;
BEGIN
  WITH dedup AS (
    SELECT DISTINCT ON (COALESCE(NULLIF(o.external_id,''), o.phone || '|' || COALESCE(o.producto,'')))
      o.id
    FROM public.orders o
    WHERE UPPER(COALESCE(o.estado,'')) = 'PENDIENTE CONFIRMACION'
      AND o.phone IS NOT NULL AND o.phone <> ''
    ORDER BY COALESCE(NULLIF(o.external_id,''), o.phone || '|' || COALESCE(o.producto,'')), o.created_at DESC
  )
  SELECT COUNT(*) INTO v_count
  FROM dedup d
  WHERE NOT EXISTS (
    SELECT 1 FROM public.order_results r
    WHERE r.order_id = d.id
      AND r.module = 'confirmar'
      AND r.result IN ('conf','canc')
  )
  AND COALESCE((
    SELECT COUNT(*) FROM public.order_results r2
    WHERE r2.order_id = d.id
      AND r2.module = 'confirmar'
      AND r2.result = 'noresp'
      AND r2.result_date = v_today
  ), 0) < 3;
  RETURN COALESCE(v_count, 0);
END; $$;
GRANT EXECUTE ON FUNCTION public.pending_tomorrow_count() TO authenticated;

DROP FUNCTION IF EXISTS public.today_call_stats();
CREATE OR REPLACE FUNCTION public.today_call_stats()
RETURNS TABLE (
  confirmados BIGINT,
  cancelados BIGINT,
  noresp BIGINT,
  total BIGINT,
  tasa_conf NUMERIC,
  pending_tomorrow INT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_today DATE := (NOW() AT TIME ZONE 'America/Bogota')::date;
BEGIN
  RETURN QUERY
  WITH s AS (
    SELECT
      COUNT(*) FILTER (WHERE result='conf')   AS c,
      COUNT(*) FILTER (WHERE result='canc')   AS x,
      COUNT(*) FILTER (WHERE result='noresp') AS n
    FROM public.order_results
    WHERE operator_id = auth.uid()
      AND module = 'confirmar'
      AND result_date = v_today
  )
  SELECT
    s.c, s.x, s.n, (s.c+s.x+s.n),
    CASE WHEN (s.c+s.x+s.n)=0 THEN 0
         ELSE ROUND((s.c::numeric/(s.c+s.x+s.n)::numeric)*100, 1) END,
    public.pending_tomorrow_count()
  FROM s;
END; $$;
GRANT EXECUTE ON FUNCTION public.today_call_stats() TO authenticated;

DROP FUNCTION IF EXISTS public.submit_closing_report(INT, TEXT);
DROP FUNCTION IF EXISTS public.submit_closing_report(TEXT);
CREATE OR REPLACE FUNCTION public.submit_closing_report(p_notes TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today DATE := (NOW() AT TIME ZONE 'America/Bogota')::date;
  v_pending INT;
  v_already BOOLEAN;
  v_c INT; v_x INT; v_n INT;
  v_pending_tomorrow INT;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM public.operator_daily_reports
    WHERE user_id = auth.uid() AND report_date = v_today AND closing_at IS NOT NULL
  ) INTO v_already;
  IF v_already THEN
    RAISE EXCEPTION 'Ya cerraste el turno de hoy. No se puede cerrar dos veces.';
  END IF;

  SELECT COUNT(*) INTO v_pending FROM public.pending_retry_list();
  IF v_pending > 0 THEN
    RAISE EXCEPTION 'Tienes % cliente(s) con llamadas pendientes. Complétalas antes de cerrar.', v_pending;
  END IF;

  SELECT
    COUNT(*) FILTER (WHERE result='conf'),
    COUNT(*) FILTER (WHERE result='canc'),
    COUNT(*) FILTER (WHERE result='noresp')
  INTO v_c, v_x, v_n
  FROM public.order_results
  WHERE operator_id = auth.uid()
    AND module = 'confirmar'
    AND result_date = v_today;

  v_pending_tomorrow := public.pending_tomorrow_count();

  INSERT INTO public.operator_daily_reports (
    user_id, report_date,
    closing_notes, closing_at,
    closing_pending_tomorrow, closing_confirmados, closing_cancelados, closing_noresp
  ) VALUES (
    auth.uid(), v_today,
    NULLIF(p_notes, ''), NOW(),
    v_pending_tomorrow, v_c, v_x, v_n
  )
  ON CONFLICT (user_id, report_date) DO UPDATE SET
    closing_notes = EXCLUDED.closing_notes,
    closing_at = NOW(),
    closing_pending_tomorrow = EXCLUDED.closing_pending_tomorrow,
    closing_confirmados = EXCLUDED.closing_confirmados,
    closing_cancelados = EXCLUDED.closing_cancelados,
    closing_noresp = EXCLUDED.closing_noresp;
END; $$;
GRANT EXECUTE ON FUNCTION public.submit_closing_report(TEXT) TO authenticated;

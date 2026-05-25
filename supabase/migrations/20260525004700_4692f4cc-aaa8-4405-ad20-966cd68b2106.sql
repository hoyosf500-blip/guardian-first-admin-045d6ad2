CREATE OR REPLACE FUNCTION public.submit_opening_report(
  p_new_orders INT,
  p_guides_yesterday INT,
  p_pending_yesterday INT,
  p_notes TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today DATE := (NOW() AT TIME ZONE 'America/Bogota')::date;
  v_store uuid;
BEGIN
  IF p_new_orders IS NULL OR p_new_orders < 0
     OR p_guides_yesterday IS NULL OR p_guides_yesterday < 0
     OR p_pending_yesterday IS NULL OR p_pending_yesterday < 0 THEN
    RAISE EXCEPTION 'Todos los campos numéricos son obligatorios y no negativos';
  END IF;

  SELECT sm.store_id INTO v_store
  FROM public.store_members sm
  WHERE sm.user_id = auth.uid()
  ORDER BY (sm.store_id = (SELECT active_store_id FROM public.profiles WHERE user_id = auth.uid())) DESC NULLS LAST,
           (sm.role = 'operator') DESC
  LIMIT 1;

  INSERT INTO operator_daily_reports (
    user_id, store_id, report_date,
    opening_new_orders, opening_guides_yesterday, opening_pending_yesterday,
    opening_notes, opening_at
  ) VALUES (
    auth.uid(), v_store, v_today,
    p_new_orders, p_guides_yesterday, p_pending_yesterday,
    NULLIF(p_notes,''), NOW()
  )
  ON CONFLICT (user_id, report_date) DO UPDATE SET
    store_id = COALESCE(EXCLUDED.store_id, operator_daily_reports.store_id),
    opening_new_orders = EXCLUDED.opening_new_orders,
    opening_guides_yesterday = EXCLUDED.opening_guides_yesterday,
    opening_pending_yesterday = EXCLUDED.opening_pending_yesterday,
    opening_notes = EXCLUDED.opening_notes,
    opening_at = COALESCE(operator_daily_reports.opening_at, EXCLUDED.opening_at);
END; $$;

GRANT EXECUTE ON FUNCTION public.submit_opening_report(INT,INT,INT,TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.submit_closing_report(p_notes TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today DATE := (NOW() AT TIME ZONE 'America/Bogota')::date;
  v_pending INT;
  v_already BOOLEAN;
  v_c INT; v_x INT; v_n INT;
  v_pending_tomorrow INT;
  v_store uuid;
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
    COUNT(DISTINCT r.order_id) FILTER (
      WHERE r.module = 'confirmar' AND r.result = 'conf'
    ),
    COUNT(DISTINCT r.order_id) FILTER (
      WHERE r.module = 'confirmar' AND r.result = 'canc'
    ),
    COUNT(DISTINCT r.order_id) FILTER (
      WHERE r.module = 'confirmar'
        AND r.result = 'noresp'
        AND NOT EXISTS (
          SELECT 1 FROM public.order_results r2
          WHERE r2.order_id = r.order_id
            AND r2.module = 'confirmar'
            AND r2.result IN ('conf','canc')
            AND r2.result_date = v_today
        )
    )
  INTO v_c, v_x, v_n
  FROM public.order_results r
  WHERE r.operator_id = auth.uid()
    AND r.module = 'confirmar'
    AND r.result_date = v_today;

  v_pending_tomorrow := public.pending_tomorrow_count();

  SELECT sm.store_id INTO v_store
  FROM public.store_members sm
  WHERE sm.user_id = auth.uid()
  ORDER BY (sm.store_id = (SELECT active_store_id FROM public.profiles WHERE user_id = auth.uid())) DESC NULLS LAST,
           (sm.role = 'operator') DESC
  LIMIT 1;

  INSERT INTO public.operator_daily_reports (
    user_id, store_id, report_date,
    closing_notes, closing_at,
    closing_pending_tomorrow, closing_confirmados, closing_cancelados, closing_noresp
  ) VALUES (
    auth.uid(), v_store, v_today,
    NULLIF(p_notes, ''), NOW(),
    v_pending_tomorrow, v_c, v_x, v_n
  )
  ON CONFLICT (user_id, report_date) DO UPDATE SET
    store_id = COALESCE(EXCLUDED.store_id, operator_daily_reports.store_id),
    closing_notes = EXCLUDED.closing_notes,
    closing_at = NOW(),
    closing_pending_tomorrow = EXCLUDED.closing_pending_tomorrow,
    closing_confirmados = EXCLUDED.closing_confirmados,
    closing_cancelados = EXCLUDED.closing_cancelados,
    closing_noresp = EXCLUDED.closing_noresp;
END; $$;

GRANT EXECUTE ON FUNCTION public.submit_closing_report(TEXT) TO authenticated;

DO $$
DECLARE v_updated INT;
BEGIN
  UPDATE public.operator_daily_reports dr
  SET store_id = sm.store_id
  FROM public.store_members sm
  WHERE sm.user_id = dr.user_id
    AND sm.role = 'operator'
    AND dr.store_id IS DISTINCT FROM sm.store_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RAISE NOTICE 'Backfill store_id operator_daily_reports: % filas re-tagueadas', v_updated;
END;
$$;

ALTER TABLE public.operator_daily_reports ALTER COLUMN store_id DROP DEFAULT;
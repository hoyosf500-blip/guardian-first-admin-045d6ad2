
CREATE OR REPLACE FUNCTION public.submit_closing_report(
  p_notes TEXT DEFAULT NULL,
  p_force BOOLEAN DEFAULT FALSE
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today DATE := (NOW() AT TIME ZONE 'America/Bogota')::date;
  v_pending INT;
  v_already BOOLEAN;
  v_c INT; v_x INT; v_n INT;
  v_pending_tomorrow INT;
  v_notes TEXT;
  v_store_id UUID;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM public.operator_daily_reports
    WHERE user_id = auth.uid() AND report_date = v_today AND closing_at IS NOT NULL
  ) INTO v_already;
  IF v_already THEN
    RAISE EXCEPTION 'Ya cerraste el turno de hoy. No se puede cerrar dos veces.';
  END IF;

  SELECT COUNT(*) INTO v_pending FROM public.pending_retry_list();
  IF v_pending > 0 AND NOT p_force THEN
    RAISE EXCEPTION 'Tienes % cliente(s) con llamadas pendientes. Complétalas antes de cerrar.', v_pending;
  END IF;

  SELECT
    COUNT(DISTINCT r.order_id) FILTER (WHERE r.module='confirmar' AND r.result='conf'),
    COUNT(DISTINCT r.order_id) FILTER (WHERE r.module='confirmar' AND r.result='canc'),
    COUNT(DISTINCT r.order_id) FILTER (
      WHERE r.module='confirmar' AND r.result='noresp'
        AND NOT EXISTS (
          SELECT 1 FROM public.order_results r2
          WHERE r2.order_id = r.order_id AND r2.module='confirmar'
            AND r2.result IN ('conf','canc') AND r2.result_date = v_today
        )
    )
  INTO v_c, v_x, v_n
  FROM public.order_results r
  WHERE r.operator_id = auth.uid() AND r.module='confirmar' AND r.result_date = v_today;

  BEGIN
    v_pending_tomorrow := public.pending_tomorrow_count();
  EXCEPTION WHEN OTHERS THEN
    v_pending_tomorrow := 0;
  END;

  v_notes := NULLIF(p_notes, '');
  IF p_force AND v_pending > 0 THEN
    v_notes := COALESCE(v_notes || E'\n', '') || '[CIERRE FORZADO con ' || v_pending || ' pendiente(s)]';
  END IF;

  -- Resolver store_id: primero la fila existente (apertura), si no la membresía activa
  SELECT store_id INTO v_store_id
  FROM public.operator_daily_reports
  WHERE user_id = auth.uid() AND report_date = v_today
  LIMIT 1;

  IF v_store_id IS NULL THEN
    SELECT sm.store_id INTO v_store_id
    FROM public.store_members sm
    WHERE sm.user_id = auth.uid()
    ORDER BY CASE sm.role WHEN 'owner' THEN 0 WHEN 'supervisor' THEN 1 ELSE 2 END,
             sm.created_at ASC
    LIMIT 1;
  END IF;

  IF v_store_id IS NULL THEN
    RAISE EXCEPTION 'No se pudo resolver la tienda activa para cerrar el turno.';
  END IF;

  INSERT INTO public.operator_daily_reports (
    user_id, report_date, store_id, closing_notes, closing_at,
    closing_pending_tomorrow, closing_confirmados, closing_cancelados, closing_noresp
  ) VALUES (
    auth.uid(), v_today, v_store_id, v_notes, NOW(),
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

GRANT EXECUTE ON FUNCTION public.submit_closing_report(TEXT, BOOLEAN) TO authenticated;

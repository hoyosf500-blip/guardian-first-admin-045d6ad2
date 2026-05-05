-- Fix doble-conteo en el flujo de CIERRE DE TURNO. Las RPCs
-- `today_call_stats` y `submit_closing_report` (definidas en
-- 20260418000000_auto_closing_report.sql) usan COUNT(*) crudo sobre
-- order_results, lo que infla el contador de noresp por los reintentos
-- legítimos del cooldown 2h. Reportado por Mayra 2026-05-05: el modal
-- "Cerrar turno" mostraba noresp=19 cuando el dedupado real era ~3,
-- y la pestaña /admin → Reportes diarios guardaba esos valores
-- inflados en operator_daily_reports.closing_noresp.
--
-- Cambios:
--   1. today_call_stats() ahora dedupea conf/canc/noresp por order_id
--      y excluye pedidos noresp que terminaron conf/canc el mismo día
--      (mismo criterio que operator_productivity_stats v20260505184140
--      y la pure fn computeDailyCounter del cliente).
--   2. submit_closing_report() escribe los valores DEDUPADOS en
--      operator_daily_reports.
--   3. Backfill: UPDATE in-place de filas históricas con closing_at
--      para que /admin → Reportes diarios muestre números coherentes.
--
-- NO se cambia: tasa_conf en today_call_stats sigue siendo
-- confirmados/total (métrica de calidad de llamada que ve la operadora
-- al cerrar turno, no productividad sobre inflow). El header del
-- panel admin sí usa total_entrantes pero ese vive en otra RPC.

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
DECLARE
  v_today DATE := (NOW() AT TIME ZONE 'America/Bogota')::date;
BEGIN
  RETURN QUERY
  WITH s AS (
    SELECT
      -- conf y canc: dedup por order_id. Aunque rara vez se duplican
      -- (porque al confirmar el pedido sale de PENDIENTE), aplicamos
      -- DISTINCT por consistencia con la RPC de productividad.
      COUNT(DISTINCT r.order_id) FILTER (
        WHERE r.module = 'confirmar' AND r.result = 'conf'
      ) AS c,
      COUNT(DISTINCT r.order_id) FILTER (
        WHERE r.module = 'confirmar' AND r.result = 'canc'
      ) AS x,
      -- noresp: dedup por order_id Y excluir pedidos que terminaron
      -- en conf/canc el mismo día (esos NO son "no contestó", son
      -- "no contestó al inicio pero finalmente sí logró").
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
      ) AS n
    FROM public.order_results r
    WHERE r.operator_id = auth.uid()
      AND r.module = 'confirmar'
      AND r.result_date = v_today
  )
  SELECT
    s.c, s.x, s.n, (s.c + s.x + s.n),
    CASE WHEN (s.c + s.x + s.n) = 0 THEN 0
         ELSE ROUND((s.c::numeric / (s.c + s.x + s.n)::numeric) * 100, 1) END,
    public.pending_tomorrow_count()
  FROM s;
END; $$;

GRANT EXECUTE ON FUNCTION public.today_call_stats() TO authenticated;

-- ──────────────────────────────────────────────────────────────────
-- submit_closing_report: misma dedup antes del INSERT.
-- ──────────────────────────────────────────────────────────────────

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

  -- DEDUP: mismo criterio que today_call_stats. Antes del fix esto
  -- era COUNT(*) crudo y guardaba valores inflados en
  -- operator_daily_reports.closing_noresp.
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

-- ──────────────────────────────────────────────────────────────────
-- Backfill: recomputar filas históricas con cierre ya enviado.
-- Solo toca rows con closing_at IS NOT NULL — los borradores quedan
-- intactos. Hace tres UPDATEs separados en lugar de uno gigante para
-- que cada uno sea legible y se pueda diagnosticar si falla.
-- ──────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_updated INT;
BEGIN
  UPDATE public.operator_daily_reports r
  SET closing_confirmados = (
    SELECT COUNT(DISTINCT order_id)
    FROM public.order_results
    WHERE operator_id = r.user_id
      AND module = 'confirmar'
      AND result = 'conf'
      AND result_date = r.report_date
  )
  WHERE r.closing_at IS NOT NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RAISE NOTICE 'Backfill closing_confirmados: % filas', v_updated;

  UPDATE public.operator_daily_reports r
  SET closing_cancelados = (
    SELECT COUNT(DISTINCT order_id)
    FROM public.order_results
    WHERE operator_id = r.user_id
      AND module = 'confirmar'
      AND result = 'canc'
      AND result_date = r.report_date
  )
  WHERE r.closing_at IS NOT NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RAISE NOTICE 'Backfill closing_cancelados: % filas', v_updated;

  UPDATE public.operator_daily_reports r
  SET closing_noresp = (
    SELECT COUNT(DISTINCT or1.order_id)
    FROM public.order_results or1
    WHERE or1.operator_id = r.user_id
      AND or1.module = 'confirmar'
      AND or1.result = 'noresp'
      AND or1.result_date = r.report_date
      AND NOT EXISTS (
        SELECT 1 FROM public.order_results or2
        WHERE or2.order_id = or1.order_id
          AND or2.module = 'confirmar'
          AND or2.result IN ('conf','canc')
          AND or2.result_date = r.report_date
      )
  )
  WHERE r.closing_at IS NOT NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RAISE NOTICE 'Backfill closing_noresp: % filas', v_updated;
END;
$$;

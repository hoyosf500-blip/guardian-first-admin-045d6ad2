-- Reconciliar las métricas de la operadora entre Confirmar (banner), Cierre y
-- Productividad. Bug 2026-07-08: la misma operadora el mismo día veía "no
-- respondió" distinto según la pantalla (18 / 11 / 16) y "total" distinto.
--
-- ROOT CAUSE: el fix de dedup viejo (20260505200000) arregló el cierre y
-- productividad para contar pedidos DISTINTOS, pero NUNCA tocó operator_today_tasa
-- (el banner de Confirmar), que quedó con COUNT(*) CRUDO → cada reintento del
-- cooldown de 2h volvía a sumar al noresp (18 inflado).
--
-- DECISIÓN DEL DUEÑO (2026-07-08):
--  1) "No respondió" = ESFUERZO = clientes DISTINTOS que no contestaron hoy,
--     aunque después se cerraran = COUNT(DISTINCT order_id) FILTER noresp (=intentos).
--     Se unifica en banner + cierre + productividad (que ya lo tenía como intentos_noresp).
--  2) "gestionados" = pedidos DISTINTOS trabajados con resultado de llamada =
--     COUNT(DISTINCT order_id) FILTER (result IN conf/canc/noresp). Es el "total"
--     honesto (unión distinta, sin doble-contar el solape noresp→conf). Se usa como
--     denominador de la % contacto en el cierre, por eso NO puede ser la suma cruda.
--
-- NO se tocan operator_productivity_stats (ya devuelve intentos_noresp y sus tasas
-- dependen de total_atendidos — riesgo de drift) — solo se re-etiqueta en el cliente.

-- ── Columna para congelar "gestionados" (distinct) en el cierre ──────────────
ALTER TABLE public.operator_daily_reports
  ADD COLUMN IF NOT EXISTS closing_gestionados INT;

-- ── A) operator_today_tasa (banner "Hoy: X conf · Y canc · Z noresp" de Confirmar)
--     Antes: COUNT(*) crudo. Ahora: DISTINCT + noresp=intentos. Scope operator_id
--     solamente (igual que today_call_stats, para que banner ≡ cierre).
CREATE OR REPLACE FUNCTION public.operator_today_tasa()
RETURNS TABLE (
  confirmados bigint,
  cancelados bigint,
  noresp bigint,
  total bigint,
  tasa_confirmacion numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_today DATE := (NOW() AT TIME ZONE 'America/Bogota')::date;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT
      COUNT(DISTINCT r.order_id) FILTER (WHERE r.result = 'conf')   AS confirmados,
      COUNT(DISTINCT r.order_id) FILTER (WHERE r.result = 'canc')   AS cancelados,
      -- ESFUERZO: clientes distintos que no contestaron hoy (aunque después cerraran)
      COUNT(DISTINCT r.order_id) FILTER (WHERE r.result = 'noresp') AS noresp,
      -- gestionados = pedidos distintos con resultado de llamada (unión distinta)
      COUNT(DISTINCT r.order_id) FILTER (WHERE r.result IN ('conf','canc','noresp')) AS gestionados
    FROM public.order_results r
    WHERE r.operator_id = v_uid
      AND r.module = 'confirmar'
      AND r.result_date = v_today
  )
  SELECT
    b.confirmados,
    b.cancelados,
    b.noresp,
    b.gestionados AS total,
    CASE WHEN (b.confirmados + b.cancelados) = 0 THEN 0
         ELSE ROUND((b.confirmados::numeric / (b.confirmados + b.cancelados)::numeric) * 100, 1)
    END AS tasa_confirmacion
  FROM base b;
END;
$$;

GRANT EXECUTE ON FUNCTION public.operator_today_tasa() TO authenticated;

-- ── B) today_call_stats (modal de Cerrar turno) ──────────────────────────────
--     noresp: de "abiertos" (con NOT EXISTS) → intentos (distinct). total: de la
--     suma cruda → gestionados distinct (para que la % contacto no se infle).
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
      COUNT(DISTINCT r.order_id) FILTER (
        WHERE r.module = 'confirmar' AND r.result = 'conf'
      ) AS c,
      COUNT(DISTINCT r.order_id) FILTER (
        WHERE r.module = 'confirmar' AND r.result = 'canc'
      ) AS x,
      -- ESFUERZO (decisión dueño 2026-07-08): clientes distintos que no contestaron
      -- hoy, aunque después se cerraran. Alineado con el banner de Confirmar y con
      -- operator_productivity_stats.intentos_noresp. (Antes: solo los "abiertos".)
      COUNT(DISTINCT r.order_id) FILTER (
        WHERE r.module = 'confirmar' AND r.result = 'noresp'
      ) AS n,
      -- gestionados = pedidos distintos con resultado de llamada (unión distinta).
      -- Es el "total" honesto y el denominador de la % contacto.
      COUNT(DISTINCT r.order_id) FILTER (
        WHERE r.module = 'confirmar' AND r.result IN ('conf','canc','noresp')
      ) AS g
    FROM public.order_results r
    WHERE r.operator_id = auth.uid()
      AND r.module = 'confirmar'
      AND r.result_date = v_today
  )
  SELECT
    s.c, s.x, s.n, s.g,
    CASE WHEN (s.c + s.x) = 0 THEN 0
         ELSE ROUND((s.c::numeric / (s.c + s.x)::numeric) * 100, 1) END,
    public.pending_tomorrow_count()
  FROM s;
END; $$;

GRANT EXECUTE ON FUNCTION public.today_call_stats() TO authenticated;

-- ── C) submit_closing_report — congela noresp=intentos y gestionados=distinct ─
--     (idéntica a 20260527032030 salvo el bloque de conteo + closing_gestionados)
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
  v_c INT; v_x INT; v_n INT; v_g INT;
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

  -- conteo dedupado (decisión dueño 2026-07-08): noresp = intentos (distinct),
  -- gestionados = distinct con resultado de llamada.
  SELECT
    COUNT(DISTINCT r.order_id) FILTER (WHERE r.module='confirmar' AND r.result='conf'),
    COUNT(DISTINCT r.order_id) FILTER (WHERE r.module='confirmar' AND r.result='canc'),
    COUNT(DISTINCT r.order_id) FILTER (WHERE r.module='confirmar' AND r.result='noresp'),
    COUNT(DISTINCT r.order_id) FILTER (WHERE r.module='confirmar' AND r.result IN ('conf','canc','noresp'))
  INTO v_c, v_x, v_n, v_g
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
    closing_pending_tomorrow, closing_confirmados, closing_cancelados, closing_noresp, closing_gestionados
  ) VALUES (
    auth.uid(), v_today, v_store_id, v_notes, NOW(),
    v_pending_tomorrow, v_c, v_x, v_n, v_g
  )
  ON CONFLICT (user_id, report_date) DO UPDATE SET
    closing_notes = EXCLUDED.closing_notes,
    closing_at = NOW(),
    closing_pending_tomorrow = EXCLUDED.closing_pending_tomorrow,
    closing_confirmados = EXCLUDED.closing_confirmados,
    closing_cancelados = EXCLUDED.closing_cancelados,
    closing_noresp = EXCLUDED.closing_noresp,
    closing_gestionados = EXCLUDED.closing_gestionados;
END; $$;

GRANT EXECUTE ON FUNCTION public.submit_closing_report(TEXT, BOOLEAN) TO authenticated;

-- ── D) admin_operator_shifts_range — mostrar gestionados distinct en el total ─
--     Idéntica a 20260626225713 salvo el total_gestionados de la fila 'cierre':
--     ahora usa closing_gestionados (con fallback a la suma para filas viejas sin
--     backfill). El resto (apertura, scope null-store, orden) intacto.
CREATE OR REPLACE FUNCTION public.admin_operator_shifts_range(p_from date, p_to date)
 RETURNS TABLE(fecha date, tipo text, operadora text, hora timestamp with time zone, pedidos_nuevos integer, guias_apertura integer, pendientes_ayer integer, confirmados integer, noresp integer, cancelados integer, total_gestionados integer, pendientes_manana integer, notas text)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT
    dr.report_date, 'apertura'::text, COALESCE(p.display_name,'Operador'),
    dr.opening_at, dr.opening_new_orders, dr.opening_guides_yesterday, dr.opening_pending_yesterday,
    NULL::int, NULL::int, NULL::int, NULL::int, NULL::int, dr.opening_notes
  FROM public.operator_daily_reports dr
  LEFT JOIN public.profiles p ON p.user_id = dr.user_id
  WHERE dr.report_date BETWEEN p_from AND p_to
    AND dr.opening_at IS NOT NULL
    AND (v_store IS NULL OR dr.store_id = v_store)
  UNION ALL
  SELECT
    dr.report_date, 'cierre'::text, COALESCE(p.display_name,'Operador'),
    dr.closing_at, NULL::int, NULL::int, NULL::int,
    dr.closing_confirmados, dr.closing_noresp, dr.closing_cancelados,
    COALESCE(dr.closing_gestionados,
             COALESCE(dr.closing_confirmados,0)+COALESCE(dr.closing_cancelados,0)+COALESCE(dr.closing_noresp,0)),
    dr.closing_pending_tomorrow, dr.closing_notes
  FROM public.operator_daily_reports dr
  LEFT JOIN public.profiles p ON p.user_id = dr.user_id
  WHERE dr.report_date BETWEEN p_from AND p_to
    AND dr.closing_at IS NOT NULL
    AND (v_store IS NULL OR dr.store_id = v_store)
  ORDER BY 1 DESC, 3 ASC, 2 ASC;
END;
$function$;

-- ── E) Backfill: recomputar cierres YA existentes con la definición nueva ─────
--     closing_noresp → intentos (distinct), closing_gestionados → distinct con
--     resultado de llamada. conf/canc ya estaban dedupados, no se tocan.
UPDATE public.operator_daily_reports odr
SET closing_noresp = sub.intentos,
    closing_gestionados = sub.gestionados
FROM (
  SELECT r.operator_id, r.result_date,
    COUNT(DISTINCT r.order_id) FILTER (WHERE r.result='noresp') AS intentos,
    COUNT(DISTINCT r.order_id) FILTER (WHERE r.result IN ('conf','canc','noresp')) AS gestionados
  FROM public.order_results r
  WHERE r.module='confirmar'
  GROUP BY r.operator_id, r.result_date
) sub
WHERE odr.user_id = sub.operator_id
  AND odr.report_date = sub.result_date
  AND odr.closing_at IS NOT NULL;

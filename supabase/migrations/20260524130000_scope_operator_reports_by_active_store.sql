-- Reportes de operadoras por TIENDA ACTIVA (CO ≠ EC).
--
-- Problema: las RPCs de reportes resuelven el alcance con
-- `_resolve_scope_store()` (migration 20260521233349), que para un ADMIN GLOBAL
-- devuelve NULL = sin filtro = TODAS las tiendas combinadas. Fabian es admin
-- global, así que estando en Ecuador veía operadoras de Colombia mezcladas.
--
-- Fix: un resolver PARAMETRIZADO que honra la tienda que el cliente está
-- mirando (`p_store_id`). El cliente pasa `activeStoreId`. Las 4 RPCs de
-- operadoras ganan `p_store_id uuid DEFAULT NULL` y lo usan. Además, las dos que
-- LISTAN operadoras (productividad + ranking) muestran solo miembros con rol
-- 'operator' de esa tienda (el dueño/admin no aparece como "operadora").
--
-- Autorización idéntica al resolver no-arg: admin (cualquier tienda) u
-- owner/supervisor de ESA tienda. Operadoras siguen sin acceso a estos reportes.
--
-- Logística / Billetera quedan como están (mismo patrón, fuera de alcance).

-- ============================================================
-- Resolver parametrizado (el overload no-arg queda intacto)
-- ============================================================
CREATE OR REPLACE FUNCTION public._resolve_scope_store(p_store_id uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF p_store_id IS NOT NULL THEN
    -- admin ve cualquier tienda; manager debe ser owner/supervisor de ESA tienda
    IF public.has_role(auth.uid(), 'admin')
       OR EXISTS (
         SELECT 1 FROM public.store_members m
         WHERE m.user_id = auth.uid()
           AND m.store_id = p_store_id
           AND m.role IN ('owner','supervisor')
       ) THEN
      RETURN p_store_id;
    END IF;
    RAISE EXCEPTION 'No autorizado' USING ERRCODE = '42501';
  END IF;
  -- Sin tienda activa: comportamiento previo (admin = NULL/global, manager = su tienda).
  RETURN public._resolve_scope_store();
END;
$$;

-- ============================================================
-- get_daily_operator_stats — ranking del Dashboard (+ filtro rol operadora)
-- ============================================================
DROP FUNCTION IF EXISTS public.get_daily_operator_stats(date);
CREATE OR REPLACE FUNCTION public.get_daily_operator_stats(p_date date, p_store_id uuid DEFAULT NULL)
 RETURNS TABLE(operator_id uuid, display_name text, conf bigint, canc bigint, noresp bigint)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store(p_store_id);
  RETURN QUERY
  SELECT
    r.operator_id,
    COALESCE(p.display_name,'Operador'),
    COUNT(*) FILTER (WHERE r.result='conf'),
    COUNT(*) FILTER (WHERE r.result='canc'),
    COUNT(*) FILTER (WHERE r.result='noresp')
  FROM public.order_results r
  LEFT JOIN public.profiles p ON p.user_id = r.operator_id
  WHERE r.result_date = p_date
    AND (v_store IS NULL OR r.store_id = v_store)
    AND (v_store IS NULL OR EXISTS (
      SELECT 1 FROM public.store_members sm
      WHERE sm.user_id = r.operator_id AND sm.store_id = v_store AND sm.role = 'operator'
    ))
  GROUP BY r.operator_id, p.display_name;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.get_daily_operator_stats(date, uuid) TO authenticated;

-- ============================================================
-- admin_daily_reports_range — vista cohort por día (solo scope por tienda)
-- ============================================================
DROP FUNCTION IF EXISTS public.admin_daily_reports_range(date, date);
CREATE OR REPLACE FUNCTION public.admin_daily_reports_range(p_from date, p_to date, p_store_id uuid DEFAULT NULL)
 RETURNS TABLE(fecha date, entrantes integer, confirmados integer, cancelados integer, noresp integer, pendientes integer, pct_confirmacion numeric, pct_cancelados numeric)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store(p_store_id);
  RETURN QUERY
  WITH days AS (
    SELECT (p_from + (n || ' day')::interval)::date AS fecha
    FROM generate_series(0, (p_to - p_from)::int) AS n
  ),
  inflow_cohort AS (
    SELECT (o.created_at AT TIME ZONE 'America/Bogota')::date AS fecha, o.id
    FROM public.orders o
    WHERE (o.created_at AT TIME ZONE 'America/Bogota')::date BETWEEN p_from AND p_to
      AND (v_store IS NULL OR o.store_id = v_store)
      AND (
        o.estado = 'PENDIENTE CONFIRMACION'
        OR EXISTS (
          SELECT 1 FROM public.order_results r
          WHERE r.order_id = o.id AND r.module = 'confirmar'
            AND (v_store IS NULL OR r.store_id = v_store)
        )
      )
  ),
  final_status AS (
    SELECT ic.fecha, ic.id AS order_id,
      CASE
        WHEN EXISTS (SELECT 1 FROM public.order_results r WHERE r.order_id = ic.id AND r.module='confirmar' AND r.result='conf' AND (v_store IS NULL OR r.store_id = v_store)) THEN 'conf'
        WHEN EXISTS (SELECT 1 FROM public.order_results r WHERE r.order_id = ic.id AND r.module='confirmar' AND r.result='canc' AND (v_store IS NULL OR r.store_id = v_store)) THEN 'canc'
        WHEN EXISTS (SELECT 1 FROM public.order_results r WHERE r.order_id = ic.id AND r.module='confirmar' AND r.result='noresp' AND (v_store IS NULL OR r.store_id = v_store)) THEN 'noresp'
        ELSE 'pendiente'
      END AS estado_final
    FROM inflow_cohort ic
  )
  SELECT
    d.fecha,
    COALESCE(COUNT(fs.order_id),0)::int,
    COALESCE(COUNT(fs.order_id) FILTER (WHERE fs.estado_final='conf'),0)::int,
    COALESCE(COUNT(fs.order_id) FILTER (WHERE fs.estado_final='canc'),0)::int,
    COALESCE(COUNT(fs.order_id) FILTER (WHERE fs.estado_final='noresp'),0)::int,
    COALESCE(COUNT(fs.order_id) FILTER (WHERE fs.estado_final='pendiente'),0)::int,
    CASE WHEN COUNT(fs.order_id)=0 THEN 0
         ELSE ROUND(COUNT(fs.order_id) FILTER (WHERE fs.estado_final='conf')::numeric/COUNT(fs.order_id)::numeric*100,0) END,
    CASE WHEN COUNT(fs.order_id)=0 THEN 0
         ELSE ROUND(COUNT(fs.order_id) FILTER (WHERE fs.estado_final='canc')::numeric/COUNT(fs.order_id)::numeric*100,0) END
  FROM days d
  LEFT JOIN final_status fs ON fs.fecha = d.fecha
  GROUP BY d.fecha
  ORDER BY d.fecha DESC;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.admin_daily_reports_range(date, date, uuid) TO authenticated;

-- ============================================================
-- admin_operator_shifts_range — apertura/cierre (solo scope por tienda)
-- ============================================================
DROP FUNCTION IF EXISTS public.admin_operator_shifts_range(date, date);
CREATE OR REPLACE FUNCTION public.admin_operator_shifts_range(p_from date, p_to date, p_store_id uuid DEFAULT NULL)
 RETURNS TABLE(fecha date, tipo text, operadora text, hora timestamp with time zone, pedidos_nuevos integer, guias_apertura integer, pendientes_ayer integer, confirmados integer, noresp integer, cancelados integer, total_gestionados integer, pendientes_manana integer, notas text)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store(p_store_id);
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
    COALESCE(dr.closing_confirmados,0)+COALESCE(dr.closing_cancelados,0)+COALESCE(dr.closing_noresp,0),
    dr.closing_pending_tomorrow, dr.closing_notes
  FROM public.operator_daily_reports dr
  LEFT JOIN public.profiles p ON p.user_id = dr.user_id
  WHERE dr.report_date BETWEEN p_from AND p_to
    AND dr.closing_at IS NOT NULL
    AND (v_store IS NULL OR dr.store_id = v_store)
  ORDER BY 1 DESC, 3 ASC, 2 ASC;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.admin_operator_shifts_range(date, date, uuid) TO authenticated;

-- ============================================================
-- operator_productivity_stats — "Por operadora" (+ filtro rol operadora)
-- ============================================================
DROP FUNCTION IF EXISTS public.operator_productivity_stats(text);
CREATE OR REPLACE FUNCTION public.operator_productivity_stats(p_range text DEFAULT 'today'::text, p_store_id uuid DEFAULT NULL)
 RETURNS TABLE(operator_id uuid, display_name text, confirmados bigint, cancelados bigint, noresp bigint, novedades_resueltas bigint, seg_acciones bigint, seg_resueltos bigint, rescate_acciones bigint, rescate_resueltos bigint, total_atendidos bigint, total_entrantes bigint, tasa_contacto numeric, tasa_confirmacion numeric)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_since timestamptz;
  v_total_entrantes bigint;
  v_store uuid;
BEGIN
  v_store := public._resolve_scope_store(p_store_id);

  v_since := CASE p_range
    WHEN 'today' THEN (((NOW() AT TIME ZONE 'America/Bogota')::date)::timestamp AT TIME ZONE 'America/Bogota')
    WHEN '7d'    THEN NOW() - INTERVAL '7 days'
    WHEN '30d'   THEN NOW() - INTERVAL '30 days'
    ELSE NOW() - INTERVAL '24 hours'
  END;

  SELECT COUNT(DISTINCT o.id) INTO v_total_entrantes
  FROM public.orders o
  WHERE o.created_at >= v_since
    AND (v_store IS NULL OR o.store_id = v_store)
    AND (
      o.estado = 'PENDIENTE CONFIRMACION'
      OR EXISTS (
        SELECT 1 FROM public.order_results r
        WHERE r.order_id = o.id AND r.module='confirmar'
          AND (v_store IS NULL OR r.store_id = v_store)
      )
    );

  RETURN QUERY
  WITH base AS (
    SELECT
      r.operator_id AS op_id,
      COUNT(DISTINCT r.order_id) FILTER (WHERE r.module='confirmar' AND r.result='conf') AS confirmados,
      COUNT(DISTINCT r.order_id) FILTER (WHERE r.module='confirmar' AND r.result='canc') AS cancelados,
      COUNT(DISTINCT r.order_id) FILTER (
        WHERE r.module='confirmar' AND r.result='noresp'
          AND NOT EXISTS (
            SELECT 1 FROM public.order_results r2
            WHERE r2.order_id = r.order_id AND r2.module='confirmar'
              AND r2.result IN ('conf','canc') AND r2.created_at >= v_since
              AND (v_store IS NULL OR r2.store_id = v_store)
          )
      ) AS noresp,
      COUNT(*) FILTER (WHERE r.module='novedades' AND r.result='conf') AS novedades_resueltas,
      COUNT(DISTINCT r.order_id) FILTER (WHERE r.module='confirmar') AS total_atendidos
    FROM public.order_results r
    WHERE r.created_at >= v_since
      AND (v_store IS NULL OR r.store_id = v_store)
    GROUP BY r.operator_id
  ),
  tp_stats AS (
    SELECT
      t.operator_id AS op_id,
      COUNT(*) FILTER (WHERE t.action LIKE 'SEG:%') AS seg_acciones,
      COUNT(*) FILTER (WHERE t.action IN ('SEG: Resuelto','SEG: Devolucion solicitada','SEG: Solicite devolucion')) AS seg_resueltos,
      COUNT(*) FILTER (WHERE t.action LIKE 'RESCUE:%') AS rescate_acciones,
      COUNT(*) FILTER (WHERE t.action IN ('RESCUE: Resuelto','RESCUE: Devolucion solicitada','RESCUE: Solicite devolucion')) AS rescate_resueltos
    FROM public.touchpoints t
    WHERE t.created_at >= v_since
      AND (v_store IS NULL OR t.store_id = v_store)
    GROUP BY t.operator_id
  ),
  all_ops AS (
    SELECT op_id FROM base
    UNION
    SELECT op_id FROM tp_stats
  )
  SELECT
    ao.op_id,
    COALESCE(p.display_name,'Operador'),
    COALESCE(b.confirmados,0)::bigint,
    COALESCE(b.cancelados,0)::bigint,
    COALESCE(b.noresp,0)::bigint,
    COALESCE(b.novedades_resueltas,0)::bigint,
    COALESCE(t.seg_acciones,0)::bigint,
    COALESCE(t.seg_resueltos,0)::bigint,
    COALESCE(t.rescate_acciones,0)::bigint,
    COALESCE(t.rescate_resueltos,0)::bigint,
    COALESCE(b.total_atendidos,0)::bigint,
    v_total_entrantes,
    CASE WHEN COALESCE(b.total_atendidos,0)=0 THEN 0
         ELSE ROUND(((COALESCE(b.confirmados,0)+COALESCE(b.cancelados,0))::numeric/b.total_atendidos::numeric)*100,1) END,
    CASE WHEN v_total_entrantes=0 THEN 0
         ELSE ROUND((COALESCE(b.confirmados,0)::numeric/v_total_entrantes::numeric)*100,1) END
  FROM all_ops ao
  LEFT JOIN base b ON b.op_id = ao.op_id
  LEFT JOIN tp_stats t ON t.op_id = ao.op_id
  LEFT JOIN public.profiles p ON p.user_id = ao.op_id
  WHERE (v_store IS NULL OR EXISTS (
    SELECT 1 FROM public.store_members sm
    WHERE sm.user_id = ao.op_id AND sm.store_id = v_store AND sm.role = 'operator'
  ))
  ORDER BY (COALESCE(b.confirmados,0)+COALESCE(t.seg_acciones,0)+COALESCE(t.rescate_acciones,0)) DESC, 2;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.operator_productivity_stats(text, uuid) TO authenticated;

-- Multi-tenant guard: si _resolve_scope_store() devuelve NULL (admin sin tienda activa),
-- estas RPCs ahora retornan vacío en vez de agregar TODAS las tiendas (mezclando CO+EC).

CREATE OR REPLACE FUNCTION public.operator_productivity_stats(p_range text DEFAULT 'today'::text)
 RETURNS TABLE(operator_id uuid, display_name text, confirmados bigint, cancelados bigint, noresp bigint, novedades_resueltas bigint, seg_acciones bigint, seg_resueltos bigint, rescate_acciones bigint, rescate_resueltos bigint, total_atendidos bigint, total_entrantes bigint, tasa_contacto numeric, tasa_confirmacion numeric, seg_pedidos bigint, seg_resueltos_dist bigint, rescate_pedidos bigint, rescate_resueltos_dist bigint, intentos_noresp bigint, intentos_total bigint, pendientes_sin_tocar bigint)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_since timestamptz;
  v_total_entrantes bigint;
  v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;

  v_since := CASE p_range
    WHEN 'today' THEN (((NOW() AT TIME ZONE 'America/Bogota')::date)::timestamp AT TIME ZONE 'America/Bogota')
    WHEN '7d'    THEN ((((NOW() AT TIME ZONE 'America/Bogota')::date) - 6)::timestamp AT TIME ZONE 'America/Bogota')
    WHEN '30d'   THEN ((((NOW() AT TIME ZONE 'America/Bogota')::date) - 29)::timestamp AT TIME ZONE 'America/Bogota')
    ELSE (((NOW() AT TIME ZONE 'America/Bogota')::date)::timestamp AT TIME ZONE 'America/Bogota')
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
      COUNT(DISTINCT r.order_id) FILTER (WHERE r.module='confirmar') AS total_atendidos,
      COUNT(DISTINCT r.order_id) FILTER (WHERE r.module='confirmar' AND r.result='noresp') AS intentos_noresp,
      COUNT(*) FILTER (WHERE r.module='confirmar') AS intentos_total
    FROM public.order_results r
    WHERE r.created_at >= v_since
      AND (v_store IS NULL OR r.store_id = v_store)
    GROUP BY r.operator_id
  ),
  tp_stats AS (
    SELECT
      t.operator_id AS op_id,
      COUNT(*) FILTER (WHERE t.action LIKE 'SEG:%') AS seg_acciones,
      COUNT(*) FILTER (WHERE t.action IN ('SEG: Resuelto','SEG: Devolución','SEG: Devolucion solicitada','SEG: Solicite devolucion')) AS seg_resueltos,
      COUNT(DISTINCT t.phone) FILTER (WHERE t.action LIKE 'SEG:%') AS seg_pedidos,
      COUNT(DISTINCT t.phone) FILTER (WHERE t.action IN ('SEG: Resuelto','SEG: Devolución','SEG: Devolucion solicitada','SEG: Solicite devolucion')) AS seg_resueltos_dist,
      COUNT(*) FILTER (WHERE t.action LIKE 'RESCUE:%') AS rescate_acciones,
      COUNT(*) FILTER (WHERE t.action IN ('RESCUE: Resuelto','RESCUE: Devolución','RESCUE: Devolucion solicitada','RESCUE: Solicite devolucion')) AS rescate_resueltos,
      COUNT(DISTINCT t.phone) FILTER (WHERE t.action LIKE 'RESCUE:%') AS rescate_pedidos,
      COUNT(DISTINCT t.phone) FILTER (WHERE t.action IN ('RESCUE: Resuelto','RESCUE: Devolución','RESCUE: Devolucion solicitada','RESCUE: Solicite devolucion')) AS rescate_resueltos_dist,
      COUNT(*) FILTER (
        WHERE t.action ILIKE 'NOVEDAD: Resuelta%'
           OR t.action ILIKE 'NOVEDAD: Volver a ofrecer%'
      ) AS novedades_resueltas
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
    COALESCE(t.novedades_resueltas,0)::bigint,
    COALESCE(t.seg_acciones,0)::bigint,
    COALESCE(t.seg_resueltos,0)::bigint,
    COALESCE(t.rescate_acciones,0)::bigint,
    COALESCE(t.rescate_resueltos,0)::bigint,
    COALESCE(b.total_atendidos,0)::bigint,
    v_total_entrantes,
    CASE WHEN COALESCE(b.total_atendidos,0)=0 THEN 0
         ELSE ROUND(((COALESCE(b.confirmados,0)+COALESCE(b.cancelados,0))::numeric/b.total_atendidos::numeric)*100,1) END,
    CASE WHEN v_total_entrantes=0 THEN 0
         ELSE ROUND((COALESCE(b.confirmados,0)::numeric/v_total_entrantes::numeric)*100,1) END,
    COALESCE(t.seg_pedidos,0)::bigint,
    COALESCE(t.seg_resueltos_dist,0)::bigint,
    COALESCE(t.rescate_pedidos,0)::bigint,
    COALESCE(t.rescate_resueltos_dist,0)::bigint,
    COALESCE(b.intentos_noresp,0)::bigint,
    COALESCE(b.intentos_total,0)::bigint,
    GREATEST(v_total_entrantes - COALESCE(b.total_atendidos,0), 0)::bigint
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

CREATE OR REPLACE FUNCTION public.admin_daily_reports_range(p_from date, p_to date)
 RETURNS TABLE(fecha date, entrantes integer, confirmados integer, cancelados integer, noresp integer, pendientes integer, pct_confirmacion numeric, pct_cancelados numeric)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;
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

CREATE OR REPLACE FUNCTION public.admin_operator_actions_per_day(p_from date, p_to date)
 RETURNS TABLE(fecha date, operadora text, conf bigint, canc bigint, noresp bigint, atendidos bigint)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;
  RETURN QUERY
  WITH actions AS (
    SELECT (r.created_at AT TIME ZONE 'America/Bogota')::date AS fecha,
           r.operator_id, r.order_id, r.result
    FROM public.order_results r
    WHERE r.module = 'confirmar'
      AND (r.created_at AT TIME ZONE 'America/Bogota')::date BETWEEN p_from AND p_to
      AND (v_store IS NULL OR r.store_id = v_store)
      AND (v_store IS NULL OR EXISTS (
        SELECT 1 FROM public.store_members sm
        WHERE sm.user_id = r.operator_id AND sm.store_id = v_store AND sm.role = 'operator'))
  ),
  per_day_order AS (
    SELECT actions.fecha, actions.operator_id, actions.order_id,
      CASE WHEN BOOL_OR(actions.result = 'conf')   THEN 'conf'
           WHEN BOOL_OR(actions.result = 'canc')   THEN 'canc'
           WHEN BOOL_OR(actions.result = 'noresp') THEN 'noresp'
           ELSE 'otro' END AS final_result
    FROM actions
    GROUP BY actions.fecha, actions.operator_id, actions.order_id
  )
  SELECT pdo.fecha, COALESCE(p.display_name, 'Operador')::text,
    COUNT(*) FILTER (WHERE pdo.final_result = 'conf')::bigint,
    COUNT(*) FILTER (WHERE pdo.final_result = 'canc')::bigint,
    COUNT(*) FILTER (WHERE pdo.final_result = 'noresp')::bigint,
    COUNT(*)::bigint
  FROM per_day_order pdo
  LEFT JOIN public.profiles p ON p.user_id = pdo.operator_id
  GROUP BY pdo.fecha, p.display_name
  ORDER BY pdo.fecha DESC, p.display_name ASC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_daily_operator_stats(p_date date)
 RETURNS TABLE(operator_id uuid, display_name text, conf bigint, canc bigint, noresp bigint)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;
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

CREATE OR REPLACE FUNCTION public.logistics_summary(p_from_date date, p_to_date date)
 RETURNS TABLE(total_pedidos bigint, entregados bigint, devueltos bigint, en_transito bigint, tasa_entrega numeric, tasa_devolucion numeric, valor_entregado numeric, valor_perdido numeric)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;
  RETURN QUERY
  WITH base AS (
    SELECT estado, valor FROM public.orders o
    WHERE fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND fecha::date BETWEEN p_from_date AND p_to_date
      AND UPPER(COALESCE(estado, '')) NOT LIKE '%CANCEL%'
      AND (v_store IS NULL OR o.store_id = v_store)
  )
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE UPPER(estado) = 'ENTREGADO'),
    COUNT(*) FILTER (WHERE UPPER(estado) IN ('DEVOLUCION','DEVOLUCION EN TRANSITO','RECHAZADO')),
    COUNT(*) FILTER (WHERE UPPER(estado) IN
      ('EN TRANSPORTE','EN DESPACHO','EN TRASLADO NACIONAL','EN TERMINAL ORIGEN','EN TERMINAL DESTINO',
       'EN REPARTO','EN DISTRIBUCION','EN REEXPEDICION','TELEMERCADEO','REENVIO','REENVÍO',
       'EN BODEGA TRANSPORTADORA','ADMITIDA','EN BODEGA DROPI','RECOGIDO POR DROPI')),
    ROUND((COUNT(*) FILTER (WHERE UPPER(estado)='ENTREGADO'))::numeric*100.0/NULLIF(COUNT(*),0),2),
    ROUND((COUNT(*) FILTER (WHERE UPPER(estado) IN ('DEVOLUCION','DEVOLUCION EN TRANSITO','RECHAZADO')))::numeric*100.0/NULLIF(COUNT(*),0),2),
    COALESCE(SUM(valor) FILTER (WHERE UPPER(estado)='ENTREGADO'),0),
    COALESCE(SUM(valor) FILTER (WHERE UPPER(estado) IN ('DEVOLUCION','DEVOLUCION EN TRANSITO','RECHAZADO')),0)
  FROM base;
END;
$function$;

CREATE OR REPLACE FUNCTION public.logistics_summary(p_from_date date, p_to_date date, p_ciudad text DEFAULT NULL::text)
 RETURNS TABLE(total_pedidos bigint, entregados bigint, devueltos bigint, en_transito bigint, tasa_entrega numeric, tasa_devolucion numeric, valor_entregado numeric, valor_perdido numeric, valor_en_transito numeric, pendientes_sin_despachar bigint, pendientes_por_confirmar bigint, valor_pendientes numeric, cancelados bigint, valor_cancelado numeric, novedades bigint, valor_novedades numeric)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;
  RETURN QUERY
  WITH all_orders AS (
    SELECT estado, valor FROM public.orders o
    WHERE fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND fecha::date BETWEEN p_from_date AND p_to_date
      AND (p_ciudad IS NULL OR ciudad = p_ciudad)
      AND (v_store IS NULL OR o.store_id = v_store)
  )
  SELECT
    COUNT(*) FILTER (WHERE UPPER(estado) <> 'CANCELADO'),
    COUNT(*) FILTER (WHERE UPPER(estado) = 'ENTREGADO'),
    COUNT(*) FILTER (WHERE UPPER(estado) IN ('DEVOLUCION','DEVOLUCION EN TRANSITO','RECHAZADO')),
    COUNT(*) FILTER (WHERE UPPER(estado) IN
      ('EN TRANSPORTE','EN DESPACHO','EN TRASLADO NACIONAL','EN TERMINAL ORIGEN','EN TERMINAL DESTINO',
       'EN REPARTO','EN DISTRIBUCION','EN REEXPEDICION','TELEMERCADEO','REENVIO','REENVÍO',
       'EN BODEGA TRANSPORTADORA','ADMITIDA','EN BODEGA DROPI','RECOGIDO POR DROPI',
       'DESPACHADA','EN BODEGA DESTINO','EN PUNTO DROOP')),
    ROUND((COUNT(*) FILTER (WHERE UPPER(estado)='ENTREGADO'))::numeric*100.0/NULLIF(COUNT(*) FILTER (WHERE UPPER(COALESCE(estado,'')) NOT LIKE '%CANCEL%'),0),2),
    ROUND((COUNT(*) FILTER (WHERE UPPER(estado) IN ('DEVOLUCION','DEVOLUCION EN TRANSITO','RECHAZADO')))::numeric*100.0/NULLIF(COUNT(*) FILTER (WHERE UPPER(COALESCE(estado,'')) NOT LIKE '%CANCEL%'),0),2),
    COALESCE(SUM(valor) FILTER (WHERE UPPER(estado)='ENTREGADO'),0),
    COALESCE(SUM(valor) FILTER (WHERE UPPER(estado) IN ('DEVOLUCION','DEVOLUCION EN TRANSITO','RECHAZADO')),0),
    COALESCE(SUM(valor) FILTER (WHERE UPPER(estado) IN
      ('EN TRANSPORTE','EN DESPACHO','EN TRASLADO NACIONAL','EN TERMINAL ORIGEN','EN TERMINAL DESTINO',
       'EN REPARTO','EN DISTRIBUCION','EN REEXPEDICION','TELEMERCADEO','REENVIO','REENVÍO',
       'EN BODEGA TRANSPORTADORA','ADMITIDA','EN BODEGA DROPI','RECOGIDO POR DROPI',
       'DESPACHADA','EN BODEGA DESTINO','EN PUNTO DROOP')),0),
    COUNT(*) FILTER (WHERE UPPER(estado)='PENDIENTE'),
    COUNT(*) FILTER (WHERE UPPER(estado)='PENDIENTE CONFIRMACION'),
    COALESCE(SUM(valor) FILTER (WHERE UPPER(estado) IN ('PENDIENTE','PENDIENTE CONFIRMACION')),0),
    COUNT(*) FILTER (WHERE UPPER(estado)='CANCELADO'),
    COALESCE(SUM(valor) FILTER (WHERE UPPER(estado)='CANCELADO'),0),
    COUNT(*) FILTER (WHERE UPPER(estado) IN ('NOVEDAD','INTENTO DE ENTREGA','NOVEDAD SOLUCIONADA','RECLAME EN OFICINA')),
    COALESCE(SUM(valor) FILTER (WHERE UPPER(estado) IN ('NOVEDAD','INTENTO DE ENTREGA','NOVEDAD SOLUCIONADA','RECLAME EN OFICINA')),0)
  FROM all_orders;
END;
$function$;

CREATE OR REPLACE FUNCTION public.logistics_by_carrier(p_from_date date, p_to_date date)
 RETURNS TABLE(transportadora text, total_pedidos bigint, entregados bigint, devueltos bigint, en_transito bigint, novedades bigint, tasa_entrega numeric, tasa_devolucion numeric, valor_entregado numeric, valor_perdido numeric, avg_dias_entrega numeric)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT
    o.transportadora::TEXT,
    COUNT(*),
    COUNT(*) FILTER (WHERE UPPER(o.estado)='ENTREGADO'),
    COUNT(*) FILTER (WHERE UPPER(o.estado) IN ('DEVOLUCION','DEVOLUCION EN TRANSITO','RECHAZADO')),
    COUNT(*) FILTER (WHERE UPPER(o.estado) IN
      ('EN TRANSPORTE','EN DESPACHO','EN TRASLADO NACIONAL','EN TERMINAL ORIGEN','EN TERMINAL DESTINO',
       'EN REPARTO','EN DISTRIBUCION','EN REEXPEDICION','TELEMERCADEO','REENVIO','REENVÍO')),
    COUNT(*) FILTER (WHERE UPPER(o.estado) IN ('NOVEDAD','INTENTO DE ENTREGA')),
    ROUND((COUNT(*) FILTER (WHERE UPPER(o.estado)='ENTREGADO'))::numeric*100.0/NULLIF(COUNT(*),0),2),
    ROUND((COUNT(*) FILTER (WHERE UPPER(o.estado) IN ('DEVOLUCION','DEVOLUCION EN TRANSITO','RECHAZADO')))::numeric*100.0/NULLIF(COUNT(*),0),2),
    COALESCE(SUM(o.valor) FILTER (WHERE UPPER(o.estado)='ENTREGADO'),0),
    COALESCE(SUM(o.valor) FILTER (WHERE UPPER(o.estado) IN ('DEVOLUCION','DEVOLUCION EN TRANSITO','RECHAZADO')),0),
    ROUND(AVG(o.dias_conf) FILTER (WHERE UPPER(o.estado)='ENTREGADO'),1)
  FROM public.orders o
  WHERE o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
    AND o.fecha::date BETWEEN p_from_date AND p_to_date
    AND o.transportadora IS NOT NULL AND o.transportadora <> ''
    AND UPPER(COALESCE(o.estado,'')) NOT LIKE '%CANCEL%'
    AND (v_store IS NULL OR o.store_id = v_store)
  GROUP BY o.transportadora
  ORDER BY 3 DESC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.logistics_by_carrier(p_from_date date, p_to_date date, p_ciudad text DEFAULT NULL::text)
 RETURNS TABLE(transportadora text, total_pedidos bigint, entregados bigint, devueltos bigint, en_transito bigint, novedades bigint, tasa_entrega numeric, tasa_devolucion numeric, valor_entregado numeric, valor_perdido numeric, avg_dias_entrega numeric)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT
    o.transportadora::TEXT,
    COUNT(*),
    COUNT(*) FILTER (WHERE UPPER(o.estado)='ENTREGADO'),
    COUNT(*) FILTER (WHERE UPPER(o.estado) IN ('DEVOLUCION','DEVOLUCION EN TRANSITO','RECHAZADO')),
    COUNT(*) FILTER (WHERE UPPER(o.estado) IN
      ('EN TRANSPORTE','EN DESPACHO','EN TRASLADO NACIONAL','EN TERMINAL ORIGEN','EN TERMINAL DESTINO',
       'EN REPARTO','EN DISTRIBUCION','EN REEXPEDICION','TELEMERCADEO','REENVIO','REENVÍO',
       'EN BODEGA TRANSPORTADORA','ADMITIDA','EN BODEGA DROPI','RECOGIDO POR DROPI',
       'DESPACHADA','EN BODEGA DESTINO','EN PUNTO DROOP')),
    COUNT(*) FILTER (WHERE UPPER(o.estado) IN ('NOVEDAD','INTENTO DE ENTREGA','RECLAME EN OFICINA')),
    ROUND((COUNT(*) FILTER (WHERE UPPER(o.estado)='ENTREGADO'))::numeric*100.0/NULLIF(COUNT(*),0),2),
    ROUND((COUNT(*) FILTER (WHERE UPPER(o.estado) IN ('DEVOLUCION','DEVOLUCION EN TRANSITO','RECHAZADO')))::numeric*100.0/NULLIF(COUNT(*),0),2),
    COALESCE(SUM(o.valor) FILTER (WHERE UPPER(o.estado)='ENTREGADO'),0),
    COALESCE(SUM(o.valor) FILTER (WHERE UPPER(o.estado) IN ('DEVOLUCION','DEVOLUCION EN TRANSITO','RECHAZADO')),0),
    ROUND(AVG(o.dias_conf) FILTER (WHERE UPPER(o.estado)='ENTREGADO'),1)
  FROM public.orders o
  WHERE o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
    AND o.fecha::date BETWEEN p_from_date AND p_to_date
    AND o.transportadora IS NOT NULL AND o.transportadora <> ''
    AND UPPER(COALESCE(o.estado,'')) NOT LIKE '%CANCEL%'
    AND UPPER(COALESCE(o.estado,'')) NOT IN
      ('PENDIENTE','PENDIENTE CONFIRMACION','EN PROCESAMIENTO','PREPARADO PARA TRANSPORTADORA',
       'CONFIRMADO','GENERADO','GUIA GENERADA','ALISTAMIENTO')
    AND (p_ciudad IS NULL OR o.ciudad = p_ciudad)
    AND (v_store IS NULL OR o.store_id = v_store)
  GROUP BY o.transportadora
  ORDER BY 3 DESC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.logistics_by_city(p_from_date date, p_to_date date, p_limit integer DEFAULT 50)
 RETURNS TABLE(ciudad text, departamento text, total_pedidos bigint, entregados bigint, devueltos bigint, tasa_devolucion numeric, tasa_entrega numeric, valor_perdido numeric)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT
    o.ciudad::TEXT,
    COALESCE(o.departamento,'')::TEXT,
    COUNT(*),
    COUNT(*) FILTER (WHERE UPPER(o.estado)='ENTREGADO'),
    COUNT(*) FILTER (WHERE UPPER(o.estado) IN ('DEVOLUCION','DEVOLUCION EN TRANSITO','RECHAZADO')),
    ROUND((COUNT(*) FILTER (WHERE UPPER(o.estado) IN ('DEVOLUCION','DEVOLUCION EN TRANSITO','RECHAZADO')))::numeric*100.0/NULLIF(COUNT(*),0),2),
    ROUND((COUNT(*) FILTER (WHERE UPPER(o.estado)='ENTREGADO'))::numeric*100.0/NULLIF(COUNT(*),0),2),
    COALESCE(SUM(o.valor) FILTER (WHERE UPPER(o.estado) IN ('DEVOLUCION','DEVOLUCION EN TRANSITO','RECHAZADO')),0)
  FROM public.orders o
  WHERE o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
    AND o.fecha::date BETWEEN p_from_date AND p_to_date
    AND o.ciudad IS NOT NULL AND o.ciudad <> ''
    AND UPPER(COALESCE(o.estado,'')) NOT LIKE '%CANCEL%'
    AND (v_store IS NULL OR o.store_id = v_store)
  GROUP BY o.ciudad, COALESCE(o.departamento,'')
  ORDER BY 6 DESC, 3 DESC
  LIMIT p_limit;
END;
$function$;

CREATE OR REPLACE FUNCTION public.logistics_by_product(p_from_date date, p_to_date date, p_limit integer DEFAULT 50)
 RETURNS TABLE(producto text, total_pedidos bigint, entregados bigint, devueltos bigint, tasa_entrega numeric, tasa_devolucion numeric, valor_entregado numeric, valor_perdido numeric)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT
    o.producto::TEXT,
    COUNT(*),
    COUNT(*) FILTER (WHERE UPPER(o.estado)='ENTREGADO'),
    COUNT(*) FILTER (WHERE UPPER(o.estado) IN ('DEVOLUCION','DEVOLUCION EN TRANSITO','RECHAZADO')),
    ROUND((COUNT(*) FILTER (WHERE UPPER(o.estado)='ENTREGADO'))::numeric*100.0/NULLIF(COUNT(*),0),2),
    ROUND((COUNT(*) FILTER (WHERE UPPER(o.estado) IN ('DEVOLUCION','DEVOLUCION EN TRANSITO','RECHAZADO')))::numeric*100.0/NULLIF(COUNT(*),0),2),
    COALESCE(SUM(o.valor) FILTER (WHERE UPPER(o.estado)='ENTREGADO'),0),
    COALESCE(SUM(o.valor) FILTER (WHERE UPPER(o.estado) IN ('DEVOLUCION','DEVOLUCION EN TRANSITO','RECHAZADO')),0)
  FROM public.orders o
  WHERE o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
    AND o.fecha::date BETWEEN p_from_date AND p_to_date
    AND o.producto IS NOT NULL AND o.producto <> ''
    AND UPPER(COALESCE(o.estado,'')) NOT LIKE '%CANCEL%'
    AND (v_store IS NULL OR o.store_id = v_store)
  GROUP BY o.producto
  ORDER BY 5 ASC, 2 DESC
  LIMIT p_limit;
END;
$function$;

CREATE OR REPLACE FUNCTION public.logistics_cost_basis(p_from_date date, p_to_date date, p_ciudad text DEFAULT NULL::text)
 RETURNS TABLE(entregados bigint, ingresos_entregados numeric, cogs_entregados numeric, flete_entregados numeric)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;
  RETURN QUERY
  WITH entregadas AS (
    SELECT o.valor, o.costo_prod, o.flete
    FROM public.orders o
    WHERE o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND o.fecha::date BETWEEN p_from_date AND p_to_date
      AND UPPER(o.estado) = 'ENTREGADO'
      AND (p_ciudad IS NULL OR o.ciudad = p_ciudad)
      AND (v_store IS NULL OR o.store_id = v_store)
  )
  SELECT
    COUNT(*)::bigint,
    COALESCE(SUM(valor), 0)::numeric,
    COALESCE(SUM(costo_prod), 0)::numeric,
    COALESCE(SUM(flete), 0)::numeric
  FROM entregadas;
END;
$function$;

CREATE OR REPLACE FUNCTION public.financial_summary(p_from_date date, p_to_date date)
 RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_result jsonb;
  v_store  uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN NULL; END IF;

  WITH
  filtered AS (
    SELECT * FROM public.orders
    WHERE fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND fecha::date BETWEEN p_from_date AND p_to_date
      AND (v_store IS NULL OR store_id = v_store)
  ),
  entregados AS (
    SELECT * FROM filtered WHERE UPPER(COALESCE(estado, '')) LIKE 'ENTREGAD%'
  ),
  devueltos AS (
    SELECT * FROM filtered
    WHERE UPPER(COALESCE(estado, '')) LIKE 'DEVOLUC%'
       OR UPPER(COALESCE(estado, '')) LIKE 'DEVUELT%'
       OR UPPER(COALESCE(estado, '')) = 'RECHAZADO'
  ),
  cancelados AS (
    SELECT * FROM filtered
    WHERE UPPER(COALESCE(estado, '')) LIKE '%CANCEL%'
  ),
  wallet_range AS (
    SELECT * FROM public.dropi_wallet_movements
    WHERE fecha::date BETWEEN p_from_date AND p_to_date
      AND (v_store IS NULL OR store_id = v_store)
  ),
  agg AS (
    SELECT
      COALESCE((SELECT SUM(valor)      FROM entregados), 0) AS ingresos_brutos,
      COALESCE((SELECT SUM(costo_prod) FROM entregados), 0) AS cogs,
      COALESCE((SELECT SUM(flete)      FROM entregados), 0) AS flete_entregadas,
      COALESCE((SELECT SUM(flete)      FROM devueltos),  0) AS flete_devoluciones,
      COALESCE((SELECT SUM(ABS(monto)) FROM wallet_range
                WHERE categoria = 'costo_devolucion'),  0) AS cargo_extra_devoluciones,
      COALESCE((SELECT SUM(ABS(monto)) FROM wallet_range
                WHERE categoria = 'comision_referidos'),0) AS comision_referidos,
      COALESCE((SELECT SUM(monto) FROM wallet_range
                WHERE categoria IN ('ganancia_dropshipper','ganancia_proveedor')
                  AND tipo = 'ENTRADA'), 0) AS ganancia_markup,
      COALESCE((SELECT SUM(ABS(monto)) FROM wallet_range
                WHERE categoria = 'mantenimiento_tarjeta'), 0) AS mantenimiento_tarjeta,
      COALESCE((SELECT SUM(monto) FROM wallet_range
                WHERE categoria = 'indemnizacion'
                  AND tipo = 'ENTRADA'), 0) AS indemnizaciones,
      COALESCE((SELECT SUM(valor) FROM cancelados), 0) AS valor_cancelado,
      (SELECT COUNT(*) FROM cancelados) AS total_cancelados,
      (SELECT COUNT(*) FROM filtered)   AS total_ordenes,
      (SELECT COUNT(*) FROM entregados) AS total_entregadas,
      (SELECT COUNT(*) FROM devueltos)  AS total_devueltas,
      COALESCE((SELECT AVG(valor) FROM entregados), 0) AS avg_ticket,
      COALESCE((SELECT SUM(
        CASE WHEN tipo = 'ENTRADA' THEN monto ELSE -monto END
      ) FROM wallet_range), 0) AS wallet_neto
  ),
  agg_calc AS (
    SELECT
      a.*,
      a.flete_devoluciones + a.cargo_extra_devoluciones AS perdida_total_devoluciones,
      CASE WHEN a.total_devueltas > 0
        THEN ROUND((a.flete_devoluciones + a.cargo_extra_devoluciones)::numeric / a.total_devueltas, 0)
        ELSE 0
      END AS costo_promedio_devolucion
    FROM agg a
  )
  SELECT jsonb_build_object(
    'ingresos_brutos',     a.ingresos_brutos,
    'cogs',                a.cogs,
    'flete_entregadas',    a.flete_entregadas,
    'flete_devoluciones',  a.flete_devoluciones,
    'comision_referidos',  a.comision_referidos,
    'ganancia_markup',     a.ganancia_markup,
    'valor_cancelado',     a.valor_cancelado,
    'total_cancelados',    a.total_cancelados,
    'tasa_cancelacion_pct',
      CASE WHEN a.total_ordenes > 0
        THEN ROUND(100.0 * a.total_cancelados::numeric / a.total_ordenes, 2)
        ELSE 0 END,
    'costo_devoluciones',  a.cargo_extra_devoluciones,
    'perdida_total_devoluciones', a.perdida_total_devoluciones,
    'costo_promedio_devolucion',  a.costo_promedio_devolucion,
    'mantenimiento_tarjeta',      a.mantenimiento_tarjeta,
    'indemnizaciones',            a.indemnizaciones,
    'utilidad_bruta',
        a.ingresos_brutos - a.cogs - a.flete_entregadas
      - a.perdida_total_devoluciones - a.comision_referidos
      - a.mantenimiento_tarjeta + a.indemnizaciones,
    'total_ordenes',       a.total_ordenes,
    'total_entregadas',    a.total_entregadas,
    'total_devueltas',     a.total_devueltas,
    'tasa_entrega_pct',
      CASE WHEN a.total_ordenes > 0
        THEN ROUND(100.0 * a.total_entregadas::numeric / a.total_ordenes, 2)
        ELSE 0 END,
    'ticket_promedio',
      CASE WHEN a.total_entregadas > 0
        THEN ROUND(a.avg_ticket::numeric, 0)
        ELSE 0 END,
    'wallet_neto',         a.wallet_neto
  ) INTO v_result FROM agg_calc a;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.product_profitability(p_from_date date, p_to_date date, p_limit integer DEFAULT 100)
 RETURNS TABLE(producto text, total_pedidos bigint, entregados bigint, devueltos bigint, cancelados bigint, en_transito bigint, ingresos_entregados numeric, costo_prod_entregados numeric, flete_inicial_entregados numeric, costo_devolucion_total numeric, utilidad_real numeric, utilidad_proyectada numeric, tasa_entrega numeric, tasa_devolucion numeric, tasa_cancelacion numeric, ticket_promedio numeric, margen_pct numeric)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;
  RETURN QUERY
  WITH agg AS (
    SELECT
      o.producto::TEXT AS producto,
      COUNT(*) AS total_pedidos,
      COUNT(*) FILTER (WHERE UPPER(o.estado)='ENTREGADO') AS entregados,
      COUNT(*) FILTER (WHERE UPPER(o.estado) IN ('DEVOLUCION','DEVOLUCION EN TRANSITO','RECHAZADO')) AS devueltos,
      COUNT(*) FILTER (WHERE UPPER(COALESCE(o.estado,'')) LIKE '%CANCEL%') AS cancelados,
      COUNT(*) FILTER (WHERE UPPER(o.estado) NOT IN ('ENTREGADO','DEVOLUCION','DEVOLUCION EN TRANSITO','RECHAZADO')
        AND UPPER(COALESCE(o.estado,'')) NOT LIKE '%CANCEL%') AS en_transito,
      COALESCE(SUM(o.valor) FILTER (WHERE UPPER(o.estado)='ENTREGADO'),0) AS ingresos_entregados,
      COALESCE(SUM(o.costo_prod) FILTER (WHERE UPPER(o.estado)='ENTREGADO'),0) AS costo_prod_entregados,
      COALESCE(SUM(o.flete) FILTER (WHERE UPPER(o.estado)='ENTREGADO'),0) AS flete_inicial_entregados
    FROM public.orders o
    WHERE o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND o.fecha::date BETWEEN p_from_date AND p_to_date
      AND o.producto IS NOT NULL AND o.producto <> ''
      AND (v_store IS NULL OR o.store_id = v_store)
    GROUP BY o.producto
  ),
  wallet_attributed AS (
    SELECT o.producto::TEXT AS producto,
      COALESCE(SUM(ABS(w.monto)),0)::NUMERIC AS costo_attr
    FROM public.dropi_wallet_movements w
    JOIN public.orders o ON o.external_id IS NOT NULL AND w.related_order_id = o.external_id
    WHERE w.categoria='costo_devolucion'
      AND (w.fecha AT TIME ZONE 'America/Bogota')::date BETWEEN p_from_date AND p_to_date
      AND o.producto IS NOT NULL AND o.producto <> ''
      AND (v_store IS NULL OR w.store_id = v_store)
      AND (v_store IS NULL OR o.store_id = v_store)
    GROUP BY o.producto
  ),
  wallet_unattributed_total AS (
    SELECT COALESCE(SUM(ABS(w.monto)),0)::NUMERIC AS total_unattr
    FROM public.dropi_wallet_movements w
    WHERE w.categoria='costo_devolucion'
      AND (w.fecha AT TIME ZONE 'America/Bogota')::date BETWEEN p_from_date AND p_to_date
      AND (v_store IS NULL OR w.store_id = v_store)
      AND (
        w.related_order_id IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM public.orders o2
          WHERE o2.external_id = w.related_order_id
            AND o2.producto IS NOT NULL AND o2.producto <> ''
            AND (v_store IS NULL OR o2.store_id = v_store)
        )
      )
  ),
  total_devueltos AS (SELECT COALESCE(SUM(devueltos),0)::NUMERIC AS total_dev FROM agg),
  costo_dev_blended AS (
    SELECT a.producto,
      COALESCE(wa.costo_attr,0)
        + CASE WHEN (SELECT total_dev FROM total_devueltos) > 0
            THEN (a.devueltos::NUMERIC/(SELECT total_dev FROM total_devueltos))*(SELECT total_unattr FROM wallet_unattributed_total)
            ELSE 0 END AS costo_devolucion_real
    FROM agg a LEFT JOIN wallet_attributed wa ON wa.producto = a.producto
  ),
  with_calc AS (
    SELECT a.*, cdb.costo_devolucion_real AS costo_devolucion_total,
      (a.ingresos_entregados - a.costo_prod_entregados - a.flete_inicial_entregados - cdb.costo_devolucion_real) AS utilidad_real_calc,
      CASE WHEN a.entregados>0 THEN (a.ingresos_entregados - a.costo_prod_entregados - a.flete_inicial_entregados)/a.entregados ELSE 0 END AS utilidad_prom_entrega,
      CASE WHEN a.devueltos>0 THEN cdb.costo_devolucion_real/a.devueltos ELSE 0 END AS costo_prom_devolucion,
      CASE WHEN (a.entregados+a.devueltos+a.en_transito)>0 THEN a.entregados::NUMERIC/(a.entregados+a.devueltos+a.en_transito) ELSE 0 END AS p_entrega,
      CASE WHEN (a.entregados+a.devueltos+a.en_transito)>0 THEN a.devueltos::NUMERIC/(a.entregados+a.devueltos+a.en_transito) ELSE 0 END AS p_devolucion
    FROM agg a LEFT JOIN costo_dev_blended cdb ON cdb.producto = a.producto
  )
  SELECT
    wc.producto, wc.total_pedidos, wc.entregados, wc.devueltos, wc.cancelados, wc.en_transito,
    wc.ingresos_entregados, wc.costo_prod_entregados, wc.flete_inicial_entregados,
    ROUND(wc.costo_devolucion_total::NUMERIC,0),
    ROUND(wc.utilidad_real_calc::NUMERIC,0),
    ROUND((wc.utilidad_real_calc + wc.en_transito*wc.p_entrega*wc.utilidad_prom_entrega - wc.en_transito*wc.p_devolucion*wc.costo_prom_devolucion)::NUMERIC,0),
    ROUND(wc.p_entrega*100,2),
    ROUND(wc.p_devolucion*100,2),
    CASE WHEN wc.total_pedidos>0 THEN ROUND(wc.cancelados::NUMERIC*100/wc.total_pedidos,2) ELSE 0 END,
    CASE WHEN wc.entregados>0 THEN ROUND(wc.ingresos_entregados/wc.entregados,0) ELSE 0 END,
    CASE WHEN wc.ingresos_entregados>0 THEN ROUND(wc.utilidad_real_calc*100/wc.ingresos_entregados,2) ELSE 0 END
  FROM with_calc wc
  ORDER BY wc.utilidad_real_calc DESC
  LIMIT p_limit;
END;
$function$;

CREATE OR REPLACE FUNCTION public.wallet_summary(p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS TABLE(total_entradas numeric, total_salidas numeric, count_total bigint, ultimo_saldo numeric, categorias text[])
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;
  RETURN QUERY
  WITH base AS (
    SELECT m.tipo, m.monto, m.categoria, m.saldo_despues, m.fecha
    FROM public.dropi_wallet_movements m
    WHERE m.fecha >= p_from AND m.fecha <= p_to
      AND (v_store IS NULL OR m.store_id = v_store)
  ),
  ult AS (
    SELECT b.saldo_despues FROM base b WHERE b.saldo_despues IS NOT NULL
    ORDER BY b.fecha DESC LIMIT 1
  )
  SELECT
    COALESCE(SUM(CASE WHEN b.tipo='ENTRADA' THEN b.monto ELSE 0 END),0)::numeric,
    COALESCE(SUM(CASE WHEN b.tipo='SALIDA'  THEN b.monto ELSE 0 END),0)::numeric,
    COUNT(*)::bigint,
    (SELECT u.saldo_despues FROM ult u),
    COALESCE(ARRAY_AGG(DISTINCT b.categoria) FILTER (WHERE b.categoria IS NOT NULL), '{}')
  FROM base b;
END;
$function$;

CREATE OR REPLACE FUNCTION public.wallet_daily_series(p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS TABLE(fecha date, entrada numeric, salida numeric)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT
    (m.fecha AT TIME ZONE 'America/Bogota')::date,
    COALESCE(SUM(CASE WHEN m.tipo='ENTRADA' THEN m.monto ELSE 0 END),0)::numeric,
    COALESCE(SUM(CASE WHEN m.tipo='SALIDA'  THEN m.monto ELSE 0 END),0)::numeric
  FROM public.dropi_wallet_movements m
  WHERE m.fecha >= p_from AND m.fecha <= p_to
    AND (v_store IS NULL OR m.store_id = v_store)
  GROUP BY 1
  ORDER BY 1;
END;
$function$;

CREATE OR REPLACE FUNCTION public.wallet_ganancia_neta(p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS TABLE(total_entradas numeric, total_salidas numeric, ganancia_neta numeric, movimientos_count bigint, ganancia_dropshipper numeric, ganancia_proveedor numeric, reembolso_flete numeric, indemnizacion numeric, flete_inicial numeric, costo_devolucion numeric, comision_referidos numeric, mantenimiento_tarjeta numeric, orden_sin_recaudo numeric)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;
  RETURN QUERY
  WITH base AS (
    SELECT m.categoria AS cat, ABS(COALESCE(m.monto, 0)) AS monto
    FROM public.dropi_wallet_movements m
    WHERE m.fecha >= p_from AND m.fecha <= p_to
      AND (v_store IS NULL OR m.store_id = v_store)
      AND m.categoria IN (
        'ganancia_dropshipper','ganancia_proveedor','reembolso_flete','indemnizacion',
        'flete_inicial','costo_devolucion','comision_referidos','mantenimiento_tarjeta','orden_sin_recaudo'
      )
  ),
  agg AS (
    SELECT
      COALESCE(SUM(monto) FILTER (WHERE cat = 'ganancia_dropshipper'),  0) AS ganancia_dropshipper,
      COALESCE(SUM(monto) FILTER (WHERE cat = 'ganancia_proveedor'),    0) AS ganancia_proveedor,
      COALESCE(SUM(monto) FILTER (WHERE cat = 'reembolso_flete'),       0) AS reembolso_flete,
      COALESCE(SUM(monto) FILTER (WHERE cat = 'indemnizacion'),         0) AS indemnizacion,
      COALESCE(SUM(monto) FILTER (WHERE cat = 'flete_inicial'),         0) AS flete_inicial,
      COALESCE(SUM(monto) FILTER (WHERE cat = 'costo_devolucion'),      0) AS costo_devolucion,
      COALESCE(SUM(monto) FILTER (WHERE cat = 'comision_referidos'),    0) AS comision_referidos,
      COALESCE(SUM(monto) FILTER (WHERE cat = 'mantenimiento_tarjeta'), 0) AS mantenimiento_tarjeta,
      COALESCE(SUM(monto) FILTER (WHERE cat = 'orden_sin_recaudo'),     0) AS orden_sin_recaudo,
      COUNT(*) AS movimientos_count
    FROM base
  )
  SELECT
    (a.ganancia_dropshipper + a.ganancia_proveedor + a.reembolso_flete + a.indemnizacion)::numeric,
    (a.flete_inicial + a.costo_devolucion + a.comision_referidos + a.mantenimiento_tarjeta + a.orden_sin_recaudo)::numeric,
    (a.ganancia_dropshipper + a.ganancia_proveedor + a.reembolso_flete + a.indemnizacion
      - a.flete_inicial - a.costo_devolucion - a.comision_referidos - a.mantenimiento_tarjeta - a.orden_sin_recaudo)::numeric,
    a.movimientos_count,
    a.ganancia_dropshipper, a.ganancia_proveedor, a.reembolso_flete, a.indemnizacion,
    a.flete_inicial, a.costo_devolucion, a.comision_referidos, a.mantenimiento_tarjeta, a.orden_sin_recaudo
  FROM agg a;
END;
$function$;

CREATE OR REPLACE FUNCTION public.orders_estado_breakdown(p_from date, p_to date)
 RETURNS TABLE(estado text, pedidos bigint, valor numeric, unidades numeric)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT
    UPPER(COALESCE(NULLIF(TRIM(o.estado), ''), '(sin estado)')) AS estado,
    COUNT(*)::bigint,
    COALESCE(SUM(o.valor), 0)::numeric,
    COALESCE(SUM(COALESCE(o.cantidad, 0)), 0)::numeric
  FROM public.orders o
  WHERE o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
    AND o.fecha::date BETWEEN p_from AND p_to
    AND (v_store IS NULL OR o.store_id = v_store)
  GROUP BY UPPER(COALESCE(NULLIF(TRIM(o.estado), ''), '(sin estado)'));
END;
$function$;

CREATE OR REPLACE FUNCTION public.novedades_root_cause(p_from date, p_to date)
 RETURNS TABLE(order_id uuid, novedad text, validation_decision text, address_kind text, valor numeric, transportadora text, ciudad text, confirmer_id uuid, confirmer_name text, tiene_novedad boolean)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT
    o.id,
    o.novedad,
    o.validation_decision,
    o.address_kind,
    o.valor,
    o.transportadora,
    o.ciudad,
    conf.operator_id,
    p.display_name,
    (o.novedad IS NOT NULL AND btrim(o.novedad) <> '')
  FROM public.orders o
  LEFT JOIN LATERAL (
    SELECT r.operator_id
    FROM public.order_results r
    WHERE r.order_id = o.id
      AND r.module = 'confirmar'
      AND r.result = 'conf'
      AND (v_store IS NULL OR r.store_id = v_store)
    ORDER BY r.created_at DESC
    LIMIT 1
  ) conf ON true
  LEFT JOIN public.profiles p ON p.user_id = conf.operator_id
  WHERE o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
    AND o.fecha::date BETWEEN p_from AND p_to
    AND (v_store IS NULL OR o.store_id = v_store)
    AND (
      o.estado ILIKE '%DEVUELT%'
      OR o.estado ILIKE '%RECHAZ%'
      OR o.estado ILIKE '%DEVOLUC%'
    )
  ORDER BY o.valor DESC NULLS LAST
  LIMIT 5000;
END;
$function$;


-- 1) operator_productivity_stats: filtrar solo llamadas reales (conf/canc/noresp)
CREATE OR REPLACE FUNCTION public.operator_productivity_stats(p_range text DEFAULT 'today'::text)
 RETURNS TABLE(operator_id uuid, display_name text, confirmados bigint, cancelados bigint, noresp bigint, novedades_resueltas bigint, seg_acciones bigint, seg_resueltos bigint, rescate_acciones bigint, rescate_resueltos bigint, total_atendidos bigint, total_entrantes bigint, tasa_contacto numeric, tasa_confirmacion numeric, seg_pedidos bigint, seg_resueltos_dist bigint, rescate_pedidos bigint, rescate_resueltos_dist bigint, intentos_noresp bigint, intentos_total bigint, pendientes_sin_tocar bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
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
          AND r.result IN ('conf','canc','noresp')
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
      COUNT(DISTINCT r.order_id) FILTER (
        WHERE r.module='confirmar' AND r.result IN ('conf','canc','noresp')
      ) AS total_atendidos,
      COUNT(DISTINCT r.order_id) FILTER (WHERE r.module='confirmar' AND r.result='noresp') AS intentos_noresp,
      COUNT(*) FILTER (WHERE r.module='confirmar' AND r.result IN ('conf','canc','noresp')) AS intentos_total
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

-- 2) get_daily_operator_stats: COUNT(DISTINCT order_id) FILTER
CREATE OR REPLACE FUNCTION public.get_daily_operator_stats(p_date date)
 RETURNS TABLE(operator_id uuid, display_name text, conf bigint, canc bigint, noresp bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT r.operator_id, COALESCE(p.display_name, 'Operador'),
    COUNT(DISTINCT r.order_id) FILTER (WHERE r.module='confirmar' AND r.result = 'conf'),
    COUNT(DISTINCT r.order_id) FILTER (WHERE r.module='confirmar' AND r.result = 'canc'),
    COUNT(DISTINCT r.order_id) FILTER (WHERE r.module='confirmar' AND r.result = 'noresp')
  FROM public.order_results r
  LEFT JOIN public.profiles p ON p.user_id = r.operator_id
  WHERE r.result_date = p_date AND r.store_id = v_store
  GROUP BY r.operator_id, p.display_name;
END $function$;

-- 3a) today_call_stats: scope por tienda activa
CREATE OR REPLACE FUNCTION public.today_call_stats()
 RETURNS TABLE(confirmados bigint, cancelados bigint, noresp bigint, total bigint, tasa_conf numeric, pending_tomorrow integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today DATE := (NOW() AT TIME ZONE 'America/Bogota')::date;
  v_store uuid := public._resolve_scope_store();
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
      COUNT(DISTINCT r.order_id) FILTER (
        WHERE r.module = 'confirmar' AND r.result = 'noresp'
      ) AS n,
      COUNT(DISTINCT r.order_id) FILTER (
        WHERE r.module = 'confirmar' AND r.result IN ('conf','canc','noresp')
      ) AS g
    FROM public.order_results r
    WHERE r.operator_id = auth.uid()
      AND r.module = 'confirmar'
      AND r.result_date = v_today
      AND (v_store IS NULL OR r.store_id = v_store)
  )
  SELECT
    s.c, s.x, s.n, s.g,
    CASE WHEN (s.c + s.x) = 0 THEN 0
         ELSE ROUND((s.c::numeric / (s.c + s.x)::numeric) * 100, 1) END,
    public.pending_tomorrow_count()
  FROM s;
END; $function$;

-- 3b) operator_today_tasa: scope por tienda activa
CREATE OR REPLACE FUNCTION public.operator_today_tasa()
 RETURNS TABLE(confirmados bigint, cancelados bigint, noresp bigint, total bigint, tasa_confirmacion numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid UUID := auth.uid();
  v_today DATE := (NOW() AT TIME ZONE 'America/Bogota')::date;
  v_store uuid := public._resolve_scope_store();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT
      COUNT(DISTINCT r.order_id) FILTER (WHERE r.result = 'conf')   AS confirmados,
      COUNT(DISTINCT r.order_id) FILTER (WHERE r.result = 'canc')   AS cancelados,
      COUNT(DISTINCT r.order_id) FILTER (WHERE r.result = 'noresp') AS noresp,
      COUNT(DISTINCT r.order_id) FILTER (WHERE r.result IN ('conf','canc','noresp')) AS gestionados
    FROM public.order_results r
    WHERE r.operator_id = v_uid
      AND r.module = 'confirmar'
      AND r.result_date = v_today
      AND (v_store IS NULL OR r.store_id = v_store)
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
$function$;

-- 4) record_operator_heartbeat: clamp con LEAST(v, 120) en vez de descartar
CREATE OR REPLACE FUNCTION public.record_operator_heartbeat(p_store_id uuid, p_active_seconds integer, p_idle_seconds integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := ((NOW() AT TIME ZONE 'America/Bogota')::date);
  v_now   timestamptz := NOW();
  v_active integer;
  v_idle   integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;
  IF p_active_seconds < 0 OR p_idle_seconds < 0 THEN RETURN; END IF;
  -- Clamp defensivo: si un cliente vuelve tras un corte de red con buckets
  -- gigantes, no perdemos toda la actividad — recortamos a 120s.
  v_active := LEAST(p_active_seconds, 120);
  v_idle   := LEAST(p_idle_seconds,   120);
  IF v_active = 0 AND v_idle = 0 THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.store_members
                 WHERE store_id = p_store_id AND user_id = auth.uid())
    THEN RAISE EXCEPTION 'not a member of store'; END IF;

  IF v_active = 0 THEN
    UPDATE public.operator_activity_daily
      SET idle_seconds = idle_seconds + v_idle
      WHERE operator_id = auth.uid() AND store_id = p_store_id AND activity_date = v_today;
  ELSE
    INSERT INTO public.operator_activity_daily AS d (
      operator_id, store_id, activity_date, first_action_at, last_active_at, active_seconds, idle_seconds
    ) VALUES (auth.uid(), p_store_id, v_today, v_now, v_now, v_active, v_idle)
    ON CONFLICT (operator_id, store_id, activity_date) DO UPDATE
      SET active_seconds = d.active_seconds + EXCLUDED.active_seconds,
          idle_seconds   = d.idle_seconds   + EXCLUDED.idle_seconds,
          last_active_at = v_now;
  END IF;
END $function$;

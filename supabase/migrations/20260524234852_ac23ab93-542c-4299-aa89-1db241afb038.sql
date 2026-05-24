-- ============================================================
-- Migration 1: scope operator reports by active store
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_daily_operator_stats(p_date date)
 RETURNS TABLE(operator_id uuid, display_name text, conf bigint, canc bigint, noresp bigint)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
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
GRANT EXECUTE ON FUNCTION public.get_daily_operator_stats(date) TO authenticated;

CREATE OR REPLACE FUNCTION public.operator_productivity_stats(p_range text DEFAULT 'today'::text)
 RETURNS TABLE(operator_id uuid, display_name text, confirmados bigint, cancelados bigint, noresp bigint, novedades_resueltas bigint, seg_acciones bigint, seg_resueltos bigint, rescate_acciones bigint, rescate_resueltos bigint, total_atendidos bigint, total_entrantes bigint, tasa_contacto numeric, tasa_confirmacion numeric)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_since timestamptz;
  v_total_entrantes bigint;
  v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();

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
GRANT EXECUTE ON FUNCTION public.operator_productivity_stats(text) TO authenticated;

-- ============================================================
-- Migration 2: scope logistics/wallet by active store
-- ============================================================
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS active_store_id uuid;

CREATE OR REPLACE FUNCTION public.set_active_store(p_store_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF p_store_id IS NULL THEN
    RETURN;
  END IF;
  IF public.has_role(auth.uid(), 'admin')
     OR EXISTS (
       SELECT 1 FROM public.store_members m
       WHERE m.user_id = auth.uid() AND m.store_id = p_store_id
     ) THEN
    UPDATE public.profiles
       SET active_store_id = p_store_id
     WHERE user_id = auth.uid();
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION public.set_active_store(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public._resolve_scope_store()
RETURNS uuid
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_store uuid;
BEGIN
  IF public.has_role(auth.uid(), 'admin') THEN
    SELECT active_store_id INTO v_store FROM public.profiles WHERE user_id = auth.uid();
    RETURN v_store;
  END IF;
  SELECT store_id INTO v_store FROM public.store_members
   WHERE user_id = auth.uid() AND role IN ('owner','supervisor') LIMIT 1;
  IF v_store IS NULL THEN
    RAISE EXCEPTION 'No autorizado' USING ERRCODE = '42501';
  END IF;
  RETURN v_store;
END;
$$;
-- PARTE B: operator_productivity_stats excluye admins
DROP FUNCTION IF EXISTS public.operator_productivity_stats(text);

CREATE OR REPLACE FUNCTION public.operator_productivity_stats(p_range text DEFAULT 'today')
RETURNS TABLE (
  operator_id uuid, display_name text, confirmados bigint, cancelados bigint, noresp bigint,
  novedades_resueltas bigint, seg_acciones bigint, seg_resueltos bigint,
  rescate_acciones bigint, rescate_resueltos bigint, total_atendidos bigint,
  tasa_contacto numeric, tasa_confirmacion numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_since timestamptz;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores pueden ver estas metricas';
  END IF;
  v_since := CASE p_range
    WHEN 'today' THEN (((NOW() AT TIME ZONE 'America/Bogota')::date)::timestamp AT TIME ZONE 'America/Bogota')
    WHEN '7d' THEN NOW() - INTERVAL '7 days'
    WHEN '30d' THEN NOW() - INTERVAL '30 days'
    ELSE NOW() - INTERVAL '24 hours'
  END;
  RETURN QUERY
  WITH admin_ids AS (SELECT user_id FROM public.user_roles WHERE role = 'admin'),
  base AS (
    SELECT r.operator_id,
      COUNT(*) FILTER (WHERE r.module='confirmar' AND r.result='conf') AS confirmados,
      COUNT(*) FILTER (WHERE r.module='confirmar' AND r.result='canc') AS cancelados,
      COUNT(*) FILTER (WHERE r.module='confirmar' AND r.result='noresp') AS noresp,
      COUNT(*) FILTER (WHERE r.module='novedades' AND r.result='conf') AS novedades_resueltas,
      COUNT(DISTINCT r.order_id) FILTER (WHERE r.module='confirmar') AS total_atendidos
    FROM public.order_results r
    WHERE r.created_at >= v_since AND r.operator_id NOT IN (SELECT user_id FROM admin_ids)
    GROUP BY r.operator_id
  ),
  tp_stats AS (
    SELECT t.operator_id,
      COUNT(*) FILTER (WHERE t.action LIKE 'SEG:%') AS seg_acciones,
      COUNT(*) FILTER (WHERE t.action IN ('SEG: Resuelto','SEG: Devolucion solicitada','SEG: Solicite devolucion')) AS seg_resueltos,
      COUNT(*) FILTER (WHERE t.action LIKE 'RESCUE:%') AS rescate_acciones,
      COUNT(*) FILTER (WHERE t.action IN ('RESCUE: Resuelto','RESCUE: Devolucion solicitada','RESCUE: Solicite devolucion')) AS rescate_resueltos
    FROM public.touchpoints t
    WHERE t.created_at >= v_since AND t.operator_id NOT IN (SELECT user_id FROM admin_ids)
    GROUP BY t.operator_id
  ),
  all_ops AS (SELECT operator_id FROM base UNION SELECT operator_id FROM tp_stats)
  SELECT ao.operator_id, COALESCE(p.display_name,'Operador'),
    COALESCE(b.confirmados,0)::bigint, COALESCE(b.cancelados,0)::bigint, COALESCE(b.noresp,0)::bigint,
    COALESCE(b.novedades_resueltas,0)::bigint, COALESCE(t.seg_acciones,0)::bigint, COALESCE(t.seg_resueltos,0)::bigint,
    COALESCE(t.rescate_acciones,0)::bigint, COALESCE(t.rescate_resueltos,0)::bigint, COALESCE(b.total_atendidos,0)::bigint,
    CASE WHEN COALESCE(b.confirmados+b.cancelados+b.noresp,0)=0 THEN 0
         ELSE ROUND(((COALESCE(b.confirmados,0)+COALESCE(b.cancelados,0))::numeric/(b.confirmados+b.cancelados+b.noresp)::numeric)*100,1) END,
    CASE WHEN COALESCE(b.confirmados+b.cancelados+b.noresp,0)=0 THEN 0
         ELSE ROUND((COALESCE(b.confirmados,0)::numeric/(b.confirmados+b.cancelados+b.noresp)::numeric)*100,1) END
  FROM all_ops ao
  LEFT JOIN base b ON b.operator_id=ao.operator_id
  LEFT JOIN tp_stats t ON t.operator_id=ao.operator_id
  LEFT JOIN public.profiles p ON p.user_id=ao.operator_id
  ORDER BY (COALESCE(b.confirmados,0)+COALESCE(t.seg_acciones,0)+COALESCE(t.rescate_acciones,0)) DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.operator_productivity_stats(text) TO authenticated;

-- PARTE D1: claim_order race-safe
CREATE OR REPLACE FUNCTION public.claim_order(p_order_id UUID)
RETURNS SETOF public.orders
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_phone TEXT;
BEGIN
  IF NOT public.has_role(auth.uid(), 'operator') AND NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'No tienes permiso para reclamar pedidos';
  END IF;
  SELECT phone INTO v_phone FROM public.orders WHERE id = p_order_id;
  IF v_phone IS NULL OR v_phone = '' THEN RETURN; END IF;
  RETURN QUERY
  UPDATE public.orders
  SET locked_by = auth.uid(), locked_at = NOW()
  WHERE phone = v_phone AND estado = 'PENDIENTE CONFIRMACION'
    AND (locked_by IS NULL OR locked_by = auth.uid() OR locked_at < NOW() - INTERVAL '15 minutes')
    AND NOT EXISTS (
      SELECT 1 FROM public.orders o2
      WHERE o2.phone = v_phone AND o2.estado = 'PENDIENTE CONFIRMACION'
        AND o2.locked_by IS NOT NULL AND o2.locked_by != auth.uid()
        AND o2.locked_at >= NOW() - INTERVAL '15 minutes'
    )
  RETURNING *;
END;
$$;
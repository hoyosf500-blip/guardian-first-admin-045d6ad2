-- ─────────────────────────────────────────────────────────────────────────────
-- operator_productivity_stats: incluir SUPERVISORES y OWNERS que trabajan — 2026-07-30.
--
-- Decisión del dueño: el trabajo de confirmación de un supervisor (ej. Roberto en
-- EC) NO aparecía en Productividad ni en /en-vivo porque el filtro era
-- `sm.role = 'operator'`, aunque SÍ aparecía en Jornada (que solo excluye admins
-- globales). Efecto: confirmaba pero salía "0 confirmados", y el % del día del
-- equipo quedaba subestimado (el aro excluía sus confirmaciones mientras
-- `entrantes` incluía sus pedidos).
--
-- Fix: contar a quien sea miembro con rol operator / supervisor / owner, pero
-- SEGUIR excluyendo al admin GLOBAL (Fabián) — igual criterio que
-- operator_activity_stats / worked_blocks / inactivity_stats. Así todas las RPC
-- de esta superficie coinciden en "quién es trabajador".
--
-- REGLA #1: cuerpo copiado del pg_get_functiondef DESPLEGADO (versión con
-- `confirmados_cohorte`). Lo ÚNICO que cambia es el WHERE final (rol + exclusión
-- de admin global). Todo lo demás queda idéntico.
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.operator_productivity_stats(text);

CREATE OR REPLACE FUNCTION public.operator_productivity_stats(p_range text DEFAULT 'today'::text)
 RETURNS TABLE(operator_id uuid, display_name text, confirmados bigint, cancelados bigint, noresp bigint, novedades_resueltas bigint, seg_acciones bigint, seg_resueltos bigint, rescate_acciones bigint, rescate_resueltos bigint, total_atendidos bigint, total_entrantes bigint, tasa_contacto numeric, tasa_confirmacion numeric, seg_pedidos bigint, seg_resueltos_dist bigint, rescate_pedidos bigint, rescate_resueltos_dist bigint, intentos_noresp bigint, intentos_total bigint, pendientes_sin_tocar bigint, confirmados_cohorte bigint)
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
      COUNT(DISTINCT r.order_id) FILTER (
        WHERE r.module='confirmar' AND r.result='conf'
          AND EXISTS (
            SELECT 1 FROM public.orders oc
            WHERE oc.id = r.order_id
              AND oc.created_at >= v_since
              AND (v_store IS NULL OR oc.store_id = v_store)
          )
      ) AS confirmados_cohorte,
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
    GREATEST(v_total_entrantes - COALESCE(b.total_atendidos,0), 0)::bigint,
    COALESCE(b.confirmados_cohorte,0)::bigint
  FROM all_ops ao
  LEFT JOIN base b ON b.op_id = ao.op_id
  LEFT JOIN tp_stats t ON t.op_id = ao.op_id
  LEFT JOIN public.profiles p ON p.user_id = ao.op_id
  -- CAMBIO: incluir operator + supervisor + owner (trabajadores de la tienda),
  -- pero EXCLUIR al admin global (Fabián), igual que las otras RPC de jornada.
  WHERE (v_store IS NULL OR EXISTS (
    SELECT 1 FROM public.store_members sm
    WHERE sm.user_id = ao.op_id AND sm.store_id = v_store
      AND sm.role IN ('operator','supervisor','owner')
  ))
  AND NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = ao.op_id AND ur.role = 'admin'
  )
  ORDER BY (COALESCE(b.confirmados,0)+COALESCE(t.seg_acciones,0)+COALESCE(t.rescate_acciones,0)) DESC, 2;
END;
$function$;

REVOKE ALL ON FUNCTION public.operator_productivity_stats(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.operator_productivity_stats(text) TO authenticated;

-- Cierre "Reportes diarios → Vista por día — cohort de inflow": ENTRANTES contaba
-- de menos (reporte del dueño 2026-07-18: Shopify ~68, el cierre decía 32).
--
-- Causa raíz (verificada con datos reales, Rushmira Ecuador 17-jul): el CRM SÍ
-- tenía 74 pedidos ese día, pero `admin_daily_reports_range` solo contaba como
-- "entrante" a los que pasaron por la COLA DE CONFIRMACIÓN manual:
--     estado='PENDIENTE CONFIRMACION' OR EXISTS(order_results confirmar)
-- En Ecuador MUCHOS pedidos entran ya despachados (GUIA_GENERADA / EN RUTA / EN
-- TRÁNSITO / PENDIENTE…) sin pasar por confirmación manual → no tenían resultado
-- 'confirmar' ni estado 'PENDIENTE CONFIRMACION' → quedaban fuera. Además 13
-- estaban en REEMPLAZADA (ediciones: el editor crea uno nuevo y marca el viejo
-- REEMPLAZADA) — esos SÍ deben excluirse (son duplicados de edición).
--
-- Fix: "entrantes" = TODOS los pedidos reales que entraron ese día (por
-- created_at Bogotá, de la tienda), EXCLUYENDO solo los REEMPLAZADA. El resultado
-- final de los que entraron ya despachados se deriva del estado Dropi (con guía /
-- en ruta = confirmado de hecho; cancelado = cancelado). La gestión MANUAL
-- (order_results de confirmar) sigue mandando cuando existe — así los números de
-- las operadoras no cambian, solo se SUMAN los que entraron ya confirmados.
--
-- NOTA: la Productividad ("Confirmación del día" de la operadora) sigue midiendo
-- SOLO la cola de confirmación a propósito (una operadora no puede confirmar lo
-- que entró ya confirmado) — por eso ese "entrantes" es más chico y es correcto.

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
    -- TODOS los pedidos reales que entraron ese día (menos los REEMPLAZADA, que
    -- son duplicados de edición). Ya NO exigimos que hayan pasado por la cola de
    -- confirmación manual → incluye los que entraron ya despachados.
    SELECT (o.created_at AT TIME ZONE 'America/Bogota')::date AS fecha, o.id, o.estado
    FROM public.orders o
    WHERE (o.created_at AT TIME ZONE 'America/Bogota')::date BETWEEN p_from AND p_to
      AND (v_store IS NULL OR o.store_id = v_store)
      AND COALESCE(o.estado, '') <> 'REEMPLAZADA'
  ),
  final_status AS (
    SELECT ic.fecha, ic.id AS order_id,
      CASE
        -- La gestión MANUAL manda (idéntico a antes para lo que ya se contaba).
        WHEN EXISTS (SELECT 1 FROM public.order_results r WHERE r.order_id = ic.id AND r.module='confirmar' AND r.result='conf'   AND (v_store IS NULL OR r.store_id = v_store)) THEN 'conf'
        WHEN EXISTS (SELECT 1 FROM public.order_results r WHERE r.order_id = ic.id AND r.module='confirmar' AND r.result='canc'   AND (v_store IS NULL OR r.store_id = v_store)) THEN 'canc'
        WHEN EXISTS (SELECT 1 FROM public.order_results r WHERE r.order_id = ic.id AND r.module='confirmar' AND r.result='noresp' AND (v_store IS NULL OR r.store_id = v_store)) THEN 'noresp'
        -- Sin gestión manual → derivar del estado Dropi.
        WHEN ic.estado ILIKE '%CANCELAD%' OR ic.estado ILIKE '%RECHAZAD%' OR ic.estado ILIKE '%ANULAD%' THEN 'canc'
        WHEN ic.estado = 'PENDIENTE CONFIRMACION' THEN 'pendiente'
        -- Entró ya con guía / en ruta / despachado = confirmado de hecho.
        ELSE 'conf'
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

GRANT EXECUTE ON FUNCTION public.admin_daily_reports_range(date, date) TO authenticated;

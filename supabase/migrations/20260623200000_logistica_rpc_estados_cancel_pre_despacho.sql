-- ════════════════════════════════════════════════════════════════════════
-- Logística RPC — fix de 3 inexactitudes (estados sin contar + regla cancel
-- + denominador de tasa), SIN cambiar firmas, columnas ni scope.
--
-- FUENTE DE VERDAD: migration 20260521233349 (definiciones VIVAS, store-scoped
-- vía _resolve_scope_store). Las migrations 20260427* / 20260428* / 20260429* /
-- 20260507* están DESACTUALIZADAS (una gatea admin-only) — NO son producción.
-- Esta migration parte EXACTAMENTE de las defs de 20260521233349 y solo cambia
-- las listas IN(...) y la regla de cancelados indicadas abajo.
--
-- Cambios:
--   (1) +4 estados que hoy no se cuentan: 'DESPACHADA','EN BODEGA DESTINO',
--       'EN PUNTO DROOP' (→ en_transito) y 'RECLAME EN OFICINA' (→ novedades).
--   (2) Unificar regla de cancelados a NOT LIKE '%CANCEL%'.
--   (3) En carrier: excluir pre-despacho del denominador de tasa (la tasa de la
--       transportadora se mide solo sobre lo que YA despachó).
--
-- Solo cambian los overloads de 3 args de logistics_by_carrier y
-- logistics_summary. Los overloads de 2 args (código muerto) NO se tocan ni se
-- borran. logistics_by_city y logistics_by_product YA estaban correctas
-- (devuelto IN correcto + NOT LIKE '%CANCEL%') → no se incluyen.
--
-- Idempotente: CREATE OR REPLACE, firmas idénticas (no requiere DROP).
-- ════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────
-- A) logistics_by_carrier (3 args) — overload con p_ciudad (el que usa el cliente)
--    +7 estados a en_transito (los 3 nuevos + los 4 que summary ya tenía y a
--    carrier le faltaban), +RECLAME EN OFICINA a novedades, regla cancel
--    unificada, y exclusión de pre-despacho del WHERE (→ del denominador).
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.logistics_by_carrier(p_from_date date, p_to_date date, p_ciudad text DEFAULT NULL::text)
 RETURNS TABLE(transportadora text, total_pedidos bigint, entregados bigint, devueltos bigint, en_transito bigint, novedades bigint, tasa_entrega numeric, tasa_devolucion numeric, valor_entregado numeric, valor_perdido numeric, avg_dias_entrega numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
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

-- ────────────────────────────────────────────────────────────────────────
-- B) logistics_summary (3 args, 16 columnas) — overload con p_ciudad.
--    +3 estados a en_transito (COUNT y SUM valor_en_transito), +RECLAME EN
--    OFICINA a novedades (COUNT y SUM valor_novedades), y los DOS denominadores
--    de tasa pasan de <> 'CANCELADO' a NOT LIKE '%CANCEL%'. total_pedidos,
--    cancelados, pendientes y columnas nuevas: SIN cambios.
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.logistics_summary(p_from_date date, p_to_date date, p_ciudad text DEFAULT NULL::text)
 RETURNS TABLE(total_pedidos bigint, entregados bigint, devueltos bigint, en_transito bigint, tasa_entrega numeric, tasa_devolucion numeric, valor_entregado numeric, valor_perdido numeric, valor_en_transito numeric, pendientes_sin_despachar bigint, pendientes_por_confirmar bigint, valor_pendientes numeric, cancelados bigint, valor_cancelado numeric, novedades bigint, valor_novedades numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
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

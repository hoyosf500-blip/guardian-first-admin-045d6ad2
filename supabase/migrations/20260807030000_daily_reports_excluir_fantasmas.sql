-- El reporte diario contaba los pedidos FANTASMA como CONFIRMADOS.
--
-- `inflow_cohort` filtraba a mano `COALESCE(o.estado,'') <> 'REEMPLAZADA'`. Un pedido
-- `ARCHIVADO GHOST` (borrado en Dropi) no matchea ninguna rama del CASE de abajo — no
-- dice CANCELAD, ni RECHAZAD, ni ANULAD, ni es 'PENDIENTE CONFIRMACION' — así que caía
-- en el `ELSE 'conf'`. Resultado: un pedido que NO EXISTE en Dropi engordaba el inflow
-- del día Y la cuenta de confirmados.
--
-- Medido en producción el 2026-08-07 (tienda CO):
--   marzo–mayo 0 · junio 2 · JULIO 65 · agosto (6 días) 12
-- Julio: 65 de 455 pedidos = 14% de la cohorte contados como confirmados sin que nadie
-- los confirmara. Agosto iba en 20% y subiendo.
--
-- Por qué aparece recién ahora: hasta el 2026-07-21 `dropi-nightly-reconcile` marcaba
-- estos pedidos como CANCELADO, y el CASE los agarraba con el ILIKE '%CANCELAD%'. Ese
-- commit los pasó a `ARCHIVADO GHOST` para dejar de inflar la tasa de CANCELACIÓN — y
-- sin querer empezó a inflar la de CONFIRMACIÓN. **El arreglo movió el bug de lugar.**
--
-- La corrección es cambiar el filtro literal por el bucket canónico:
--   `_estado_bucket(o.estado) <> 'borrado'`
-- que cubre REEMPLAZADA, ARCHIVADO GHOST y la variante con guion bajo de una sola vez
-- (normaliza '_' → espacio antes de comparar). Es la misma defensa que ya usan las 14
-- migraciones de logistics_*/financial_summary.
--
-- ⛔ REGLA #1: cuerpo partido del `pg_get_functiondef` de la función corriendo en
-- producción (leído 2026-08-07), no del repo. Resultaron idénticos. El único delta
-- contra la versión viva es esa línea del filtro.
--
-- NOTA (no se toca acá): el `(v_store IS NULL OR ...)` que se repite dentro es código
-- muerto — arriba hay un `IF v_store IS NULL THEN RETURN`, así que nunca puede ser NULL.
-- Se deja tal cual para que el diff sea de UNA línea; ver la memoria
-- `rpc_null_store_global_leak` antes de replicar ese patrón en una función nueva.

CREATE OR REPLACE FUNCTION public.admin_daily_reports_range(p_from date, p_to date)
 RETURNS TABLE(fecha date, entrantes integer, confirmados integer, cancelados integer, noresp integer, pendientes integer, pct_confirmacion numeric, pct_cancelados numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
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
    SELECT (o.created_at AT TIME ZONE 'America/Bogota')::date AS fecha, o.id, o.estado
    FROM public.orders o
    WHERE (o.created_at AT TIME ZONE 'America/Bogota')::date BETWEEN p_from AND p_to
      AND (v_store IS NULL OR o.store_id = v_store)
      -- ANTES: COALESCE(o.estado,'') <> 'REEMPLAZADA'  ← dejaba pasar ARCHIVADO GHOST
      AND public._estado_bucket(o.estado) <> 'borrado'
  ),
  final_status AS (
    SELECT ic.fecha, ic.id AS order_id,
      CASE
        WHEN EXISTS (SELECT 1 FROM public.order_results r WHERE r.order_id = ic.id AND r.module='confirmar' AND r.result='conf'   AND (v_store IS NULL OR r.store_id = v_store)) THEN 'conf'
        WHEN EXISTS (SELECT 1 FROM public.order_results r WHERE r.order_id = ic.id AND r.module='confirmar' AND r.result='canc'   AND (v_store IS NULL OR r.store_id = v_store)) THEN 'canc'
        WHEN EXISTS (SELECT 1 FROM public.order_results r WHERE r.order_id = ic.id AND r.module='confirmar' AND r.result='noresp' AND (v_store IS NULL OR r.store_id = v_store)) THEN 'noresp'
        WHEN ic.estado ILIKE '%CANCELAD%' OR ic.estado ILIKE '%RECHAZAD%' OR ic.estado ILIKE '%ANULAD%' THEN 'canc'
        WHEN ic.estado = 'PENDIENTE CONFIRMACION' THEN 'pendiente'
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

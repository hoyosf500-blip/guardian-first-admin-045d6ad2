-- KPIs de ecommerce mes a mes — la serie que /logistica → Balance no podía dar.
--
-- Por qué una función NUEVA y no ampliar `balance_mensual`:
--
--   ⛔ REGLA #1. `balance_mensual` recién empezó a funcionar hoy (7e62711, migración
--   20260807020000) y `operativo_mes_cohorte` es su dependencia por LATERAL. Cambiarle
--   el `RETURNS TABLE` a cualquiera de las dos exige un DROP, y un DROP de
--   `operativo_mes_cohorte` tumba `balance_mensual` con ella. Esta función no pisa
--   ninguna de las dos: se agrega al lado y comparte con ellas la misma atribución y
--   la misma regla de precedencia de pauta, para que los números coincidan.
--
-- ATRIBUCIÓN: todo por COHORTE DE PEDIDO. La ventana la define `o.fecha` (cuándo se
-- generó el pedido), NUNCA `m.fecha` (cuándo Dropi pagó). Es la misma decisión que
-- toma `operativo_mes_cohorte` (20260702230717_...:38-48) y la única que reconcilia
-- con el panel de Dropi: sumando `ganancia_dropshipper` por cohorte, julio-2026 en la
-- tienda CO da $10.372.011,58 — el mismo centavo que muestra "Utilidad Total".
--
-- POR QUÉ `ganancia_bruta` VA SEPARADA DE `entradas`: `entradas` mezcla
-- ganancia_dropshipper + ganancia_proveedor + reembolso_flete + indemnizacion. El
-- número que iguala al panel es SOLO `ganancia_dropshipper`. Se devuelven las dos
-- porque miden cosas distintas: `ganancia_bruta` es lo que Dropi PROMETE, `operativo`
-- (entradas − salidas) es lo que efectivamente queda después de los fletes de las
-- devoluciones. El cociente entre ambas es el KPI que el dueño pidió por nombre:
-- "de lo que Dropi me dice, ¿cuánto me tiende a quedar?".
--
-- `devueltos` INCLUYE a los rechazados y `rechazados` viene aparte — misma convención
-- que `logistics_summary` (20260707120000_...:174-175). La vista de plata los suma;
-- la tasa de entrega MADURA los excluye del denominador (un rechazo del cliente no
-- mide a la transportadora). Quien consuma esto debe usar `deriveDeliveryMaturity`
-- de src/lib/logisticsRates.ts, que ya implementa esa distinción — no reimplementarla.
--
-- Las ~17 tasas derivadas (entrega, cancelación, ticket, CPA, contribución, punto de
-- equilibrio, factor de realización) NO se calculan acá: van en TypeScript puro y con
-- test en src/lib/kpisMensuales.ts. Un número derivado en SQL no se puede testear sin
-- red y no se puede corregir sin una migración.

DROP FUNCTION IF EXISTS public.kpis_mensuales(uuid, text, text);

CREATE FUNCTION public.kpis_mensuales(p_store_id uuid, p_desde text, p_hasta text)
RETURNS TABLE(
  year_month         text,
  dias               integer,
  generados          bigint,
  unidades           numeric,
  cancelados         bigint,
  entregados         bigint,
  devueltos          bigint,
  rechazados         bigint,
  en_calle           bigint,
  valor_no_cancelado numeric,
  valor_entregado    numeric,
  valor_en_calle     numeric,
  ganancia_bruta     numeric,
  entradas           numeric,
  salidas            numeric,
  operativo          numeric,
  pauta              numeric,
  admin              numeric,
  retirado           numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_ini date;
  v_fin date;  -- exclusivo: primer día del mes SIGUIENTE al último pedido
  v_hoy date := (now() AT TIME ZONE 'America/Bogota')::date;
BEGIN
  IF NOT public.is_store_manager(p_store_id) THEN
    RAISE EXCEPTION 'Sin permiso sobre esta tienda' USING ERRCODE = '42501';
  END IF;

  IF p_desde !~ '^\d{4}-\d{2}$' OR p_hasta !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'Los meses van como YYYY-MM' USING ERRCODE = '22007';
  END IF;

  v_ini := to_date(p_desde || '-01', 'YYYY-MM-DD');
  v_fin := (to_date(p_hasta || '-01', 'YYYY-MM-DD') + INTERVAL '1 month')::date;
  IF v_fin <= v_ini THEN RETURN; END IF;

  RETURN QUERY
  WITH meses AS (
    SELECT to_char(d, 'YYYY-MM')            AS ym,
           d::date                          AS mes_ini,
           (d + INTERVAL '1 month')::date   AS mes_fin_excl
    FROM generate_series(v_ini, v_fin - 1, INTERVAL '1 month') AS d
  ),
  -- Pedidos de la cohorte. `borrado` (REEMPLAZADA / ARCHIVADO GHOST) fuera: son
  -- soft-deletes, no operación. Ver la nota de _estado_bucket en CLAUDE.md.
  ped AS (
    SELECT to_char(o.fecha::date, 'YYYY-MM') AS ym,
      COUNT(*)::bigint                                                                   AS generados,
      COALESCE(SUM(COALESCE(o.cantidad, 0)), 0)::numeric                                 AS unidades,
      COUNT(*) FILTER (WHERE public._estado_bucket(o.estado) = 'cancelado')::bigint      AS cancelados,
      COUNT(*) FILTER (WHERE public._estado_bucket(o.estado) = 'entregado')::bigint      AS entregados,
      COUNT(*) FILTER (WHERE public._estado_bucket(o.estado) IN ('devuelto','rechazado'))::bigint AS devueltos,
      COUNT(*) FILTER (WHERE public._estado_bucket(o.estado) = 'rechazado')::bigint      AS rechazados,
      COUNT(*) FILTER (WHERE public._estado_bucket(o.estado) IN
        ('pendiente','preparacion','en_transito','novedad','otros'))::bigint             AS en_calle,
      COALESCE(SUM(o.valor) FILTER (WHERE public._estado_bucket(o.estado) <> 'cancelado'), 0)::numeric AS valor_no_cancelado,
      COALESCE(SUM(o.valor) FILTER (WHERE public._estado_bucket(o.estado) =  'entregado'), 0)::numeric AS valor_entregado,
      COALESCE(SUM(o.valor) FILTER (WHERE public._estado_bucket(o.estado) IN
        ('pendiente','preparacion','en_transito','novedad','otros')), 0)::numeric        AS valor_en_calle
    FROM public.orders o
    WHERE o.store_id = p_store_id
      AND o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND o.fecha::date >= v_ini
      AND o.fecha::date <  v_fin
      AND public._estado_bucket(o.estado) <> 'borrado'
    GROUP BY 1
  ),
  -- Billetera cruzada contra el pedido que la originó. INNER JOIN a propósito: los
  -- movimientos sin pedido (mantenimiento de tarjeta, comisiones de referidos de
  -- overhead, retiros) no pertenecen a ninguna cohorte y distorsionarían el mes.
  wal AS (
    SELECT to_char(o.fecha::date, 'YYYY-MM') AS ym,
      COALESCE(SUM(ABS(COALESCE(m.monto, 0))) FILTER (
        WHERE m.categoria = 'ganancia_dropshipper'), 0)::numeric AS ganancia_bruta,
      COALESCE(SUM(ABS(COALESCE(m.monto, 0))) FILTER (WHERE m.categoria IN
        ('ganancia_dropshipper','ganancia_proveedor','reembolso_flete','indemnizacion')), 0)::numeric AS entradas,
      COALESCE(SUM(ABS(COALESCE(m.monto, 0))) FILTER (WHERE m.categoria IN
        ('flete_inicial','costo_devolucion','comision_referidos','mantenimiento_tarjeta','orden_sin_recaudo')), 0)::numeric AS salidas
    FROM public.dropi_wallet_movements m
    JOIN public.orders o
      ON o.external_id = m.related_order_id
     AND o.store_id    = m.store_id
    WHERE m.store_id = p_store_id
      AND o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND o.fecha::date >= v_ini
      AND o.fecha::date <  v_fin
    GROUP BY 1
  ),
  ads AS (
    SELECT to_char(sad.spend_date, 'YYYY-MM') AS ym, SUM(sad.amount)::numeric AS pauta
    FROM public.store_ad_spend_daily sad
    WHERE sad.store_id = p_store_id
    GROUP BY 1
  ),
  costos AS (
    SELECT lmc.year_month AS ym,
           SUM(lmc.costos_admin)::numeric AS admin,
           SUM(COALESCE(lmc.pauta_meta, 0) + COALESCE(lmc.pauta_tiktok, 0))::numeric AS pauta_mensual
    FROM public.logistica_monthly_costs lmc
    WHERE lmc.store_id = p_store_id
    GROUP BY 1
  ),
  ret AS (
    SELECT to_char(w.fecha, 'YYYY-MM') AS ym, SUM(ABS(COALESCE(w.monto, 0)))::numeric AS retirado
    FROM public.dropi_wallet_movements w
    WHERE w.store_id = p_store_id AND w.categoria = 'retiro'
    GROUP BY 1
  )
  SELECT
    m.ym,
    -- Días TRANSCURRIDOS, no días del mes: para el mes en curso el promedio diario
    -- tiene que dividirse por los días que van, o subestima el ritmo real.
    (LEAST(m.mes_fin_excl, v_hoy + 1) - m.mes_ini)::integer,
    COALESCE(p.generados, 0),
    COALESCE(p.unidades, 0),
    COALESCE(p.cancelados, 0),
    COALESCE(p.entregados, 0),
    COALESCE(p.devueltos, 0),
    COALESCE(p.rechazados, 0),
    COALESCE(p.en_calle, 0),
    COALESCE(p.valor_no_cancelado, 0),
    COALESCE(p.valor_entregado, 0),
    COALESCE(p.valor_en_calle, 0),
    COALESCE(w.ganancia_bruta, 0),
    COALESCE(w.entradas, 0),
    COALESCE(w.salidas, 0),
    COALESCE(w.entradas, 0) - COALESCE(w.salidas, 0),
    -- MISMA precedencia que balance_mensual (20260807020000_...:88-90): la pauta
    -- diaria gana sobre la mensual guardada. No inventar una cuarta regla — ya hay
    -- tres distintas en el repo y ese es justamente el problema, no la solución.
    CASE WHEN COALESCE(a.pauta, 0) > 0 THEN a.pauta ELSE COALESCE(c.pauta_mensual, 0) END,
    COALESCE(c.admin, 0),
    COALESCE(r.retirado, 0)
  FROM meses m
  LEFT JOIN ped    p ON p.ym = m.ym
  LEFT JOIN wal    w ON w.ym = m.ym
  LEFT JOIN ads    a ON a.ym = m.ym
  LEFT JOIN costos c ON c.ym = m.ym
  LEFT JOIN ret    r ON r.ym = m.ym
  ORDER BY m.ym;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.kpis_mensuales(uuid, text, text) TO authenticated;

COMMENT ON FUNCTION public.kpis_mensuales(uuid, text, text) IS
  'KPIs de ecommerce por mes y por tienda, atribuidos por cohorte de pedido. '
  'Devuelve materia prima; las tasas derivadas viven en src/lib/kpisMensuales.ts. '
  'ganancia_bruta = lo que el panel de Dropi promete; operativo = lo que queda.';

-- conciliacion_devoluciones_wallet — ¿Dropi me cobró una devolución de un pedido
-- que Guardian no ve como devuelto?
--
-- POR QUÉ EXISTE
-- Guardian tenía DOS fuentes sobre devoluciones que nunca se cruzaban: la
-- billetera (lo que Dropi COBRA, categoría 'costo_devolucion') y `orders` (lo
-- que Guardian VE, bucket 'devuelto'). Cada una se mostraba por separado y
-- ninguna pantalla preguntaba si coincidían. Ese hueco es la única forma de
-- detectar una devolución que existió, se pagó, y el CRM nunca registró.
--
-- Medido el 20-ago-2026 sobre 3 meses: Colombia cuadró perfecto (77 de 77), pero
-- una tienda de Ecuador tenía 83 de 318 cobros sin respaldo — 61 de pedidos que
-- el CRM nunca trajo y 22 de pedidos presentes pero con un estado viejo (no
-- 'devuelto'). Esos 22 son los caros: el pedido figura vivo o entregado e INFLA
-- la tasa de entrega mientras Dropi ya cobró la devolución.
--
-- DEVUELVE FILAS CRUDAS, NO AGREGADOS — misma decisión que cancelaciones_analisis
-- (20260815120000) y kpis_mensuales (20260807160000): la clasificación y los
-- totales viven en TS puro y testeado (src/lib/conciliacionDevoluciones.ts), que
-- se puede corregir sin una migración y se ejercita sin red. Acá sí viaja
-- `bucket_guardian` calculado por `_estado_bucket`, porque el veredicto
-- "¿cuenta como devuelto?" TIENE que ser el mismo que usan las métricas de
-- plata; derivarlo por separado en el cliente sería justamente crear una
-- segunda verdad.
--
-- ⛔ REGLA #1: función NUEVA. No reescribe ni toca `financial_summary`,
-- `wallet_summary`, `wallet_ganancia_neta` ni `devoluciones_del_periodo`. Se
-- agrega al lado.
--
-- EL JOIN, y por qué es por external_id
-- `dropi_wallet_movements.related_order_id` es el id de la orden en Dropi, que
-- el sync guarda en `orders.external_id`. Se exige TAMBIÉN igualdad de store_id:
-- los ids de Dropi son por plataforma de país y pueden chocar entre tiendas —
-- cruzar sin esa condición mezclaría países, que en esta operación está
-- prohibido.
--
-- AMBIGÜEDAD 42702 (lección de 20260807020000_fix_balance_mensual): los nombres
-- del RETURNS TABLE son variables de salida dentro del cuerpo, y varios
-- (external_id, monto, producto, ciudad, estado_guardian) chocan con columnas
-- reales. Por eso el CTE renombra TODO con prefijo `c_` y no queda ninguna
-- referencia desnuda.

DROP FUNCTION IF EXISTS public.conciliacion_devoluciones_wallet(uuid, date, date, integer);

CREATE FUNCTION public.conciliacion_devoluciones_wallet(
  p_store_id uuid,
  p_desde    date,
  p_hasta    date,
  p_limite   integer DEFAULT 3000
)
RETURNS TABLE(
  movimiento_id    bigint,
  fecha_cobro      timestamptz,
  monto            numeric,
  external_id      text,
  order_id         uuid,
  estado_guardian  text,
  bucket_guardian  text,
  producto         text,
  ciudad           text,
  fecha_pedido     text,
  total_periodo    bigint,
  plata_periodo    numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_lim integer := LEAST(GREATEST(COALESCE(p_limite, 3000), 1), 5000);
BEGIN
  -- Encargados de ESA tienda. Lleva montos: no es vista de operadora.
  -- Mismo chokepoint que cancelaciones_analisis / kpis_mensuales.
  IF NOT public.is_store_manager(p_store_id) THEN
    RAISE EXCEPTION 'Sin permiso sobre esta tienda' USING ERRCODE = '42501';
  END IF;

  IF p_desde IS NULL OR p_hasta IS NULL OR p_hasta < p_desde THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH cobros AS (
    SELECT
      m.id                        AS c_mov_id,
      m.fecha                     AS c_fecha_cobro,
      ABS(COALESCE(m.monto, 0))   AS c_monto,
      NULLIF(btrim(COALESCE(m.related_order_id, '')), '') AS c_ext
    FROM public.dropi_wallet_movements m
    WHERE m.store_id = p_store_id
      AND m.categoria = 'costo_devolucion'
      -- El corte es por FECHA DE COBRO (cuándo golpeó la billetera), no por
      -- cohorte del pedido: la pregunta es "de lo que me cobraron en este
      -- rango, ¿qué respaldo tengo?".
      AND m.fecha >= p_desde::timestamptz
      AND m.fecha <  (p_hasta + 1)::timestamptz
  ),
  -- Totales REALES antes del LIMIT: viajan repetidos en cada fila para que la
  -- UI diga "mostrando N de M" y nunca trunque en silencio.
  tot AS (
    SELECT COUNT(*)::bigint AS c_total, COALESCE(SUM(c_monto), 0) AS c_plata
    FROM cobros
  )
  SELECT
    c.c_mov_id,
    c.c_fecha_cobro,
    c.c_monto,
    c.c_ext,
    o.id,
    o.estado,
    -- NULL cuando el pedido no existe: "no sé" y "no es devolución" son cosas
    -- distintas y el cliente las muestra distinto.
    CASE WHEN o.id IS NULL THEN NULL ELSE public._estado_bucket(o.estado) END,
    o.producto,
    o.ciudad,
    o.fecha,
    t.c_total,
    t.c_plata
  FROM cobros c
  CROSS JOIN tot t
  LEFT JOIN public.orders o
         ON o.external_id = c.c_ext
        AND o.store_id    = p_store_id
  -- Los problemas primero y, dentro de ellos, la plata más grande arriba: si
  -- alguna vez se trunca, lo que sobrevive es lo que más cuesta.
  ORDER BY
    (o.id IS NULL OR public._estado_bucket(o.estado) <> 'devuelto') DESC,
    c.c_monto DESC,
    c.c_fecha_cobro DESC
  LIMIT v_lim;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.conciliacion_devoluciones_wallet(uuid, date, date, integer) TO authenticated;

COMMENT ON FUNCTION public.conciliacion_devoluciones_wallet(uuid, date, date, integer) IS
  'Una fila por cobro de devolucion (dropi_wallet_movements.categoria = '
  'costo_devolucion) del rango, cruzado con el pedido por external_id + store_id. '
  'Responde "Dropi me cobro N devoluciones, Guardian ve M". bucket_guardian NULL = '
  'el pedido no existe en el CRM; distinto de bucket <> devuelto = existe con '
  'estado desactualizado (ese INFLA la tasa de entrega). El corte es por fecha de '
  'COBRO, no por cohorte del pedido. total_periodo/plata_periodo traen los valores '
  'reales previos al LIMIT: nunca truncar en silencio. La clasificacion vive en '
  'src/lib/conciliacionDevoluciones.ts.';

-- Apoyo para el filtro (tienda + categoría + fecha) de esta función. Aditivo e
-- idempotente. La tabla ya tiene índices por fecha y por categoría sueltos; este
-- es el compuesto que usa la conciliación.
-- OJO: sin CONCURRENTLY (supabase db push corre en transacción) toma un lock
-- breve de escritura sobre dropi_wallet_movements. Aplicar fuera del horario de
-- la operadora.
CREATE INDEX IF NOT EXISTS idx_wallet_store_categoria_fecha
  ON public.dropi_wallet_movements (store_id, categoria, fecha DESC);

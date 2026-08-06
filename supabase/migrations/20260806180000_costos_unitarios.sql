-- ============================================================================
-- costos_unitarios — cuánto cuesta REALMENTE una entrega y cuánto una devolución.
--
-- POR QUÉ EXISTE
-- El dueño preguntó "cuál es mi flete promedio" y la respuesta honesta necesitaba
-- tres números que Guardian tenía sueltos o no tenía:
--
--   1. Flete NOMINAL por entrega — lo que factura la transportadora. Ya lo daba
--      `logistics_cost_basis`, pero ninguna pantalla lo mostraba.
--   2. Flete REAL por entrega — el anterior MÁS el flete de los pedidos que se
--      devolvieron, que también se pagó. Medido en Colombia (may-jul 2026): el
--      nominal ronda los $22.600 y es estable, pero el real fue $34.349 / $31.548
--      / $29.603. Entre $7.000 y $11.500 más por entrega, y no lo veía nadie.
--   3. Cargo por devolución — Dropi cobra un cargo APARTE del flete cuando el
--      pedido no llega. No está en `orders`: vive en la billetera como
--      `categoria='costo_devolucion'`.
--
-- POR QUÉ DEVUELVE `devoluciones_con_cargo`
-- El cargo se factura semanas después de la devolución, así que en cualquier mes
-- reciente hay devoluciones todavía sin cobrar. Verificado contra la API de Dropi
-- (julio 2026, EC): de 234 devoluciones solo 39 tenían su cargo emitido, y los 39
-- estaban los 39 en Guardian — no faltaban datos, faltaba que Dropi facturara.
--
-- Un AVG sobre esa fracción parece medido y no lo está. Por eso la función
-- devuelve el conteo al lado del promedio: la UI puede decir "39 de 234 ya
-- cobradas" y atenuar la cifra, en vez de presentar una parte con cara de total.
-- Mismo principio que la tasa preliminar. Y la lectura correcta cuando la
-- cobertura es baja NO es "se perdieron datos" sino "este costo todavía va a
-- subir".
--
-- NO se toca `logistics_cost_basis` ni ninguna función existente: esto es una
-- función NUEVA (regla #1 — el repo va atrás de lo desplegado).
--
-- Montos en la moneda de la tienda (COP en CO, USD en EC).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.costos_unitarios(
  p_from_date date,
  p_to_date   date,
  p_ciudad    text DEFAULT NULL
)
RETURNS TABLE(
  entregados                bigint,
  devueltos                 bigint,
  ingresos_entregados       numeric,
  cogs_entregados           numeric,
  flete_entregados          numeric,
  flete_devueltos           numeric,
  -- Cargo de devolución que Dropi cobró en el período, desde la billetera.
  cargo_devolucion_total    numeric,
  -- Sobre CUÁNTAS devoluciones se midió ese cargo. Si es mucho menor que
  -- `devueltos`, la billetera está incompleta y el promedio NO es confiable.
  devoluciones_con_cargo    bigint,
  pauta_periodo             numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_store uuid;
BEGIN
  -- Mismo gate que el resto de /logistica: owner o supervisor de la tienda.
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;

  RETURN QUERY
  WITH pedidos AS (
    SELECT public._estado_bucket(o.estado) AS b, o.valor, o.costo_prod, o.flete
    FROM public.orders o
    WHERE o.store_id = v_store
      AND o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND o.fecha::date BETWEEN p_from_date AND p_to_date
      AND (p_ciudad IS NULL OR o.ciudad = p_ciudad)
      AND public._estado_bucket(o.estado) <> 'borrado'
  ),
  cargos AS (
    -- ATRIBUCIÓN POR COHORTE DE PEDIDO, no por fecha de movimiento.
    --
    -- Dropi cobra el cargo de devolución cuando el paquete vuelve físicamente al
    -- origen, semanas después de que el pedido se marcó devuelto. Filtrar por
    -- fecha del MOVIMIENTO y compararlo contra devoluciones por fecha del PEDIDO
    -- mezcla dos poblaciones distintas: en julio 2026 (EC) daba 40 cargos contra
    -- 234 devoluciones, y eso se leía como "a la billetera le faltan 9 de cada
    -- 10 cargos" cuando la billetera estaba perfecta — se verificó bajando los
    -- 721 movimientos del mes desde la API de Dropi: 39 cargos, los mismos.
    -- Dropi simplemente todavía no había facturado el resto.
    --
    -- Con el JOIN por `related_order_id` la cobertura pasa a significar lo que
    -- tiene que significar: de las devoluciones DE ESTE PERÍODO, cuántas ya
    -- fueron cobradas. Sigue siendo baja en meses recientes, pero ahora eso dice
    -- "falta que Dropi facture" (el costo real va a SUBIR) y no "se perdieron
    -- datos". Misma atribución que operativo_mes_cohorte.
    SELECT COALESCE(SUM(w.monto), 0)::numeric AS total,
           COUNT(*)::bigint                   AS n
    FROM public.dropi_wallet_movements w
    JOIN public.orders o
      ON o.external_id = w.related_order_id
     AND o.store_id    = w.store_id
    WHERE w.store_id = v_store
      AND w.categoria = 'costo_devolucion'
      AND o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND o.fecha::date BETWEEN p_from_date AND p_to_date
      AND (p_ciudad IS NULL OR o.ciudad = p_ciudad)
  ),
  ads AS (
    SELECT COALESCE(SUM(amount), 0)::numeric AS total
    FROM public.store_ad_spend_daily
    WHERE store_id = v_store
      AND spend_date BETWEEN p_from_date AND p_to_date
  )
  SELECT
    COUNT(*) FILTER (WHERE b = 'entregado')::bigint,
    COUNT(*) FILTER (WHERE b = 'devuelto')::bigint,
    COALESCE(SUM(valor)      FILTER (WHERE b = 'entregado'), 0)::numeric,
    COALESCE(SUM(costo_prod) FILTER (WHERE b = 'entregado'), 0)::numeric,
    COALESCE(SUM(flete)      FILTER (WHERE b = 'entregado'), 0)::numeric,
    -- El flete de los DEVUELTOS es la pieza que faltaba: se pagó igual y no
    -- aparecía en ningún costo.
    COALESCE(SUM(flete)      FILTER (WHERE b = 'devuelto'), 0)::numeric,
    (SELECT total FROM cargos),
    (SELECT n     FROM cargos),
    (SELECT total FROM ads)
  FROM pedidos;
END;
$$;

GRANT EXECUTE ON FUNCTION public.costos_unitarios(date, date, text) TO authenticated;

NOTIFY pgrst, 'reload schema';

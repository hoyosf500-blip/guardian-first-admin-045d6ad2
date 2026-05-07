-- ─────────────────────────────────────────────────────────────────
-- T2-3: product_profitability v2 — costo real de devolución desde wallet
-- ─────────────────────────────────────────────────────────────────
-- WHY: orders.costo_dev viene de Dropi.discounted_amount que es ~0 siempre.
-- El costo REAL de una devolución (~$22k típico) está en
-- dropi_wallet_movements con categoria='costo_devolucion'.
--
-- Estrategia híbrida:
--   1) Si el movimiento del wallet tiene related_order_id → atribuir directo
--      al producto de esa orden.
--   2) Si NO tiene related_order_id (frecuente — Dropi no siempre lo manda),
--      prorratear el total restante entre productos según el número de
--      devoluciones del producto en el rango.
--
-- Ejemplo numérico (antes vs después) — producto "Termo X" en mayo 2026:
--   Datos: 100 entregados, 20 devueltos, ingresos 6.000.000, costo_prod
--   3.000.000, flete entregadas 600.000.
--   Wallet costo_devolucion del rango: 30 movs * $22.000 = $660.000;
--   de esos, 12 vienen con related_order_id que mapea al Termo X
--   (12 * 22.000 = $264.000); los otros 18 sin order_id se prorratean
--   entre productos según devoluciones: si en total hubo 50 devoluciones
--   en el rango y Termo X tuvo 20 → (20/50) * (18*22.000) = $158.400.
--   Total costo_devolucion_real Termo X = 264.000 + 158.400 = $422.400.
--
--   ANTES (orders.costo_dev): SUM ~ 0 → utilidad_real = 6M − 3M − 600k − 0 = 2.400.000
--   DESPUÉS:                  utilidad_real = 6M − 3M − 600k − 422.400 = 1.977.600
--   Diferencia: −$422k (utilidad real más baja, refleja la realidad).

CREATE OR REPLACE FUNCTION public.product_profitability(
  p_from_date DATE,
  p_to_date   DATE,
  p_limit     INTEGER DEFAULT 100
)
RETURNS TABLE (
  producto                  TEXT,
  total_pedidos             BIGINT,
  entregados                BIGINT,
  devueltos                 BIGINT,
  cancelados                BIGINT,
  en_transito               BIGINT,
  ingresos_entregados       NUMERIC,
  costo_prod_entregados     NUMERIC,
  flete_inicial_entregados  NUMERIC,
  costo_devolucion_total    NUMERIC,
  utilidad_real             NUMERIC,
  utilidad_proyectada       NUMERIC,
  tasa_entrega              NUMERIC,
  tasa_devolucion           NUMERIC,
  tasa_cancelacion          NUMERIC,
  ticket_promedio           NUMERIC,
  margen_pct                NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH agg AS (
    SELECT
      o.producto::TEXT AS producto,
      COUNT(*) AS total_pedidos,
      COUNT(*) FILTER (WHERE UPPER(o.estado) = 'ENTREGADO') AS entregados,
      COUNT(*) FILTER (WHERE UPPER(o.estado) IN
        ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')) AS devueltos,
      COUNT(*) FILTER (WHERE UPPER(COALESCE(o.estado,'')) LIKE '%CANCEL%') AS cancelados,
      COUNT(*) FILTER (WHERE UPPER(o.estado) NOT IN
        ('ENTREGADO', 'DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')
        AND UPPER(COALESCE(o.estado,'')) NOT LIKE '%CANCEL%') AS en_transito,
      COALESCE(SUM(o.valor) FILTER (WHERE UPPER(o.estado) = 'ENTREGADO'), 0) AS ingresos_entregados,
      COALESCE(SUM(o.costo_prod) FILTER (WHERE UPPER(o.estado) = 'ENTREGADO'), 0) AS costo_prod_entregados,
      COALESCE(SUM(o.flete) FILTER (WHERE UPPER(o.estado) = 'ENTREGADO'), 0) AS flete_inicial_entregados
    FROM public.orders o
    WHERE o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND o.fecha::date BETWEEN p_from_date AND p_to_date
      AND o.producto IS NOT NULL
      AND o.producto <> ''
    GROUP BY o.producto
  ),
  -- Costo de devolución atribuido directamente vía related_order_id.
  -- Map external_id -> producto del orders en el rango.
  wallet_attributed AS (
    SELECT
      o.producto::TEXT AS producto,
      COALESCE(SUM(ABS(w.monto)), 0)::NUMERIC AS costo_attr
    FROM public.dropi_wallet_movements w
    JOIN public.orders o
      ON o.external_id IS NOT NULL
     AND w.related_order_id = o.external_id
    WHERE w.categoria = 'costo_devolucion'
      AND (w.fecha AT TIME ZONE 'America/Bogota')::date BETWEEN p_from_date AND p_to_date
      AND o.producto IS NOT NULL AND o.producto <> ''
    GROUP BY o.producto
  ),
  wallet_unattributed_total AS (
    SELECT COALESCE(SUM(ABS(w.monto)), 0)::NUMERIC AS total_unattr
    FROM public.dropi_wallet_movements w
    WHERE w.categoria = 'costo_devolucion'
      AND (w.fecha AT TIME ZONE 'America/Bogota')::date BETWEEN p_from_date AND p_to_date
      AND (
        w.related_order_id IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM public.orders o2
          WHERE o2.external_id = w.related_order_id
            AND o2.producto IS NOT NULL AND o2.producto <> ''
        )
      )
  ),
  total_devueltos AS (
    SELECT COALESCE(SUM(devueltos), 0)::NUMERIC AS total_dev FROM agg
  ),
  costo_dev_blended AS (
    -- Híbrido: atribuido directo + prorrateo proporcional (devueltos del producto / total devueltos)
    SELECT
      a.producto,
      COALESCE(wa.costo_attr, 0)
        + CASE
            WHEN (SELECT total_dev FROM total_devueltos) > 0
            THEN (a.devueltos::NUMERIC / (SELECT total_dev FROM total_devueltos))
                 * (SELECT total_unattr FROM wallet_unattributed_total)
            ELSE 0
          END AS costo_devolucion_real
    FROM agg a
    LEFT JOIN wallet_attributed wa ON wa.producto = a.producto
  ),
  with_calc AS (
    SELECT
      a.*,
      cdb.costo_devolucion_real AS costo_devolucion_total,
      (a.ingresos_entregados - a.costo_prod_entregados - a.flete_inicial_entregados - cdb.costo_devolucion_real)
        AS utilidad_real_calc,
      CASE WHEN a.entregados > 0
        THEN (a.ingresos_entregados - a.costo_prod_entregados - a.flete_inicial_entregados) / a.entregados
        ELSE 0
      END AS utilidad_prom_entrega,
      CASE WHEN a.devueltos > 0
        THEN cdb.costo_devolucion_real / a.devueltos
        ELSE 0
      END AS costo_prom_devolucion,
      CASE WHEN (a.entregados + a.devueltos + a.en_transito) > 0
        THEN a.entregados::NUMERIC / (a.entregados + a.devueltos + a.en_transito)
        ELSE 0
      END AS p_entrega,
      CASE WHEN (a.entregados + a.devueltos + a.en_transito) > 0
        THEN a.devueltos::NUMERIC / (a.entregados + a.devueltos + a.en_transito)
        ELSE 0
      END AS p_devolucion
    FROM agg a
    LEFT JOIN costo_dev_blended cdb ON cdb.producto = a.producto
  )
  SELECT
    wc.producto,
    wc.total_pedidos,
    wc.entregados,
    wc.devueltos,
    wc.cancelados,
    wc.en_transito,
    wc.ingresos_entregados,
    wc.costo_prod_entregados,
    wc.flete_inicial_entregados,
    ROUND(wc.costo_devolucion_total::NUMERIC, 0) AS costo_devolucion_total,
    ROUND(wc.utilidad_real_calc::NUMERIC, 0) AS utilidad_real,
    ROUND(
      (wc.utilidad_real_calc
        + wc.en_transito * wc.p_entrega * wc.utilidad_prom_entrega
        - wc.en_transito * wc.p_devolucion * wc.costo_prom_devolucion
      )::NUMERIC, 0
    ) AS utilidad_proyectada,
    ROUND(wc.p_entrega * 100, 2) AS tasa_entrega,
    ROUND(wc.p_devolucion * 100, 2) AS tasa_devolucion,
    CASE WHEN wc.total_pedidos > 0
      THEN ROUND(wc.cancelados::NUMERIC * 100 / wc.total_pedidos, 2)
      ELSE 0 END AS tasa_cancelacion,
    CASE WHEN wc.entregados > 0
      THEN ROUND(wc.ingresos_entregados / wc.entregados, 0)
      ELSE 0 END AS ticket_promedio,
    CASE WHEN wc.ingresos_entregados > 0
      THEN ROUND(wc.utilidad_real_calc * 100 / wc.ingresos_entregados, 2)
      ELSE 0 END AS margen_pct
  FROM with_calc wc
  ORDER BY wc.utilidad_real_calc DESC
  LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION public.product_profitability(DATE, DATE, INTEGER) TO authenticated;

-- ─────────────────────────────────────────────────────────────────
-- T2-4: logistics_* exclude CANCELADO LOCALMENTE too
-- ─────────────────────────────────────────────────────────────────
-- WHY: filtros UPPER(estado) <> 'CANCELADO' solo excluyen exact-match.
-- 'CANCELADO LOCALMENTE' (creado por confirm_order_locally) quedaba
-- dentro del denominador y suavizaba KPIs. Cambio a NOT LIKE '%CANCEL%'.

CREATE OR REPLACE FUNCTION public.logistics_summary(
  p_from_date DATE,
  p_to_date   DATE
)
RETURNS TABLE (
  total_pedidos    BIGINT,
  entregados       BIGINT,
  devueltos        BIGINT,
  en_transito      BIGINT,
  tasa_entrega     NUMERIC,
  tasa_devolucion  NUMERIC,
  valor_entregado  NUMERIC,
  valor_perdido    NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT estado, valor
    FROM public.orders
    WHERE fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND fecha::date BETWEEN p_from_date AND p_to_date
      AND UPPER(COALESCE(estado, '')) NOT LIKE '%CANCEL%'
  )
  SELECT
    COUNT(*) AS total_pedidos,
    COUNT(*) FILTER (WHERE UPPER(estado) = 'ENTREGADO') AS entregados,
    COUNT(*) FILTER (WHERE UPPER(estado) IN
      ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')) AS devueltos,
    COUNT(*) FILTER (WHERE UPPER(estado) IN
      ('EN TRANSPORTE', 'EN DESPACHO', 'EN TRASLADO NACIONAL',
       'EN TERMINAL ORIGEN', 'EN TERMINAL DESTINO',
       'EN REPARTO', 'EN DISTRIBUCION', 'EN REEXPEDICION',
       'TELEMERCADEO', 'REENVIO', 'REENVÍO',
       'EN BODEGA TRANSPORTADORA', 'ADMITIDA',
       'EN BODEGA DROPI', 'RECOGIDO POR DROPI')) AS en_transito,
    ROUND(
      (COUNT(*) FILTER (WHERE UPPER(estado) = 'ENTREGADO'))::NUMERIC * 100.0
      / NULLIF(COUNT(*), 0), 2) AS tasa_entrega,
    ROUND(
      (COUNT(*) FILTER (WHERE UPPER(estado) IN
        ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')))::NUMERIC * 100.0
      / NULLIF(COUNT(*), 0), 2) AS tasa_devolucion,
    COALESCE(SUM(valor) FILTER (WHERE UPPER(estado) = 'ENTREGADO'), 0) AS valor_entregado,
    COALESCE(SUM(valor) FILTER (WHERE UPPER(estado) IN
      ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')), 0) AS valor_perdido
  FROM base;
END;
$$;

GRANT EXECUTE ON FUNCTION public.logistics_summary(DATE, DATE) TO authenticated;

CREATE OR REPLACE FUNCTION public.logistics_by_carrier(
  p_from_date    DATE,
  p_to_date      DATE
)
RETURNS TABLE (
  transportadora   TEXT,
  total_pedidos    BIGINT,
  entregados       BIGINT,
  devueltos        BIGINT,
  en_transito      BIGINT,
  novedades        BIGINT,
  tasa_entrega     NUMERIC,
  tasa_devolucion  NUMERIC,
  valor_entregado  NUMERIC,
  valor_perdido    NUMERIC,
  avg_dias_entrega NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    o.transportadora::TEXT,
    COUNT(*) AS total_pedidos,
    COUNT(*) FILTER (WHERE UPPER(o.estado) = 'ENTREGADO') AS entregados,
    COUNT(*) FILTER (WHERE UPPER(o.estado) IN
      ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')) AS devueltos,
    COUNT(*) FILTER (WHERE UPPER(o.estado) IN
      ('EN TRANSPORTE', 'EN DESPACHO', 'EN TRASLADO NACIONAL',
       'EN TERMINAL ORIGEN', 'EN TERMINAL DESTINO',
       'EN REPARTO', 'EN DISTRIBUCION', 'EN REEXPEDICION',
       'TELEMERCADEO', 'REENVIO', 'REENVÍO')) AS en_transito,
    COUNT(*) FILTER (WHERE UPPER(o.estado) IN
      ('NOVEDAD', 'INTENTO DE ENTREGA')) AS novedades,
    ROUND((COUNT(*) FILTER (WHERE UPPER(o.estado) = 'ENTREGADO'))::NUMERIC * 100.0
          / NULLIF(COUNT(*), 0), 2) AS tasa_entrega,
    ROUND((COUNT(*) FILTER (WHERE UPPER(o.estado) IN
      ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')))::NUMERIC * 100.0
      / NULLIF(COUNT(*), 0), 2) AS tasa_devolucion,
    COALESCE(SUM(o.valor) FILTER (WHERE UPPER(o.estado) = 'ENTREGADO'), 0) AS valor_entregado,
    COALESCE(SUM(o.valor) FILTER (WHERE UPPER(o.estado) IN
      ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')), 0) AS valor_perdido,
    ROUND(AVG(o.dias_conf) FILTER (WHERE UPPER(o.estado) = 'ENTREGADO'), 1) AS avg_dias_entrega
  FROM public.orders o
  WHERE o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
    AND o.fecha::date BETWEEN p_from_date AND p_to_date
    AND o.transportadora IS NOT NULL
    AND o.transportadora <> ''
    AND UPPER(COALESCE(o.estado, '')) NOT LIKE '%CANCEL%'
  GROUP BY o.transportadora
  ORDER BY entregados DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.logistics_by_carrier(DATE, DATE) TO authenticated;

CREATE OR REPLACE FUNCTION public.logistics_by_city(
  p_from_date    DATE,
  p_to_date      DATE,
  p_limit        INTEGER DEFAULT 50
)
RETURNS TABLE (
  ciudad           TEXT,
  departamento     TEXT,
  total_pedidos    BIGINT,
  entregados       BIGINT,
  devueltos        BIGINT,
  tasa_devolucion  NUMERIC,
  tasa_entrega     NUMERIC,
  valor_perdido    NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    o.ciudad::TEXT,
    COALESCE(o.departamento, '')::TEXT AS departamento,
    COUNT(*) AS total_pedidos,
    COUNT(*) FILTER (WHERE UPPER(o.estado) = 'ENTREGADO') AS entregados,
    COUNT(*) FILTER (WHERE UPPER(o.estado) IN
      ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')) AS devueltos,
    ROUND((COUNT(*) FILTER (WHERE UPPER(o.estado) IN
      ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')))::NUMERIC * 100.0
      / NULLIF(COUNT(*), 0), 2) AS tasa_devolucion,
    ROUND((COUNT(*) FILTER (WHERE UPPER(o.estado) = 'ENTREGADO'))::NUMERIC * 100.0
      / NULLIF(COUNT(*), 0), 2) AS tasa_entrega,
    COALESCE(SUM(o.valor) FILTER (WHERE UPPER(o.estado) IN
      ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')), 0) AS valor_perdido
  FROM public.orders o
  WHERE o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
    AND o.fecha::date BETWEEN p_from_date AND p_to_date
    AND o.ciudad IS NOT NULL
    AND o.ciudad <> ''
    AND UPPER(COALESCE(o.estado, '')) NOT LIKE '%CANCEL%'
  GROUP BY o.ciudad, COALESCE(o.departamento, '')
  ORDER BY tasa_devolucion DESC, total_pedidos DESC
  LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION public.logistics_by_city(DATE, DATE, INTEGER) TO authenticated;

CREATE OR REPLACE FUNCTION public.logistics_by_product(
  p_from_date    DATE,
  p_to_date      DATE,
  p_limit        INTEGER DEFAULT 50
)
RETURNS TABLE (
  producto         TEXT,
  total_pedidos    BIGINT,
  entregados       BIGINT,
  devueltos        BIGINT,
  tasa_entrega     NUMERIC,
  tasa_devolucion  NUMERIC,
  valor_entregado  NUMERIC,
  valor_perdido    NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    o.producto::TEXT,
    COUNT(*) AS total_pedidos,
    COUNT(*) FILTER (WHERE UPPER(o.estado) = 'ENTREGADO') AS entregados,
    COUNT(*) FILTER (WHERE UPPER(o.estado) IN
      ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')) AS devueltos,
    ROUND((COUNT(*) FILTER (WHERE UPPER(o.estado) = 'ENTREGADO'))::NUMERIC * 100.0
      / NULLIF(COUNT(*), 0), 2) AS tasa_entrega,
    ROUND((COUNT(*) FILTER (WHERE UPPER(o.estado) IN
      ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')))::NUMERIC * 100.0
      / NULLIF(COUNT(*), 0), 2) AS tasa_devolucion,
    COALESCE(SUM(o.valor) FILTER (WHERE UPPER(o.estado) = 'ENTREGADO'), 0) AS valor_entregado,
    COALESCE(SUM(o.valor) FILTER (WHERE UPPER(o.estado) IN
      ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')), 0) AS valor_perdido
  FROM public.orders o
  WHERE o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
    AND o.fecha::date BETWEEN p_from_date AND p_to_date
    AND o.producto IS NOT NULL
    AND o.producto <> ''
    AND UPPER(COALESCE(o.estado, '')) NOT LIKE '%CANCEL%'
  GROUP BY o.producto
  ORDER BY tasa_entrega ASC, total_pedidos DESC
  LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION public.logistics_by_product(DATE, DATE, INTEGER) TO authenticated;
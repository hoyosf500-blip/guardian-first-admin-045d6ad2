-- Logística v2 — Filtro por ciudad + Recomendador de transportadoras
--
-- Cambios:
--   1. logistics_summary y logistics_by_carrier aceptan p_ciudad opcional
--   2. NUEVO logistics_by_city_carrier (matriz transportadora × ciudad)
--   3. NUEVO logistics_recommendations (mejor/peor carrier por ciudad)
--   4. NUEVO get_top_cities (autocomplete del filtro)
--
-- Aplicar con `supabase db push`. Idempotente (DROP + CREATE).

-- ─────────────────────────────────────────────────────────────────
-- 1. logistics_summary v4 — añade p_ciudad opcional
-- ─────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.logistics_summary(DATE, DATE);
DROP FUNCTION IF EXISTS public.logistics_summary(DATE, DATE, TEXT);

CREATE OR REPLACE FUNCTION public.logistics_summary(
  p_from_date DATE,
  p_to_date   DATE,
  p_ciudad    TEXT DEFAULT NULL
)
RETURNS TABLE (
  total_pedidos             BIGINT,
  entregados                BIGINT,
  devueltos                 BIGINT,
  en_transito               BIGINT,
  tasa_entrega              NUMERIC,
  tasa_devolucion           NUMERIC,
  valor_entregado           NUMERIC,
  valor_perdido             NUMERIC,
  valor_en_transito         NUMERIC,
  pendientes_sin_despachar  BIGINT,
  pendientes_por_confirmar  BIGINT,
  valor_pendientes          NUMERIC,
  cancelados                BIGINT,
  valor_cancelado           NUMERIC,
  novedades                 BIGINT,
  valor_novedades           NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $func$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH all_orders AS (
    SELECT estado, valor
    FROM public.orders
    WHERE fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND fecha::date BETWEEN p_from_date AND p_to_date
      AND (p_ciudad IS NULL OR ciudad = p_ciudad)
  )
  SELECT
    COUNT(*) FILTER (WHERE UPPER(estado) <> 'CANCELADO') AS total_pedidos,
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
      / NULLIF(COUNT(*) FILTER (WHERE UPPER(estado) <> 'CANCELADO'), 0),
      2
    ) AS tasa_entrega,
    ROUND(
      (COUNT(*) FILTER (WHERE UPPER(estado) IN
        ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')))::NUMERIC * 100.0
      / NULLIF(COUNT(*) FILTER (WHERE UPPER(estado) <> 'CANCELADO'), 0),
      2
    ) AS tasa_devolucion,
    COALESCE(SUM(valor) FILTER (WHERE UPPER(estado) = 'ENTREGADO'), 0) AS valor_entregado,
    COALESCE(SUM(valor) FILTER (WHERE UPPER(estado) IN
      ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')), 0) AS valor_perdido,
    COALESCE(SUM(valor) FILTER (WHERE UPPER(estado) IN
      ('EN TRANSPORTE', 'EN DESPACHO', 'EN TRASLADO NACIONAL',
       'EN TERMINAL ORIGEN', 'EN TERMINAL DESTINO',
       'EN REPARTO', 'EN DISTRIBUCION', 'EN REEXPEDICION',
       'TELEMERCADEO', 'REENVIO', 'REENVÍO',
       'EN BODEGA TRANSPORTADORA', 'ADMITIDA',
       'EN BODEGA DROPI', 'RECOGIDO POR DROPI')), 0) AS valor_en_transito,
    COUNT(*) FILTER (WHERE UPPER(estado) = 'PENDIENTE') AS pendientes_sin_despachar,
    COUNT(*) FILTER (WHERE UPPER(estado) = 'PENDIENTE CONFIRMACION') AS pendientes_por_confirmar,
    COALESCE(SUM(valor) FILTER (WHERE UPPER(estado) IN
      ('PENDIENTE', 'PENDIENTE CONFIRMACION')), 0) AS valor_pendientes,
    COUNT(*) FILTER (WHERE UPPER(estado) = 'CANCELADO') AS cancelados,
    COALESCE(SUM(valor) FILTER (WHERE UPPER(estado) = 'CANCELADO'), 0) AS valor_cancelado,
    COUNT(*) FILTER (WHERE UPPER(estado) IN
      ('NOVEDAD', 'INTENTO DE ENTREGA', 'NOVEDAD SOLUCIONADA')) AS novedades,
    COALESCE(SUM(valor) FILTER (WHERE UPPER(estado) IN
      ('NOVEDAD', 'INTENTO DE ENTREGA', 'NOVEDAD SOLUCIONADA')), 0) AS valor_novedades
  FROM all_orders;
END;
$func$;

GRANT EXECUTE ON FUNCTION public.logistics_summary(DATE, DATE, TEXT) TO authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 2. logistics_by_carrier v2 — añade p_ciudad opcional
-- ─────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.logistics_by_carrier(DATE, DATE);
DROP FUNCTION IF EXISTS public.logistics_by_carrier(DATE, DATE, TEXT);

CREATE OR REPLACE FUNCTION public.logistics_by_carrier(
  p_from_date DATE,
  p_to_date   DATE,
  p_ciudad    TEXT DEFAULT NULL
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
AS $func$
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
    ROUND(
      (COUNT(*) FILTER (WHERE UPPER(o.estado) = 'ENTREGADO'))::NUMERIC * 100.0
      / NULLIF(COUNT(*), 0),
      2
    ) AS tasa_entrega,
    ROUND(
      (COUNT(*) FILTER (WHERE UPPER(o.estado) IN
        ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')))::NUMERIC * 100.0
      / NULLIF(COUNT(*), 0),
      2
    ) AS tasa_devolucion,
    COALESCE(SUM(o.valor) FILTER (WHERE UPPER(o.estado) = 'ENTREGADO'), 0) AS valor_entregado,
    COALESCE(SUM(o.valor) FILTER (WHERE UPPER(o.estado) IN
      ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')), 0) AS valor_perdido,
    ROUND(AVG(o.dias_conf) FILTER (WHERE UPPER(o.estado) = 'ENTREGADO'), 1) AS avg_dias_entrega
  FROM public.orders o
  WHERE o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
    AND o.fecha::date BETWEEN p_from_date AND p_to_date
    AND o.transportadora IS NOT NULL
    AND o.transportadora <> ''
    AND UPPER(o.estado) <> 'CANCELADO'
    AND (p_ciudad IS NULL OR o.ciudad = p_ciudad)
  GROUP BY o.transportadora
  ORDER BY entregados DESC;
END;
$func$;

GRANT EXECUTE ON FUNCTION public.logistics_by_carrier(DATE, DATE, TEXT) TO authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 3. logistics_by_city_carrier — matriz ciudad × carrier (heatmap)
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.logistics_by_city_carrier(
  p_from_date  DATE,
  p_to_date    DATE,
  p_min_orders INTEGER DEFAULT 20,
  p_top_cities INTEGER DEFAULT 20
)
RETURNS TABLE (
  ciudad           TEXT,
  departamento     TEXT,
  transportadora   TEXT,
  total_pedidos    BIGINT,
  entregados       BIGINT,
  devueltos        BIGINT,
  tasa_entrega     NUMERIC,
  tasa_devolucion  NUMERIC,
  ciudad_total     BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $func$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT o.ciudad, COALESCE(o.departamento, '') AS departamento, o.transportadora, o.estado
    FROM public.orders o
    WHERE o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND o.fecha::date BETWEEN p_from_date AND p_to_date
      AND o.ciudad IS NOT NULL AND o.ciudad <> ''
      AND o.transportadora IS NOT NULL AND o.transportadora <> ''
      AND UPPER(o.estado) <> 'CANCELADO'
  ),
  city_volumes AS (
    SELECT b.ciudad, COUNT(*) AS total
    FROM base b
    GROUP BY b.ciudad
    HAVING COUNT(*) >= p_min_orders
    ORDER BY total DESC
    LIMIT p_top_cities
  )
  SELECT
    b.ciudad::TEXT,
    b.departamento::TEXT,
    b.transportadora::TEXT,
    COUNT(*) AS total_pedidos,
    COUNT(*) FILTER (WHERE UPPER(b.estado) = 'ENTREGADO') AS entregados,
    COUNT(*) FILTER (WHERE UPPER(b.estado) IN
      ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')) AS devueltos,
    ROUND(
      (COUNT(*) FILTER (WHERE UPPER(b.estado) = 'ENTREGADO'))::NUMERIC * 100.0
      / NULLIF(COUNT(*), 0),
      2
    ) AS tasa_entrega,
    ROUND(
      (COUNT(*) FILTER (WHERE UPPER(b.estado) IN
        ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')))::NUMERIC * 100.0
      / NULLIF(COUNT(*), 0),
      2
    ) AS tasa_devolucion,
    cv.total AS ciudad_total
  FROM base b
  INNER JOIN city_volumes cv ON cv.ciudad = b.ciudad
  GROUP BY b.ciudad, b.departamento, b.transportadora, cv.total
  HAVING COUNT(*) >= 5
  ORDER BY cv.total DESC, b.ciudad ASC, total_pedidos DESC;
END;
$func$;

GRANT EXECUTE ON FUNCTION public.logistics_by_city_carrier(DATE, DATE, INTEGER, INTEGER) TO authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 4. logistics_recommendations — mejor/peor carrier por ciudad
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.logistics_recommendations(
  p_from_date  DATE,
  p_to_date    DATE,
  p_min_orders INTEGER DEFAULT 20
)
RETURNS TABLE (
  ciudad                 TEXT,
  departamento           TEXT,
  ciudad_total           BIGINT,
  mejor_transportadora   TEXT,
  mejor_tasa_entrega     NUMERIC,
  mejor_pedidos          BIGINT,
  peor_transportadora    TEXT,
  peor_tasa_entrega      NUMERIC,
  peor_pedidos           BIGINT,
  delta_puntos           NUMERIC,
  carrier_actual_top     TEXT,
  recomendacion          TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $func$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT o.ciudad, COALESCE(o.departamento, '') AS departamento, o.transportadora, o.estado
    FROM public.orders o
    WHERE o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND o.fecha::date BETWEEN p_from_date AND p_to_date
      AND o.ciudad IS NOT NULL AND o.ciudad <> ''
      AND o.transportadora IS NOT NULL AND o.transportadora <> ''
      AND UPPER(o.estado) <> 'CANCELADO'
  ),
  per_carrier AS (
    SELECT
      b.ciudad, b.departamento, b.transportadora,
      COUNT(*) AS pedidos,
      ROUND(
        (COUNT(*) FILTER (WHERE UPPER(b.estado) = 'ENTREGADO'))::NUMERIC * 100.0
        / NULLIF(COUNT(*), 0),
        2
      ) AS tasa_entrega
    FROM base b
    GROUP BY b.ciudad, b.departamento, b.transportadora
    HAVING COUNT(*) >= 5
  ),
  city_totals AS (
    SELECT ciudad, SUM(pedidos) AS total FROM per_carrier GROUP BY ciudad
  ),
  ranked AS (
    SELECT
      pc.*,
      ct.total AS ciudad_total,
      ROW_NUMBER() OVER (PARTITION BY pc.ciudad ORDER BY pc.tasa_entrega DESC NULLS LAST, pc.pedidos DESC) AS rk_best,
      ROW_NUMBER() OVER (PARTITION BY pc.ciudad ORDER BY pc.tasa_entrega ASC NULLS LAST, pc.pedidos DESC) AS rk_worst,
      ROW_NUMBER() OVER (PARTITION BY pc.ciudad ORDER BY pc.pedidos DESC) AS rk_volume
    FROM per_carrier pc
    INNER JOIN city_totals ct ON ct.ciudad = pc.ciudad
    WHERE ct.total >= p_min_orders
  ),
  best AS (
    SELECT ciudad, departamento, ciudad_total, transportadora AS mejor_transportadora,
           tasa_entrega AS mejor_tasa_entrega, pedidos AS mejor_pedidos
    FROM ranked WHERE rk_best = 1
  ),
  worst AS (
    SELECT ciudad, transportadora AS peor_transportadora,
           tasa_entrega AS peor_tasa_entrega, pedidos AS peor_pedidos
    FROM ranked WHERE rk_worst = 1
  ),
  current_top AS (
    SELECT ciudad, transportadora AS carrier_actual_top
    FROM ranked WHERE rk_volume = 1
  )
  SELECT
    b.ciudad,
    b.departamento,
    b.ciudad_total,
    b.mejor_transportadora,
    b.mejor_tasa_entrega,
    b.mejor_pedidos,
    w.peor_transportadora,
    w.peor_tasa_entrega,
    w.peor_pedidos,
    (b.mejor_tasa_entrega - w.peor_tasa_entrega) AS delta_puntos,
    ct.carrier_actual_top,
    CASE
      WHEN b.mejor_transportadora = ct.carrier_actual_top THEN
        'Mantener ' || b.mejor_transportadora
      ELSE
        'Cambiar a ' || b.mejor_transportadora
    END AS recomendacion
  FROM best b
  LEFT JOIN worst w ON w.ciudad = b.ciudad
  LEFT JOIN current_top ct ON ct.ciudad = b.ciudad
  ORDER BY b.ciudad_total DESC;
END;
$func$;

GRANT EXECUTE ON FUNCTION public.logistics_recommendations(DATE, DATE, INTEGER) TO authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 5. get_top_cities — autocomplete del CityFilter dropdown
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_top_cities(
  p_limit INTEGER DEFAULT 200
)
RETURNS TABLE (
  ciudad        TEXT,
  departamento  TEXT,
  total_pedidos BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $func$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    o.ciudad::TEXT,
    COALESCE(o.departamento, '')::TEXT AS departamento,
    COUNT(*) AS total_pedidos
  FROM public.orders o
  WHERE o.ciudad IS NOT NULL AND o.ciudad <> ''
  GROUP BY o.ciudad, COALESCE(o.departamento, '')
  ORDER BY total_pedidos DESC
  LIMIT p_limit;
END;
$func$;

GRANT EXECUTE ON FUNCTION public.get_top_cities(INTEGER) TO authenticated;

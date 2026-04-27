-- Logística — RPCs analíticos + índices
--
-- 4 RPCs SECURITY DEFINER con admin gate. Cada una agrega `orders` por
-- una dimensión (carrier / city / product) o devuelve un summary global.
-- Filtran por `fecha::DATE` (la fecha real del pedido), excluyen
-- 'CANCELADO' del numerador/denominador del análisis de carrier (porque
-- es responsabilidad de la operadora, no del transportista).
--
-- Hardening del cast (Task 1 review): `fecha` es TEXT y puede tener
-- valores malformados ('garbage', '2026-13-01'). Antes de hacer
-- `fecha::date` validamos el formato con regex `^\d{4}-\d{2}-\d{2}$`.
-- Filas que NO matchean se descartan — no rompemos la query entera por
-- un dato sucio en una sola fila.
--
-- Lock note: `CREATE INDEX IF NOT EXISTS` (sin CONCURRENTLY) toma
-- ShareLock breve. A escala actual (~10k pedidos) son <100ms.
-- Si crece a 100k+ migrar índices a un archivo separado con
-- `supabase db push --no-transaction` y CONCURRENTLY.
--
-- Aplicar con `supabase db push`. Idempotente (CREATE OR REPLACE +
-- CREATE INDEX IF NOT EXISTS).
--
-- v2 (post Lovable Cloud testing): se removieron los parámetros
-- `p_min_orders` y los `HAVING COUNT(*) >= ...` — el usuario quiere ver
-- TODA la data sin filtrar por ruido. Si el plan original ya se aplicó
-- en algún entorno, los DROP FUNCTION de abajo limpian las versiones
-- viejas. CREATE OR REPLACE FUNCTION no puede cambiar parámetros, por
-- eso DROP+CREATE.

-- Limpieza de versiones previas (v1) si existen.
DROP FUNCTION IF EXISTS public.logistics_by_carrier(DATE, DATE, INTEGER);
DROP FUNCTION IF EXISTS public.logistics_by_city(DATE, DATE, INTEGER, INTEGER);
DROP FUNCTION IF EXISTS public.logistics_by_product(DATE, DATE, INTEGER, INTEGER);

-- ─────────────────────────────────────────────────────────────────
-- Índices parciales para soportar GROUP BY de las RPCs
-- ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_orders_transportadora_partial
  ON public.orders (transportadora)
  WHERE transportadora IS NOT NULL AND transportadora <> '';

CREATE INDEX IF NOT EXISTS idx_orders_ciudad_partial
  ON public.orders (ciudad, departamento)
  WHERE ciudad IS NOT NULL AND ciudad <> '';

CREATE INDEX IF NOT EXISTS idx_orders_producto_partial
  ON public.orders (producto)
  WHERE producto IS NOT NULL AND producto <> '';

CREATE INDEX IF NOT EXISTS idx_orders_fecha_date
  ON public.orders ((fecha::date))
  WHERE fecha ~ '^\d{4}-\d{2}-\d{2}$';

-- ─────────────────────────────────────────────────────────────────
-- logistics_summary — KPIs globales (4 cards en el header del tab)
-- ─────────────────────────────────────────────────────────────────
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
      AND UPPER(estado) <> 'CANCELADO'
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
      / NULLIF(COUNT(*), 0),
      2
    ) AS tasa_entrega,
    ROUND(
      (COUNT(*) FILTER (WHERE UPPER(estado) IN
        ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')))::NUMERIC * 100.0
      / NULLIF(COUNT(*), 0),
      2
    ) AS tasa_devolucion,
    COALESCE(SUM(valor) FILTER (WHERE UPPER(estado) = 'ENTREGADO'), 0) AS valor_entregado,
    COALESCE(SUM(valor) FILTER (WHERE UPPER(estado) IN
      ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')), 0) AS valor_perdido
  FROM base;
END;
$$;

GRANT EXECUTE ON FUNCTION public.logistics_summary(DATE, DATE) TO authenticated;

-- ─────────────────────────────────────────────────────────────────
-- logistics_by_carrier — métricas agrupadas por transportadora
-- ─────────────────────────────────────────────────────────────────
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
  GROUP BY o.transportadora
  ORDER BY entregados DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.logistics_by_carrier(DATE, DATE) TO authenticated;

-- ─────────────────────────────────────────────────────────────────
-- logistics_by_city — devoluciones por ciudad (Top N)
-- ─────────────────────────────────────────────────────────────────
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
    ROUND(
      (COUNT(*) FILTER (WHERE UPPER(o.estado) IN
        ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')))::NUMERIC * 100.0
      / NULLIF(COUNT(*), 0),
      2
    ) AS tasa_devolucion,
    ROUND(
      (COUNT(*) FILTER (WHERE UPPER(o.estado) = 'ENTREGADO'))::NUMERIC * 100.0
      / NULLIF(COUNT(*), 0),
      2
    ) AS tasa_entrega,
    COALESCE(SUM(o.valor) FILTER (WHERE UPPER(o.estado) IN
      ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')), 0) AS valor_perdido
  FROM public.orders o
  WHERE o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
    AND o.fecha::date BETWEEN p_from_date AND p_to_date
    AND o.ciudad IS NOT NULL
    AND o.ciudad <> ''
    AND UPPER(o.estado) <> 'CANCELADO'
  GROUP BY o.ciudad, COALESCE(o.departamento, '')
  ORDER BY tasa_devolucion DESC, total_pedidos DESC
  LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION public.logistics_by_city(DATE, DATE, INTEGER) TO authenticated;

-- ─────────────────────────────────────────────────────────────────
-- logistics_by_product — productos con peor entrega (Top N)
-- ─────────────────────────────────────────────────────────────────
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
      ('DEVOLUCION', 'DEVOLUCION EN TRANSITO', 'RECHAZADO')), 0) AS valor_perdido
  FROM public.orders o
  WHERE o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
    AND o.fecha::date BETWEEN p_from_date AND p_to_date
    AND o.producto IS NOT NULL
    AND o.producto <> ''
    AND UPPER(o.estado) <> 'CANCELADO'
  GROUP BY o.producto
  ORDER BY tasa_entrega ASC, total_pedidos DESC
  LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION public.logistics_by_product(DATE, DATE, INTEGER) TO authenticated;

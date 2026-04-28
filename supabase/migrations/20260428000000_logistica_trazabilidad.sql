-- Logística — Trazabilidad
--
-- 1) Extiende `logistics_summary` con campos para la vista de
--    trazabilidad: valor en tránsito, pendientes (sin despachar / por
--    confirmar), valor pendiente, cancelados y valor cancelado.
--
--    Cambio de signature → DROP + CREATE (RETURNS TABLE no se puede
--    alterar con CREATE OR REPLACE solo).
--
--    Convención de estados (operación COD Dropi):
--      • PENDIENTE             → confirmado, esperando despacho
--      • PENDIENTE CONFIRMACION → entrada nueva, requiere call de operadora
--      • EN BODEGA / EN TRANSPORTE / etc → en tránsito
--      • ENTREGADO             → terminal exitoso
--      • DEVOLUCION / RECHAZADO → terminal fallido
--      • CANCELADO             → cancelado por operadora (no es del transportista)
--
-- 2) Nuevo `logistics_timeline` — lista paginada de guías con filtros
--    opcionales (estados[], transportadora, search por guía/external_id).
--    Devuelve `total_count` en cada fila para que el cliente sepa el
--    total sin un segundo round-trip.
--
-- Aplicar con `supabase db push`. Idempotente.

-- ─────────────────────────────────────────────────────────────────
-- logistics_summary v2 — añade campos para trazabilidad
-- ─────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.logistics_summary(DATE, DATE);

CREATE OR REPLACE FUNCTION public.logistics_summary(
  p_from_date DATE,
  p_to_date   DATE
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
  -- v2: campos para trazabilidad
  valor_en_transito         NUMERIC,
  pendientes_sin_despachar  BIGINT,
  pendientes_por_confirmar  BIGINT,
  valor_pendientes          NUMERIC,
  cancelados                BIGINT,
  valor_cancelado           NUMERIC
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
  WITH all_orders AS (
    SELECT estado, valor
    FROM public.orders
    WHERE fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND fecha::date BETWEEN p_from_date AND p_to_date
  )
  SELECT
    -- total_pedidos = activos (excluye CANCELADO) — convención v1
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
    -- v2
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
    COALESCE(SUM(valor) FILTER (WHERE UPPER(estado) = 'CANCELADO'), 0) AS valor_cancelado
  FROM all_orders;
END;
$$;

GRANT EXECUTE ON FUNCTION public.logistics_summary(DATE, DATE) TO authenticated;

-- ─────────────────────────────────────────────────────────────────
-- logistics_timeline — lista paginada de guías con filtros
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.logistics_timeline(
  p_from_date      DATE,
  p_to_date        DATE,
  p_estados        TEXT[] DEFAULT NULL,
  p_transportadora TEXT   DEFAULT NULL,
  p_search         TEXT   DEFAULT NULL,
  p_limit          INTEGER DEFAULT 50,
  p_offset         INTEGER DEFAULT 0
)
RETURNS TABLE (
  id              UUID,
  fecha           DATE,
  guia            TEXT,
  external_id     TEXT,
  estado          TEXT,
  transportadora  TEXT,
  ciudad          TEXT,
  producto        TEXT,
  valor           NUMERIC,
  total_count     BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_search_pattern TEXT;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501';
  END IF;

  -- Pattern para ILIKE — los % se concatenan al texto del usuario,
  -- no al texto de la query (sin SQL injection).
  v_search_pattern := CASE
    WHEN p_search IS NULL OR p_search = '' THEN NULL
    ELSE '%' || p_search || '%'
  END;

  RETURN QUERY
  WITH filtered AS (
    SELECT o.id, o.fecha, o.guia, o.external_id, o.estado,
           o.transportadora, o.ciudad, o.producto, o.valor, o.created_at
    FROM public.orders o
    WHERE o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND o.fecha::date BETWEEN p_from_date AND p_to_date
      AND (p_estados IS NULL OR UPPER(COALESCE(o.estado, '')) = ANY(p_estados))
      AND (p_transportadora IS NULL OR p_transportadora = '' OR o.transportadora = p_transportadora)
      AND (
        v_search_pattern IS NULL
        OR o.guia ILIKE v_search_pattern
        OR o.external_id ILIKE v_search_pattern
      )
  ),
  counted AS (
    SELECT COUNT(*) AS n FROM filtered
  )
  SELECT
    f.id,
    f.fecha::date,
    COALESCE(f.guia, '')::TEXT,
    COALESCE(f.external_id, '')::TEXT,
    COALESCE(f.estado, '')::TEXT,
    COALESCE(f.transportadora, '')::TEXT,
    COALESCE(f.ciudad, '')::TEXT,
    COALESCE(f.producto, '')::TEXT,
    COALESCE(f.valor, 0)::NUMERIC,
    counted.n AS total_count
  FROM filtered f, counted
  ORDER BY f.fecha::date DESC, f.created_at DESC NULLS LAST
  LIMIT p_limit OFFSET p_offset;
END;
$$;

GRANT EXECUTE ON FUNCTION public.logistics_timeline(DATE, DATE, TEXT[], TEXT, TEXT, INTEGER, INTEGER) TO authenticated;

-- Índice de soporte para búsqueda por guía (ILIKE %x%) — usa trigram si pg_trgm
-- está disponible. Si no, los filtros con search caen a seq scan (aceptable: solo
-- se usa cuando el admin teclea explícitamente).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_orders_guia_trgm ON public.orders USING gin (guia gin_trgm_ops) WHERE guia IS NOT NULL AND guia <> ''''';
  END IF;
END $$;

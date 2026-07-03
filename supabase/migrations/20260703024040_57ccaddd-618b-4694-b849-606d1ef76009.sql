CREATE OR REPLACE FUNCTION public._resolve_scope_store()
RETURNS uuid
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_store uuid;
BEGIN
  IF public.has_role(auth.uid(), 'admin') THEN
    SELECT active_store_id INTO v_store FROM public.profiles WHERE user_id = auth.uid();
    RETURN v_store;
  END IF;

  SELECT p.active_store_id INTO v_store
  FROM public.profiles p
  WHERE p.user_id = auth.uid()
    AND p.active_store_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.store_members m
      WHERE m.user_id = auth.uid()
        AND m.store_id = p.active_store_id
        AND m.role IN ('owner','supervisor')
    );
  IF v_store IS NOT NULL THEN
    RETURN v_store;
  END IF;

  SELECT store_id INTO v_store FROM public.store_members
   WHERE user_id = auth.uid() AND role IN ('owner','supervisor')
   ORDER BY store_id ASC
   LIMIT 1;
  IF v_store IS NULL THEN
    RAISE EXCEPTION 'No autorizado' USING ERRCODE = '42501';
  END IF;
  RETURN v_store;
END;
$$;

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
  v_store uuid;
  v_search_pattern TEXT;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;

  v_search_pattern := CASE
    WHEN p_search IS NULL OR p_search = '' THEN NULL
    ELSE '%' || p_search || '%'
  END;

  RETURN QUERY
  WITH filtered AS (
    SELECT o.id, o.fecha, o.guia, o.external_id, o.estado,
           o.transportadora, o.ciudad, o.producto, o.valor, o.created_at
    FROM public.orders o
    WHERE o.store_id = v_store
      AND o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
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
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;

  RETURN QUERY
  SELECT
    o.ciudad::TEXT,
    COALESCE(o.departamento, '')::TEXT AS departamento,
    COUNT(*) AS total_pedidos
  FROM public.orders o
  WHERE o.store_id = v_store
    AND o.ciudad IS NOT NULL AND o.ciudad <> ''
  GROUP BY o.ciudad, COALESCE(o.departamento, '')
  ORDER BY total_pedidos DESC
  LIMIT p_limit;
END;
$func$;

GRANT EXECUTE ON FUNCTION public.get_top_cities(INTEGER) TO authenticated;

CREATE OR REPLACE FUNCTION public.logistics_by_city_carrier(p_from_date date, p_to_date date, p_min_orders integer DEFAULT 20, p_top_cities integer DEFAULT 20)
 RETURNS TABLE(ciudad text, departamento text, transportadora text, total_pedidos bigint, entregados bigint, devueltos bigint, tasa_entrega numeric, tasa_devolucion numeric, ciudad_total bigint)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_store uuid;
BEGIN
  v_store := public._resolve_scope_store();
  IF v_store IS NULL THEN RETURN; END IF;
  RETURN QUERY
  WITH base AS (
    SELECT o.ciudad, COALESCE(o.departamento,'') AS departamento, o.transportadora, o.estado
    FROM public.orders o
    WHERE o.fecha ~ '^\d{4}-\d{2}-\d{2}$'
      AND o.fecha::date BETWEEN p_from_date AND p_to_date
      AND o.ciudad IS NOT NULL AND o.ciudad <> ''
      AND o.transportadora IS NOT NULL AND o.transportadora <> ''
      AND UPPER(COALESCE(o.estado,'')) NOT LIKE '%CANCEL%'
      AND o.store_id = v_store
  ),
  city_volumes AS (
    SELECT b.ciudad, COUNT(*) AS total FROM base b
    GROUP BY b.ciudad HAVING COUNT(*) >= p_min_orders
    ORDER BY total DESC LIMIT p_top_cities
  )
  SELECT
    b.ciudad::TEXT, b.departamento::TEXT, b.transportadora::TEXT,
    COUNT(*),
    COUNT(*) FILTER (WHERE UPPER(b.estado)='ENTREGADO'),
    COUNT(*) FILTER (WHERE UPPER(b.estado) IN ('DEVOLUCION','DEVOLUCION EN TRANSITO','RECHAZADO')),
    ROUND((COUNT(*) FILTER (WHERE UPPER(b.estado)='ENTREGADO'))::numeric*100.0/NULLIF(COUNT(*),0),2),
    ROUND((COUNT(*) FILTER (WHERE UPPER(b.estado) IN ('DEVOLUCION','DEVOLUCION EN TRANSITO','RECHAZADO')))::numeric*100.0/NULLIF(COUNT(*),0),2),
    cv.total
  FROM base b INNER JOIN city_volumes cv ON cv.ciudad = b.ciudad
  GROUP BY b.ciudad, b.departamento, b.transportadora, cv.total
  HAVING COUNT(*) >= 5
  ORDER BY cv.total DESC, b.ciudad ASC, 4 DESC;
END;
$function$;
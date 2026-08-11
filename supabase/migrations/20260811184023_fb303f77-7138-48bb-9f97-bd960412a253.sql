CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Índices de texto para que el ILIKE no haga scan completo de `orders`.
CREATE INDEX IF NOT EXISTS orders_nombre_trgm ON public.orders USING gin (lower(nombre) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS orders_ciudad_trgm ON public.orders USING gin (lower(ciudad) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS orders_producto_trgm ON public.orders USING gin (lower(producto) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS orders_guia_trgm ON public.orders USING gin (lower(guia) gin_trgm_ops);

-- Búsqueda server-side sobre TODO el histórico de la tienda.
CREATE OR REPLACE FUNCTION public.search_orders(
  p_store_id uuid,
  p_q        text,
  p_limit    int DEFAULT 50
)
RETURNS TABLE (
  external_id text,
  nombre      text,
  phone       text,
  ciudad      text,
  producto    text,
  guia        text,
  estado      text,
  fecha       text,
  valor       numeric,
  transportadora text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  q text := lower(btrim(coalesce(p_q, '')));
BEGIN
  -- Fail-closed: sin tienda, sin membresía o con menos de 3 caracteres no se
  -- devuelve nada (evita que un término vacío arrastre la tabla entera).
  IF p_store_id IS NULL OR NOT public.is_store_member(p_store_id) THEN RETURN; END IF;
  IF length(q) < 3 THEN RETURN; END IF;

  RETURN QUERY
  SELECT o.external_id, o.nombre, o.phone, o.ciudad, o.producto, o.guia,
         o.estado, o.fecha, o.valor, o.transportadora
    FROM public.orders o
   WHERE o.store_id = p_store_id
     AND (
          lower(o.nombre)   LIKE '%' || q || '%'
       OR lower(o.ciudad)   LIKE '%' || q || '%'
       OR lower(o.producto) LIKE '%' || q || '%'
       OR lower(o.guia)     LIKE '%' || q || '%'
       OR o.phone           LIKE '%' || regexp_replace(q, '\D', '', 'g') || '%'
          AND regexp_replace(q, '\D', '', 'g') <> ''
       OR o.external_id     LIKE '%' || q || '%'
     )
   ORDER BY o.created_at DESC NULLS LAST
   LIMIT LEAST(GREATEST(coalesce(p_limit, 50), 1), 200);
END $$;

REVOKE EXECUTE ON FUNCTION public.search_orders(uuid, text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_orders(uuid, text, int) TO authenticated, service_role;
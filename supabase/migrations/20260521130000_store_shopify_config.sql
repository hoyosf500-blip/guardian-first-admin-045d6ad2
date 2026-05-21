-- Reconciliación Shopify ↔ Dropi: credenciales de Shopify POR TIENDA.
--
-- Problema que resuelve: la automatización Shopify→Dropi falla y se quedan
-- pedidos colgados en Shopify que nunca se despachan. Para detectarlos,
-- Guardian necesita leer los pedidos de Shopify de cada tienda y cruzarlos
-- contra los pedidos de Dropi (tabla `orders`). Cada tienda tiene su propio
-- dominio + token de Admin API (Ecuador y Colombia son tiendas/dominios
-- distintos). Tabla aparte de `store_dropi_config` para no tocar lo que ya
-- funciona.

CREATE TABLE IF NOT EXISTS public.store_shopify_config (
  store_id     uuid PRIMARY KEY REFERENCES public.stores(id) ON DELETE CASCADE,
  shop_domain  text NOT NULL,              -- xxxx.myshopify.com
  admin_token  text NOT NULL,              -- shpat_...
  active       boolean NOT NULL DEFAULT true,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.store_shopify_config ENABLE ROW LEVEL SECURITY;

-- Solo el dueño de la tienda ve/gestiona sus credenciales Shopify. Las edge
-- functions leen con service role (no dependen de esta policy).
DROP POLICY IF EXISTS "owner manages shopify config" ON public.store_shopify_config;
CREATE POLICY "owner manages shopify config" ON public.store_shopify_config
  FOR ALL TO authenticated
  USING (public.is_store_owner(store_id))
  WITH CHECK (public.is_store_owner(store_id));

-- Upsert (solo dueño). Espejo de upsert_store_dropi_config.
CREATE OR REPLACE FUNCTION public.upsert_store_shopify_config(
  p_store_id    uuid,
  p_shop_domain text,
  p_admin_token text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_store_owner(p_store_id) THEN
    RAISE EXCEPTION 'Solo el dueño de la tienda puede configurar Shopify' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.store_shopify_config (store_id, shop_domain, admin_token)
  VALUES (p_store_id, trim(p_shop_domain), trim(p_admin_token))
  ON CONFLICT (store_id) DO UPDATE
    SET shop_domain = EXCLUDED.shop_domain,
        admin_token = EXCLUDED.admin_token,
        active      = true,
        updated_at  = now();
END;
$$;

-- Getter "seguro": NO expone el token, solo si está configurado + el dominio.
-- Útil para que la UI muestre el estado sin filtrar el secreto.
CREATE OR REPLACE FUNCTION public.get_store_shopify_status(p_store_id uuid)
RETURNS TABLE(configured boolean, shop_domain text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_store_member(p_store_id) THEN
    RAISE EXCEPTION 'No autorizado' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT (c.store_id IS NOT NULL) AS configured, c.shop_domain
    FROM (SELECT p_store_id AS sid) q
    LEFT JOIN public.store_shopify_config c ON c.store_id = q.sid AND c.active;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_store_shopify_config(uuid, text, text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.upsert_store_shopify_config(uuid, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.get_store_shopify_status(uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.get_store_shopify_status(uuid) TO authenticated;

ALTER TABLE public.store_shopify_config
  ADD COLUMN IF NOT EXISTS client_id     text,
  ADD COLUMN IF NOT EXISTS client_secret text;

ALTER TABLE public.store_shopify_config
  ALTER COLUMN admin_token DROP NOT NULL;

CREATE OR REPLACE FUNCTION public.upsert_store_shopify_credentials(
  p_store_id      uuid,
  p_shop_domain   text,
  p_client_id     text,
  p_client_secret text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_store_owner(p_store_id) THEN
    RAISE EXCEPTION 'Solo el dueño de la tienda puede configurar Shopify' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.store_shopify_config (store_id, shop_domain, client_id, client_secret, admin_token, active)
  VALUES (
    p_store_id,
    trim(p_shop_domain),
    NULLIF(trim(p_client_id), ''),
    NULLIF(trim(p_client_secret), ''),
    NULL,
    true
  )
  ON CONFLICT (store_id) DO UPDATE
    SET shop_domain   = EXCLUDED.shop_domain,
        client_id     = COALESCE(EXCLUDED.client_id, store_shopify_config.client_id),
        client_secret = COALESCE(EXCLUDED.client_secret, store_shopify_config.client_secret),
        active        = true,
        updated_at    = now();
END;
$$;

DROP FUNCTION IF EXISTS public.get_store_shopify_status(uuid);
CREATE OR REPLACE FUNCTION public.get_store_shopify_status(p_store_id uuid)
RETURNS TABLE(configured boolean, shop_domain text, auth_mode text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_store_member(p_store_id) THEN
    RAISE EXCEPTION 'No autorizado' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT
      (c.store_id IS NOT NULL) AS configured,
      c.shop_domain,
      CASE
        WHEN c.client_id IS NOT NULL AND c.client_secret IS NOT NULL THEN 'client_credentials'
        WHEN c.admin_token IS NOT NULL THEN 'token'
        ELSE NULL
      END AS auth_mode
    FROM (SELECT p_store_id AS sid) q
    LEFT JOIN public.store_shopify_config c ON c.store_id = q.sid AND c.active;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_store_shopify_credentials(uuid, text, text, text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.upsert_store_shopify_credentials(uuid, text, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.get_store_shopify_status(uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.get_store_shopify_status(uuid) TO authenticated;
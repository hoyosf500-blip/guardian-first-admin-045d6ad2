-- Shopify: soportar el NUEVO Dev Dashboard (client credentials grant).
--
-- Contexto: Shopify migró la creación de apps personalizadas al "Dev Dashboard".
-- Esas apps YA NO exponen un token estático `shpat_` en la UI. Solo muestran
-- Client ID + Client Secret (`shpss_…`). El token de Admin API se obtiene
-- programáticamente con el client credentials grant:
--
--   POST https://{shop}/admin/oauth/access_token
--   grant_type=client_credentials&client_id=…&client_secret=…
--   -> { access_token: "shpat_…", scope, expires_in: 86399 }  (vence cada 24h)
--
-- Por eso el dueño pegaba el `shpss_` (único token visible) y Shopify devolvía
-- 401. Solución: guardamos client_id + client_secret y la edge function
-- `shopify-reconcile` hace el intercambio en runtime (token nunca vence desde
-- el lado del usuario).
--
-- Compatibilidad: dejamos `admin_token` (apps personalizadas viejas con token
-- estático siguen funcionando) y mantenemos el RPC viejo de 3 args intacto para
-- no romper el frontend que todavía no se republicó.

ALTER TABLE public.store_shopify_config
  ADD COLUMN IF NOT EXISTS client_id     text,
  ADD COLUMN IF NOT EXISTS client_secret text;

-- admin_token deja de ser obligatorio: ahora las credenciales pueden venir como
-- client_id + client_secret en lugar de un token estático.
ALTER TABLE public.store_shopify_config
  ALTER COLUMN admin_token DROP NOT NULL;

-- Nuevo upsert para el flujo Dev Dashboard (client credentials).
-- Nombre distinto al viejo para evitar ambigüedad de overload en PostgREST y
-- para que el frontend viejo (que llama upsert_store_shopify_config/3) no se
-- rompa hasta que se republique.
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

-- Getter "seguro" extendido: agrega auth_mode para que la UI muestre cómo está
-- conectada la tienda sin filtrar secretos. NO expone client_secret ni token.
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

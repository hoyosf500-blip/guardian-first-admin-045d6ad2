
-- Multi-tienda: branding y RPCs per-store
-- 1) Logo por tienda
ALTER TABLE public.stores ADD COLUMN IF NOT EXISTS brand_logo_url text;

-- 2) Política UPDATE para que el dueño edite el nombre/logo de su tienda
--    (la política stores_owner_update ya existe, esto es idempotente: la dejamos).

-- 3) RPC: crear una nueva tienda. El usuario actual queda como owner.
CREATE OR REPLACE FUNCTION public.create_store(p_name text, p_country_code text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;
  IF p_name IS NULL OR length(trim(p_name)) < 2 THEN RAISE EXCEPTION 'Nombre invalido'; END IF;
  IF p_country_code IS NULL OR length(p_country_code) <> 2 THEN RAISE EXCEPTION 'Country code debe ser 2 letras'; END IF;

  INSERT INTO public.stores (name, country_code, status, created_by)
  VALUES (trim(p_name), upper(p_country_code), 'active', v_uid)
  RETURNING id INTO v_id;

  INSERT INTO public.store_members (store_id, user_id, role) VALUES (v_id, v_uid, 'owner');
  INSERT INTO public.store_dropi_config (store_id, country_code) VALUES (v_id, upper(p_country_code))
    ON CONFLICT (store_id) DO NOTHING;

  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.create_store(text,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.create_store(text,text) TO authenticated;

-- 4) RPC: upsert de credenciales Dropi para una tienda (solo dueño)
CREATE OR REPLACE FUNCTION public.upsert_store_dropi_config(
  p_store_id uuid,
  p_country_code text,
  p_dropi_api_key text,
  p_dropi_session_token text,
  p_dropi_store_url text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_store_owner(p_store_id) THEN
    RAISE EXCEPTION 'Solo el dueño de la tienda puede editar credenciales';
  END IF;
  INSERT INTO public.store_dropi_config (store_id, country_code, dropi_api_key, dropi_session_token, dropi_store_url)
  VALUES (p_store_id, upper(coalesce(p_country_code,'CO')), p_dropi_api_key, p_dropi_session_token, p_dropi_store_url)
  ON CONFLICT (store_id) DO UPDATE SET
    country_code        = upper(coalesce(EXCLUDED.country_code, store_dropi_config.country_code)),
    dropi_api_key       = COALESCE(NULLIF(EXCLUDED.dropi_api_key, ''),       store_dropi_config.dropi_api_key),
    dropi_session_token = COALESCE(NULLIF(EXCLUDED.dropi_session_token, ''), store_dropi_config.dropi_session_token),
    dropi_store_url     = COALESCE(NULLIF(EXCLUDED.dropi_store_url, ''),     store_dropi_config.dropi_store_url),
    updated_at = now();
END;
$$;
REVOKE ALL ON FUNCTION public.upsert_store_dropi_config(uuid,text,text,text,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.upsert_store_dropi_config(uuid,text,text,text,text) TO authenticated;

-- 5) RPC: actualizar branding de tienda (nombre + logo) — solo dueño
CREATE OR REPLACE FUNCTION public.update_store_branding(
  p_store_id uuid, p_name text, p_brand_logo_url text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_store_owner(p_store_id) THEN
    RAISE EXCEPTION 'Solo el dueño puede editar branding';
  END IF;
  UPDATE public.stores
     SET name = COALESCE(NULLIF(trim(p_name), ''), name),
         brand_logo_url = NULLIF(trim(p_brand_logo_url), '')
   WHERE id = p_store_id;
END;
$$;
REVOKE ALL ON FUNCTION public.update_store_branding(uuid,text,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.update_store_branding(uuid,text,text) TO authenticated;

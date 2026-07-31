DROP POLICY IF EXISTS pcm_ins ON public.personal_card_movements;
DROP POLICY IF EXISTS pcm_upd ON public.personal_card_movements;
DROP POLICY IF EXISTS pcm_del ON public.personal_card_movements;

ALTER TABLE public.wa_order_notifications
  ADD COLUMN IF NOT EXISTS attempts        integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;

ALTER TABLE public.wa_channels
  ADD COLUMN IF NOT EXISTS webhook_secret text;

CREATE OR REPLACE FUNCTION public.ensure_wa_channel_secret(
  p_store_id uuid,
  p_rotate   boolean DEFAULT false
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id     uuid;
  v_secret text;
BEGIN
  IF NOT public.is_store_owner(p_store_id) THEN
    RAISE EXCEPTION 'Solo el dueño de la tienda puede ver el secreto del webhook' USING ERRCODE = '42501';
  END IF;
  SELECT c.id, c.webhook_secret INTO v_id, v_secret
  FROM public.wa_channels c
  WHERE c.store_id = p_store_id
  ORDER BY c.updated_at DESC
  LIMIT 1;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'La tienda no tiene canal de WhatsApp registrado todavía' USING ERRCODE = 'P0002';
  END IF;
  IF p_rotate OR v_secret IS NULL OR length(trim(v_secret)) < 32 THEN
    v_secret := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
    UPDATE public.wa_channels
      SET webhook_secret = v_secret, updated_at = now()
      WHERE id = v_id;
  END IF;
  RETURN v_secret;
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_wa_channel_secret(uuid, boolean) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.ensure_wa_channel_secret(uuid, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.dropi_jwt_exp(p_token text)
RETURNS bigint
LANGUAGE plpgsql IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_b64 text;
  v_pad int;
  v_payload jsonb;
BEGIN
  IF coalesce(p_token, '') = '' THEN RETURN NULL; END IF;
  v_b64 := translate(split_part(p_token, '.', 2), '-_', '+/');
  IF v_b64 = '' THEN RETURN NULL; END IF;
  v_pad := (4 - (length(v_b64) % 4)) % 4;
  v_payload := convert_from(decode(v_b64 || repeat('=', v_pad), 'base64'), 'UTF8')::jsonb;
  RETURN NULLIF(v_payload ->> 'exp', '')::bigint;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.dropi_jwt_exp(text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.dropi_jwt_exp(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_store_dropi_status(p_store_id uuid)
RETURNS TABLE(
  configured boolean,
  has_api_key boolean,
  has_session_token boolean,
  has_login_password boolean,
  login_email text,
  store_url text,
  country_code text,
  session_refreshed_at timestamptz,
  session_exp bigint
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v jsonb;
BEGIN
  IF NOT public.is_store_manager(p_store_id) THEN
    RAISE EXCEPTION 'No autorizado' USING ERRCODE = '42501';
  END IF;
  SELECT to_jsonb(t) INTO v
    FROM public.store_dropi_config t
   WHERE t.store_id = p_store_id;
  RETURN QUERY SELECT
    (v IS NOT NULL),
    (coalesce(v ->> 'dropi_api_key', '')        <> ''),
    (coalesce(v ->> 'dropi_session_token', '')  <> ''),
    (coalesce(v ->> 'dropi_login_password', '') <> ''),
    (v ->> 'dropi_login_email'),
    (v ->> 'dropi_store_url'),
    (v ->> 'country_code'),
    (v ->> 'dropi_session_refreshed_at')::timestamptz,
    public.dropi_jwt_exp(v ->> 'dropi_session_token');
END;
$$;

REVOKE ALL ON FUNCTION public.get_store_dropi_status(uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.get_store_dropi_status(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_my_stores_dropi_status()
RETURNS TABLE(store_id uuid, has_api_key boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT q.sid, q.hk FROM (
    SELECT m.store_id AS sid,
           (coalesce(c.dropi_api_key, '') <> '') AS hk
      FROM public.store_members m
      LEFT JOIN public.store_dropi_config c ON c.store_id = m.store_id
     WHERE m.user_id = auth.uid() AND m.role = 'owner'
  ) q;
$$;

REVOKE ALL ON FUNCTION public.get_my_stores_dropi_status() FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.get_my_stores_dropi_status() TO authenticated;

CREATE OR REPLACE FUNCTION public._resolve_scope_store()
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_store uuid;
  v_count int;
BEGIN
  IF public.has_role(auth.uid(), 'admin') THEN
    SELECT active_store_id INTO v_store FROM public.profiles WHERE user_id = auth.uid();
    IF v_store IS NOT NULL THEN
      RETURN v_store;
    END IF;
    SELECT COUNT(*) INTO v_count FROM public.store_members WHERE user_id = auth.uid();
    IF v_count = 1 THEN
      SELECT store_id INTO v_store FROM public.store_members WHERE user_id = auth.uid();
      RETURN v_store;
    END IF;
    RETURN '00000000-0000-0000-0000-000000000000'::uuid;
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

  SELECT COUNT(*) INTO v_count FROM public.store_members
   WHERE user_id = auth.uid() AND role IN ('owner','supervisor');

  IF v_count = 0 THEN
    RAISE EXCEPTION 'No autorizado' USING ERRCODE = '42501';
  END IF;

  IF v_count > 1 THEN
    RETURN '00000000-0000-0000-0000-000000000000'::uuid;
  END IF;

  SELECT store_id INTO v_store FROM public.store_members
   WHERE user_id = auth.uid() AND role IN ('owner','supervisor')
   LIMIT 1;

  RETURN v_store;
END $function$;
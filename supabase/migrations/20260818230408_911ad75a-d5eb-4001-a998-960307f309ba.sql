DO $$
DECLARE v_user uuid := 'f380a3a4-45b9-4834-bc39-ac7661e73db0';
        v_store uuid := 'f4a50758-c9de-4597-8f67-99dc0d3886e4';
BEGIN
  DELETE FROM public.store_dropi_config WHERE store_id = v_store;
  DELETE FROM public.store_shopify_config WHERE store_id = v_store;
  DELETE FROM public.store_ai_config WHERE store_id = v_store;
  DELETE FROM public.store_subscriptions WHERE store_id = v_store;
  DELETE FROM public.store_invites WHERE store_id = v_store;
  DELETE FROM public.store_members WHERE store_id = v_store;
  DELETE FROM public.user_app_version WHERE user_id = v_user;
  DELETE FROM public.user_roles WHERE user_id = v_user;
  DELETE FROM public.profiles WHERE user_id = v_user;
  UPDATE public.stores SET created_by = NULL WHERE created_by = v_user AND id <> v_store;
  DELETE FROM public.stores WHERE id = v_store;
  DELETE FROM auth.users WHERE id = v_user;
END $$;
DO $$
DECLARE v_user uuid := '79792ff7-4689-45c3-ab0a-de9dcafed666';
        v_store uuid := '9cc037bb-1364-4747-b73e-d9328cda5e60';
BEGIN
  DELETE FROM public.store_dropi_config WHERE store_id = v_store;
  DELETE FROM public.store_shopify_config WHERE store_id = v_store;
  DELETE FROM public.store_ai_config WHERE store_id = v_store;
  DELETE FROM public.store_subscriptions WHERE store_id = v_store;
  DELETE FROM public.store_invites WHERE store_id = v_store;
  DELETE FROM public.store_members WHERE store_id = v_store;
  DELETE FROM public.stores WHERE id = v_store;
  DELETE FROM public.user_roles WHERE user_id = v_user;
  DELETE FROM public.profiles WHERE user_id = v_user;
  DELETE FROM auth.users WHERE id = v_user;
END $$;
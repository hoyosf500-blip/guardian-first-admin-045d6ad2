CREATE OR REPLACE FUNCTION public.importchat_token_horas(p_store_id uuid)
RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_exp timestamptz;
BEGIN
  IF NOT public.is_store_member(p_store_id) THEN
    RETURN NULL;
  END IF;
  SELECT token_expira_at INTO v_exp
    FROM public.store_importchat_config
   WHERE store_id = p_store_id;
  IF v_exp IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN EXTRACT(EPOCH FROM (v_exp - now())) / 3600.0;
END $$;

REVOKE ALL  ON FUNCTION public.importchat_token_horas(uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.importchat_token_horas(uuid) TO authenticated;
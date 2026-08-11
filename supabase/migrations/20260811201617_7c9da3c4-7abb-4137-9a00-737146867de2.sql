CREATE OR REPLACE FUNCTION public.create_my_store(p_name text, p_country_code text DEFAULT 'CO'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_name text := btrim(coalesce(p_name, ''));
  v_cc text := upper(btrim(coalesce(p_country_code, 'CO')));
  v_store uuid; v_is_admin boolean;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;
  IF length(v_name) < 2 OR length(v_name) > 60 THEN
    RAISE EXCEPTION 'El nombre de la tienda debe tener entre 2 y 60 caracteres';
  END IF;
  IF v_cc NOT IN ('CO','EC','GT') THEN RAISE EXCEPTION 'País inválido: usá CO, EC o GT'; END IF;
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = v_uid AND role = 'admin') INTO v_is_admin;
  IF NOT v_is_admin AND EXISTS (SELECT 1 FROM public.store_members WHERE user_id = v_uid AND role = 'owner') THEN
    RAISE EXCEPTION 'Ya sos dueño de una tienda. Si necesitás otra, hablá con el administrador.';
  END IF;
  INSERT INTO public.stores (name, country_code, status, created_by)
  VALUES (v_name, v_cc, 'active', v_uid) RETURNING id INTO v_store;
  INSERT INTO public.store_members (store_id, user_id, role) VALUES (v_store, v_uid, 'owner');
  RETURN v_store;
END;
$function$
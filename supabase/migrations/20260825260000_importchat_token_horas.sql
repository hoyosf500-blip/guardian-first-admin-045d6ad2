-- Horas hasta que vence la llave de ImporChat, para miembros de la tienda (2026-08-25)
--
-- Bug de la auditoria (hallazgo D1, alta): el badge de salud ImporchatSyncBadge
-- queria avisar "Llave vence en Nh", pero leia store_importchat_config.token_expira_at
-- DIRECTO desde el browser — y esa tabla esta cerrada por RLS (tiene la llave
-- secreta). El SELECT fallaba, tokenExpiraAt quedaba null y el aviso NUNCA se
-- mostraba: codigo muerto. O sea, la promesa de "que no se caiga en silencio"
-- quedaba a medias justo en el vencimiento de la llave, que es la causa mas comun.
--
-- Fix: una RPC SECURITY DEFINER que devuelve SOLO las horas restantes (un numero,
-- nunca el token) a un miembro de la tienda. No expone nada sensible.

CREATE OR REPLACE FUNCTION public.importchat_token_horas(p_store_id uuid)
RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_exp timestamptz;
BEGIN
  -- No miembro => null (no revela si la tienda tiene ImporChat ni cuando vence).
  IF NOT public.is_store_member(p_store_id) THEN
    RETURN NULL;
  END IF;
  SELECT token_expira_at INTO v_exp
    FROM public.store_importchat_config
   WHERE store_id = p_store_id;
  IF v_exp IS NULL THEN
    RETURN NULL;
  END IF;
  -- Horas hasta vencer; negativo = ya vencida.
  RETURN EXTRACT(EPOCH FROM (v_exp - now())) / 3600.0;
END $$;

REVOKE ALL  ON FUNCTION public.importchat_token_horas(uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.importchat_token_horas(uuid) TO authenticated;

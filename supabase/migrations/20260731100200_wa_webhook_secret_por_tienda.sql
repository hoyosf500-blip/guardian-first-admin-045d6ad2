-- Secreto de webhook POR TIENDA para wa-webhook.
--
-- Hasta hoy la única credencial del webhook entrante era WA_WEBHOOK_SECRET, UNO
-- SOLO para toda la plataforma, y la tienda destino la elegía quien llamaba
-- (?store_id=). Como ese secreto hay que entregárselo a CADA dueño para que
-- configure su gateway, el dueño de la tienda B podía POSTear al inbox de la
-- tienda A: mensajes falsos en la cola de sus asesoras y —porque la IA arranca en
-- automático— el NÚMERO de A respondiéndole a quien el atacante eligiera.
--
-- NO se toca upsert_wa_channel (la versión desplegada puede diferir del repo):
-- el secreto se crea/rota con una función NUEVA.

ALTER TABLE public.wa_channels
  ADD COLUMN IF NOT EXISTS webhook_secret text;

-- Devuelve el secreto del canal de la tienda, generándolo si falta (o rotándolo
-- si p_rotate). Owner-only: la fila de wa_channels contiene el token del gateway.
-- Rotar INVALIDA la URL vieja del gateway hasta que el dueño la reconfigure.
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
    -- 64 hex sin depender de pgcrypto (gen_random_uuid es nativo desde PG13).
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

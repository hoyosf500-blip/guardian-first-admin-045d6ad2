-- Config del bot de WhatsApp por tienda — editable desde /admin → "Bot WhatsApp".
--
-- La IA (wa-ai-responder) lee esta fila EN VIVO con service role: cambiar el
-- prompt/modelo/nombre acá tiene efecto al instante, SIN redeploy.
--
-- El system_prompt del usuario define la PERSONALIDAD/instrucciones libres; las
-- REGLAS DE SEGURIDAD (no inventar estado, anti-inyección, escalar a humano, no
-- vender) las re-aplica SIEMPRE la edge function, aunque el usuario las borre.
--
-- Solo managers (owner o supervisor) ven/editan — usa el helper existente
-- public.is_store_manager (migración 20260522010000). NO aplicar sin coordinar.

CREATE TABLE IF NOT EXISTS public.wa_bot_config (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id      uuid NOT NULL UNIQUE REFERENCES public.stores(id) ON DELETE CASCADE,
  enabled       boolean NOT NULL DEFAULT true,        -- kill switch del bot para TODA la tienda
  agent_name    text,                                 -- nombre del asesor (ej. "Sara")
  model         text,                                 -- override del modelo (ej. claude-sonnet-4-6)
  system_prompt text,                                 -- personalidad/instrucciones libres
  greeting      text,                                 -- saludo sugerido para el primer mensaje
  media         jsonb NOT NULL DEFAULT '{}'::jsonb,   -- (fase 2) fotos que el bot puede enviar
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.wa_bot_config ENABLE ROW LEVEL SECURITY;

-- Solo managers (dueño o supervisor) leen la config. La edge function la lee con
-- service role (bypassa RLS), así que no depende de esta policy.
DROP POLICY IF EXISTS "managers read wa bot config" ON public.wa_bot_config;
CREATE POLICY "managers read wa bot config" ON public.wa_bot_config
  FOR SELECT TO authenticated
  USING (public.is_store_manager(store_id));

-- Upsert gated a manager. Espejo de upsert_store_dropi_config / upsert_wa_channel.
CREATE OR REPLACE FUNCTION public.upsert_wa_bot_config(
  p_store_id      uuid,
  p_enabled       boolean,
  p_agent_name    text DEFAULT NULL,
  p_model         text DEFAULT NULL,
  p_system_prompt text DEFAULT NULL,
  p_greeting      text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT public.is_store_manager(p_store_id) THEN
    RAISE EXCEPTION 'Solo el dueño o supervisor puede configurar el bot' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.wa_bot_config (store_id, enabled, agent_name, model, system_prompt, greeting, updated_at)
  VALUES (
    p_store_id,
    COALESCE(p_enabled, true),
    NULLIF(trim(p_agent_name), ''),
    NULLIF(trim(p_model), ''),
    NULLIF(trim(p_system_prompt), ''),
    NULLIF(trim(p_greeting), ''),
    now()
  )
  ON CONFLICT (store_id) DO UPDATE
    SET enabled       = EXCLUDED.enabled,
        agent_name    = EXCLUDED.agent_name,
        model         = EXCLUDED.model,
        system_prompt = EXCLUDED.system_prompt,
        greeting      = EXCLUDED.greeting,
        updated_at    = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_wa_bot_config(uuid, boolean, text, text, text, text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.upsert_wa_bot_config(uuid, boolean, text, text, text, text) TO authenticated;

-- WhatsApp Inbox + IA autónoma en /seguimiento (Híbrido H2 — "rentar el caño").
--
-- Crea la capa conversacional que Guardian NO tiene hoy: hilo por cliente +
-- mensajes + IA. El transporte es un gateway QR MANEJADO (Whapi.cloud en el
-- piloto) detrás de la interfaz `_shared/waTransport.ts` — swappable a Meta
-- Cloud API sin tocar estas tablas.
--
-- Convenciones reusadas (NO inventar):
--   * RLS store-scoped vía helpers existentes public.is_store_member(uuid) /
--     public.is_store_owner(uuid) (usan auth.uid() adentro).
--   * Secretos del canal (token Whapi) owner-only + RPC de status para
--     miembros — mismo patrón que store_shopify_config / get_store_shopify_status.
--   * Realtime: REPLICA IDENTITY FULL + ALTER PUBLICATION idempotente
--     (igual que orders / order_results en 20260417190216).
--   * El cruce conversación↔orden es POR TELÉFONO normalizado (customer_phone),
--     misma primitiva que touchpoints↔segData.
--
-- DRAFT en rama agente/seguimiento. NO aplicar (db push) sin coordinar.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. wa_channels — config del canal por tienda (incluye el token del gateway).
--    OWNER-ONLY (el token es secreto). Los miembros ven el estado vía RPC.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.wa_channels (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id       uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  provider       text NOT NULL DEFAULT 'whapi',      -- 'whapi' | 'evolution' | 'cloud_api'
  instance_name  text,                                -- id de canal/instancia del proveedor
  phone_number   text,                                -- número conectado (E.164, display)
  provider_token text,                                -- SECRETO (Bearer del gateway). Owner-only.
  provider_base  text,                                -- base URL del gateway (default en la edge fn)
  status         text NOT NULL DEFAULT 'qr_pending',  -- 'qr_pending' | 'connected' | 'disconnected'
  meta           jsonb NOT NULL DEFAULT '{}'::jsonb,  -- metadata no-secreta del proveedor
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, provider, phone_number)
);

ALTER TABLE public.wa_channels ENABLE ROW LEVEL SECURITY;

-- Solo el dueño ve/gestiona el canal (porque la fila contiene el token).
-- Las edge functions leen con service role (no dependen de esta policy).
DROP POLICY IF EXISTS "owner manages wa channel" ON public.wa_channels;
CREATE POLICY "owner manages wa channel" ON public.wa_channels
  FOR ALL TO authenticated
  USING (public.is_store_owner(store_id))
  WITH CHECK (public.is_store_owner(store_id));

-- ─────────────────────────────────────────────────────────────────────────
-- 2. wa_conversations — un hilo por (tienda, teléfono cliente).
--    Miembros leen + actualizan (asignar, marcar leído, toggle IA, snooze).
--    INSERT vía service role (webhook).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.wa_conversations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id             uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  channel_id           uuid REFERENCES public.wa_channels(id) ON DELETE SET NULL,
  customer_phone       text NOT NULL,                  -- normalizado: join key con orders.phone
  customer_name        text,
  last_message_at      timestamptz,
  last_message_preview text,
  last_direction       text,                            -- 'in' | 'out'
  unread_count         integer NOT NULL DEFAULT 0,
  ai_enabled           boolean NOT NULL DEFAULT false,  -- kill switch por hilo (default OFF = seguro)
  ai_state             text NOT NULL DEFAULT 'auto',    -- 'auto' | 'paused_human' | 'handed_off'
  status               text NOT NULL DEFAULT 'open',    -- 'open' | 'snoozed' | 'closed'
  snooze_until         timestamptz,
  assigned_operator_id uuid,
  linked_external_id   text,                            -- best-effort link a orders.external_id
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, customer_phone)
);

ALTER TABLE public.wa_conversations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "members read wa conversations" ON public.wa_conversations;
CREATE POLICY "members read wa conversations" ON public.wa_conversations
  FOR SELECT TO authenticated
  USING (public.is_store_member(store_id));

DROP POLICY IF EXISTS "members update wa conversations" ON public.wa_conversations;
CREATE POLICY "members update wa conversations" ON public.wa_conversations
  FOR UPDATE TO authenticated
  USING (public.is_store_member(store_id))
  WITH CHECK (public.is_store_member(store_id));

CREATE INDEX IF NOT EXISTS idx_wa_conversations_store_phone
  ON public.wa_conversations (store_id, customer_phone);
CREATE INDEX IF NOT EXISTS idx_wa_conversations_store_lastmsg
  ON public.wa_conversations (store_id, last_message_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- 3. wa_messages — cada mensaje entrante/saliente.
--    Miembros leen. INSERT/UPDATE vía service role (webhook / wa-send).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.wa_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id        uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.wa_conversations(id) ON DELETE CASCADE,
  channel_id      uuid REFERENCES public.wa_channels(id) ON DELETE SET NULL,
  wa_message_id   text,                                 -- id del proveedor (idempotencia)
  direction       text NOT NULL,                        -- 'in' | 'out'
  sender          text NOT NULL DEFAULT 'customer',     -- 'customer'|'ai'|'operator'|'system'
  body            text,
  media           jsonb,
  status          text NOT NULL DEFAULT 'received',     -- received|queued|sent|delivered|read|failed
  ai_generated    boolean NOT NULL DEFAULT false,
  operator_id     uuid,
  provider_ts     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.wa_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "members read wa messages" ON public.wa_messages;
CREATE POLICY "members read wa messages" ON public.wa_messages
  FOR SELECT TO authenticated
  USING (public.is_store_member(store_id));

-- Idempotencia: un mismo wa_message_id no se duplica por tienda.
CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_messages_provider_id
  ON public.wa_messages (store_id, wa_message_id)
  WHERE wa_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wa_messages_conversation
  ON public.wa_messages (conversation_id, created_at);

-- ─────────────────────────────────────────────────────────────────────────
-- 4. wa_ai_runs — auditoría de cada decisión de la IA (observabilidad + costo).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.wa_ai_runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id           uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  conversation_id    uuid REFERENCES public.wa_conversations(id) ON DELETE CASCADE,
  trigger_message_id uuid REFERENCES public.wa_messages(id) ON DELETE SET NULL,
  model              text,
  prompt_tokens      integer,
  completion_tokens  integer,
  action             text,                              -- 'reply' | 'handoff' | 'noop'
  confidence         text,
  output             text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.wa_ai_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "members read wa ai runs" ON public.wa_ai_runs;
CREATE POLICY "members read wa ai runs" ON public.wa_ai_runs
  FOR SELECT TO authenticated
  USING (public.is_store_member(store_id));

CREATE INDEX IF NOT EXISTS idx_wa_ai_runs_conversation
  ON public.wa_ai_runs (conversation_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- 5. RPCs: upsert del canal (owner-only) + status sin secreto (miembros).
--    Espejo de upsert_store_shopify_config / get_store_shopify_status.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.upsert_wa_channel(
  p_store_id       uuid,
  p_provider       text,
  p_provider_token text,
  p_provider_base  text DEFAULT NULL,
  p_instance_name  text DEFAULT NULL,
  p_phone_number   text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT public.is_store_owner(p_store_id) THEN
    RAISE EXCEPTION 'Solo el dueño de la tienda puede configurar WhatsApp' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.wa_channels (store_id, provider, provider_token, provider_base, instance_name, phone_number)
  VALUES (p_store_id, COALESCE(NULLIF(trim(p_provider), ''), 'whapi'), trim(p_provider_token),
          NULLIF(trim(p_provider_base), ''), NULLIF(trim(p_instance_name), ''), NULLIF(trim(p_phone_number), ''))
  ON CONFLICT (store_id, provider, phone_number) DO UPDATE
    SET provider_token = EXCLUDED.provider_token,
        provider_base  = EXCLUDED.provider_base,
        instance_name  = EXCLUDED.instance_name,
        updated_at     = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Status del canal SIN exponer el token (para que la UI muestre conectado/no).
CREATE OR REPLACE FUNCTION public.get_wa_channel_status(p_store_id uuid)
RETURNS TABLE(channel_id uuid, provider text, phone_number text, status text, updated_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_store_member(p_store_id) THEN
    RAISE EXCEPTION 'No autorizado' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT c.id, c.provider, c.phone_number, c.status, c.updated_at
    FROM public.wa_channels c
    WHERE c.store_id = p_store_id
    ORDER BY c.updated_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_wa_channel(uuid, text, text, text, text, text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.upsert_wa_channel(uuid, text, text, text, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.get_wa_channel_status(uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.get_wa_channel_status(uuid) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 6. Realtime: el drawer del hilo se actualiza sin recargar.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.wa_conversations REPLICA IDENTITY FULL;
ALTER TABLE public.wa_messages       REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'wa_conversations'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.wa_conversations';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'wa_messages'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.wa_messages';
  END IF;
END $$;

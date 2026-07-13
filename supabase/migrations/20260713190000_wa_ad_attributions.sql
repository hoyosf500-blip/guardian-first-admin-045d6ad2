-- Atribución pedido↔anuncio (CTWA — Click-to-WhatsApp).
--
-- Cuando un cliente hace clic en un anuncio "enviar mensaje" de Meta y escribe al
-- bot, el PRIMER mensaje trae el contexto del anuncio (ctwa_clid, id del anuncio,
-- url, copy). Guardian tiene su PROPIO bot, así que captura esta atribución NATIVA
-- (a diferencia de la competencia que depende de un tercero). Este es el paso
-- FUNDACIONAL: guardar el dato desde ya (no perder nada); el reporte/UI viene después.
--
-- Convenciones reusadas (NO inventar):
--   * RLS store-scoped con el helper existente public.is_store_member(uuid) — mismo
--     patrón de SELECT que wa_conversations / wa_messages (20260623000000).
--   * El INSERT lo hace la edge (wa-webhook) con service role → bypassa RLS. Por eso
--     solo declaramos policy de SELECT para miembros.
--   * Idempotencia por wa_message_id UNIQUE (igual que la idempotencia de wa_messages).

CREATE TABLE IF NOT EXISTS public.wa_ad_attributions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id        uuid NOT NULL,
  conversation_id uuid,
  phone           text NOT NULL,
  wa_message_id   text UNIQUE NOT NULL,
  ctwa_clid       text,
  source_id       text,
  source_url      text,
  headline        text,
  body            text,
  media_type      text,
  raw             jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wa_ad_attr_store_phone
  ON public.wa_ad_attributions (store_id, phone);
CREATE INDEX IF NOT EXISTS idx_wa_ad_attr_source
  ON public.wa_ad_attributions (store_id, source_id);

ALTER TABLE public.wa_ad_attributions ENABLE ROW LEVEL SECURITY;

-- Lectura para miembros de la tienda (mismo patrón que wa_conversations / wa_messages).
-- El INSERT lo hace la edge con service role (bypassa RLS) → solo SELECT policy.
DROP POLICY IF EXISTS "members read wa ad attributions" ON public.wa_ad_attributions;
CREATE POLICY "members read wa ad attributions" ON public.wa_ad_attributions
  FOR SELECT TO authenticated
  USING (public.is_store_member(store_id));

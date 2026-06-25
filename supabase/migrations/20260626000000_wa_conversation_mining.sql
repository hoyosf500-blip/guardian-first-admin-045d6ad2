-- Minería de conversaciones reales de WhatsApp → bot que APRENDE SOLO.
--
-- Loop: edge function `wa-mine-conversations` baja los chats reales desde Whapi
-- (API oficial del gateway, NO scraping), kie/Claude extrae por conversación
-- (preguntas, objeciones, miedos, motivo de no-compra, sentimiento), sintetiza
-- por producto un bloque de "conocimiento aprendido", y lo guarda acá. El bot
-- (wa-ai-responder) lo lee EN VIVO con service role y lo inyecta ADITIVO — nunca
-- pisa el conocimiento que el dueño cura a mano en product_knowledge, y NO toca
-- las reglas duras (no inventar guía/estado/tracking).
--
-- 3 tablas:
--   1. wa_scraped_messages     — cache crudo de mensajes (dedup por wa_message_id).
--   2. wa_conversation_insights — 1 fila por (tienda, teléfono) analizado.
--   3. wa_product_learnings     — síntesis por producto (lo que el bot lee).
--
-- Todo manager-only (owner/supervisor) por PII — helper public.is_store_manager
-- (migración 20260522010000). Las edge functions leen/escriben con service role
-- (bypassa RLS), así que las policies son solo para la UI de admin.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. wa_scraped_messages — cache crudo de lo que baja de Whapi.
--    Separado de wa_messages (que es el inbox en vivo) para no mezclar el
--    pipeline de minería con la operación. Dedup idempotente por wa_message_id.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.wa_scraped_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id      uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  chat_id       text,                                -- id de chat de Whapi
  phone         text NOT NULL,                       -- normalizado: join con orders.phone
  customer_name text,
  wa_message_id text NOT NULL,                        -- id del proveedor (idempotencia; siempre presente)
  from_me       boolean NOT NULL DEFAULT false,      -- true = saliente (operadora/bot)
  body          text,
  msg_ts        timestamptz,                         -- timestamp real del mensaje
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.wa_scraped_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "managers read wa scraped messages" ON public.wa_scraped_messages;
CREATE POLICY "managers read wa scraped messages" ON public.wa_scraped_messages
  FOR SELECT TO authenticated
  USING (public.is_store_manager(store_id));

-- Escritura SOLO vía edge functions (service role bypassa RLS). Denegamos explícito
-- a 'authenticated' para que un futuro GRANT accidental no abra escritura directa.
DROP POLICY IF EXISTS "no direct insert wa scraped messages" ON public.wa_scraped_messages;
CREATE POLICY "no direct insert wa scraped messages" ON public.wa_scraped_messages
  FOR INSERT TO authenticated WITH CHECK (false);
DROP POLICY IF EXISTS "no direct delete wa scraped messages" ON public.wa_scraped_messages;
CREATE POLICY "no direct delete wa scraped messages" ON public.wa_scraped_messages
  FOR DELETE TO authenticated USING (false);

-- Dedup: un mismo wa_message_id no se duplica por tienda. Índice NO parcial para
-- que el upsert ON CONFLICT (store_id, wa_message_id) lo pueda inferir (idempotente
-- sin race) — PostgREST no infiere índices parciales.
CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_scraped_provider_id
  ON public.wa_scraped_messages (store_id, wa_message_id);
CREATE INDEX IF NOT EXISTS idx_wa_scraped_store_phone_ts
  ON public.wa_scraped_messages (store_id, phone, msg_ts);

-- ─────────────────────────────────────────────────────────────────────────
-- 2. wa_conversation_insights — qué sacó la IA de cada conversación.
--    UNIQUE (store_id, phone): re-analizar ACTUALIZA la misma fila.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.wa_conversation_insights (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id           uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  phone              text NOT NULL,
  customer_name      text,
  linked_external_id text,                            -- pedido cruzado por teléfono
  producto           text,                            -- de orders.producto (lo que compró)
  product_key        text,                            -- producto normalizado (clave de agrupación)
  order_estado       text,                            -- snapshot del estado (para Fase 2: correlación con venta)
  questions          jsonb NOT NULL DEFAULT '[]'::jsonb,   -- preguntas del cliente
  objections         jsonb NOT NULL DEFAULT '[]'::jsonb,   -- objeciones / dudas que frenan
  fears              jsonb NOT NULL DEFAULT '[]'::jsonb,   -- miedos ("¿es original?", "¿y si no sirve?")
  no_purchase_reason text,                            -- por qué NO compró / no avanzó (si aplica)
  sentiment          text,                            -- positivo | neutral | negativo
  outcome            text,                            -- lectura de la IA: compró | dudó | no_contestó | objetó | reclamó
  summary            text,                            -- resumen 1-2 frases
  msg_count          integer NOT NULL DEFAULT 0,
  model              text,
  analyzed_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, phone)
);

ALTER TABLE public.wa_conversation_insights ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "managers read wa conversation insights" ON public.wa_conversation_insights;
CREATE POLICY "managers read wa conversation insights" ON public.wa_conversation_insights
  FOR SELECT TO authenticated
  USING (public.is_store_manager(store_id));

DROP POLICY IF EXISTS "no direct insert wa conversation insights" ON public.wa_conversation_insights;
CREATE POLICY "no direct insert wa conversation insights" ON public.wa_conversation_insights
  FOR INSERT TO authenticated WITH CHECK (false);
DROP POLICY IF EXISTS "no direct delete wa conversation insights" ON public.wa_conversation_insights;
CREATE POLICY "no direct delete wa conversation insights" ON public.wa_conversation_insights
  FOR DELETE TO authenticated USING (false);

CREATE INDEX IF NOT EXISTS idx_wa_insights_store_product
  ON public.wa_conversation_insights (store_id, product_key);

-- ─────────────────────────────────────────────────────────────────────────
-- 3. wa_product_learnings — síntesis por producto. ESTO es lo que el bot lee.
--    UNIQUE (store_id, product_key): cada corrida ACTUALIZA el bloque aprendido.
--    'general' = conversaciones sin pedido cruzado (dudas pre-compra sueltas).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.wa_product_learnings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id       uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  product_key    text NOT NULL,                       -- producto normalizado, o 'general'
  product_label  text NOT NULL,                       -- nombre legible
  learned        text NOT NULL,                       -- bloque sintetizado (FAQ + objeción→respuesta + tono)
  evidence_count integer NOT NULL DEFAULT 0,          -- nº de conversaciones que lo respaldan
  active         boolean NOT NULL DEFAULT true,        -- el dueño puede apagar uno sin borrarlo
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, product_key)
);

ALTER TABLE public.wa_product_learnings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "managers read wa product learnings" ON public.wa_product_learnings;
CREATE POLICY "managers read wa product learnings" ON public.wa_product_learnings
  FOR SELECT TO authenticated
  USING (public.is_store_manager(store_id));

-- El dueño puede ACTUALIZAR (apagar/podar) lo aprendido desde el panel (Fase 3).
-- INSERT lo hace solo la edge function (service role). UPDATE acá = toggle active.
DROP POLICY IF EXISTS "managers update wa product learnings" ON public.wa_product_learnings;
CREATE POLICY "managers update wa product learnings" ON public.wa_product_learnings
  FOR UPDATE TO authenticated
  USING (public.is_store_manager(store_id))
  WITH CHECK (public.is_store_manager(store_id));

-- INSERT solo edge function (service role). DELETE no se permite directo (el toggle
-- active del panel es UPDATE, no DELETE).
DROP POLICY IF EXISTS "no direct insert wa product learnings" ON public.wa_product_learnings;
CREATE POLICY "no direct insert wa product learnings" ON public.wa_product_learnings
  FOR INSERT TO authenticated WITH CHECK (false);
DROP POLICY IF EXISTS "no direct delete wa product learnings" ON public.wa_product_learnings;
CREATE POLICY "no direct delete wa product learnings" ON public.wa_product_learnings
  FOR DELETE TO authenticated USING (false);

CREATE INDEX IF NOT EXISTS idx_wa_learnings_store_active
  ON public.wa_product_learnings (store_id) WHERE active;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. RPC de reporte (manager-only): rollup por producto para /admin.
--    Devuelve lo aprendido + cuántas conversaciones lo respaldan.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.wa_product_insights(p_store_id uuid)
RETURNS TABLE(
  product_key       text,
  product_label     text,
  learned           text,
  evidence_count    integer,
  active            boolean,
  conversations     bigint,
  updated_at        timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_store_manager(p_store_id) THEN
    RAISE EXCEPTION 'No autorizado' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT
      l.product_key,
      l.product_label,
      l.learned,
      l.evidence_count,
      l.active,
      COALESCE(c.n, 0) AS conversations,
      l.updated_at
    FROM public.wa_product_learnings l
    LEFT JOIN (
      SELECT product_key, COUNT(*) AS n
      FROM public.wa_conversation_insights
      WHERE store_id = p_store_id
      GROUP BY product_key
    ) c ON c.product_key = l.product_key
    WHERE l.store_id = p_store_id
    ORDER BY l.evidence_count DESC, l.updated_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.wa_product_insights(uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.wa_product_insights(uuid) TO authenticated;

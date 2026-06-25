
CREATE TABLE IF NOT EXISTS public.wa_scraped_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id      uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  chat_id       text,
  phone         text NOT NULL,
  customer_name text,
  wa_message_id text NOT NULL,
  from_me       boolean NOT NULL DEFAULT false,
  body          text,
  msg_ts        timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.wa_scraped_messages TO authenticated;
GRANT ALL ON public.wa_scraped_messages TO service_role;
ALTER TABLE public.wa_scraped_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "managers read wa scraped messages" ON public.wa_scraped_messages;
CREATE POLICY "managers read wa scraped messages" ON public.wa_scraped_messages
  FOR SELECT TO authenticated USING (public.is_store_manager(store_id));
DROP POLICY IF EXISTS "no direct insert wa scraped messages" ON public.wa_scraped_messages;
CREATE POLICY "no direct insert wa scraped messages" ON public.wa_scraped_messages
  FOR INSERT TO authenticated WITH CHECK (false);
DROP POLICY IF EXISTS "no direct delete wa scraped messages" ON public.wa_scraped_messages;
CREATE POLICY "no direct delete wa scraped messages" ON public.wa_scraped_messages
  FOR DELETE TO authenticated USING (false);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_scraped_provider_id
  ON public.wa_scraped_messages (store_id, wa_message_id);
CREATE INDEX IF NOT EXISTS idx_wa_scraped_store_phone_ts
  ON public.wa_scraped_messages (store_id, phone, msg_ts);

CREATE TABLE IF NOT EXISTS public.wa_conversation_insights (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id           uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  phone              text NOT NULL,
  customer_name      text,
  linked_external_id text,
  producto           text,
  product_key        text,
  order_estado       text,
  questions          jsonb NOT NULL DEFAULT '[]'::jsonb,
  objections         jsonb NOT NULL DEFAULT '[]'::jsonb,
  fears              jsonb NOT NULL DEFAULT '[]'::jsonb,
  no_purchase_reason text,
  sentiment          text,
  outcome            text,
  summary            text,
  msg_count          integer NOT NULL DEFAULT 0,
  model              text,
  analyzed_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, phone)
);
GRANT SELECT ON public.wa_conversation_insights TO authenticated;
GRANT ALL ON public.wa_conversation_insights TO service_role;
ALTER TABLE public.wa_conversation_insights ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "managers read wa conversation insights" ON public.wa_conversation_insights;
CREATE POLICY "managers read wa conversation insights" ON public.wa_conversation_insights
  FOR SELECT TO authenticated USING (public.is_store_manager(store_id));
DROP POLICY IF EXISTS "no direct insert wa conversation insights" ON public.wa_conversation_insights;
CREATE POLICY "no direct insert wa conversation insights" ON public.wa_conversation_insights
  FOR INSERT TO authenticated WITH CHECK (false);
DROP POLICY IF EXISTS "no direct delete wa conversation insights" ON public.wa_conversation_insights;
CREATE POLICY "no direct delete wa conversation insights" ON public.wa_conversation_insights
  FOR DELETE TO authenticated USING (false);
CREATE INDEX IF NOT EXISTS idx_wa_insights_store_product
  ON public.wa_conversation_insights (store_id, product_key);

CREATE TABLE IF NOT EXISTS public.wa_product_learnings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id       uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  product_key    text NOT NULL,
  product_label  text NOT NULL,
  learned        text NOT NULL,
  evidence_count integer NOT NULL DEFAULT 0,
  active         boolean NOT NULL DEFAULT true,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, product_key)
);
GRANT SELECT, UPDATE ON public.wa_product_learnings TO authenticated;
GRANT ALL ON public.wa_product_learnings TO service_role;
ALTER TABLE public.wa_product_learnings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "managers read wa product learnings" ON public.wa_product_learnings;
CREATE POLICY "managers read wa product learnings" ON public.wa_product_learnings
  FOR SELECT TO authenticated USING (public.is_store_manager(store_id));
DROP POLICY IF EXISTS "managers update wa product learnings" ON public.wa_product_learnings;
CREATE POLICY "managers update wa product learnings" ON public.wa_product_learnings
  FOR UPDATE TO authenticated USING (public.is_store_manager(store_id))
  WITH CHECK (public.is_store_manager(store_id));
DROP POLICY IF EXISTS "no direct insert wa product learnings" ON public.wa_product_learnings;
CREATE POLICY "no direct insert wa product learnings" ON public.wa_product_learnings
  FOR INSERT TO authenticated WITH CHECK (false);
DROP POLICY IF EXISTS "no direct delete wa product learnings" ON public.wa_product_learnings;
CREATE POLICY "no direct delete wa product learnings" ON public.wa_product_learnings
  FOR DELETE TO authenticated USING (false);
CREATE INDEX IF NOT EXISTS idx_wa_learnings_store_active
  ON public.wa_product_learnings (store_id) WHERE active;

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
GRANT EXECUTE ON FUNCTION public.wa_product_insights(uuid) TO authenticated;

CREATE TABLE IF NOT EXISTS public.product_knowledge (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id         uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  label            text NOT NULL,
  match_text       text,
  dropi_product_id bigint,
  knowledge        text NOT NULL,
  image_url        text,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_knowledge TO authenticated;
GRANT ALL ON public.product_knowledge TO service_role;

CREATE INDEX IF NOT EXISTS idx_product_knowledge_store_active
  ON public.product_knowledge (store_id) WHERE active;

ALTER TABLE public.product_knowledge ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "managers read product knowledge" ON public.product_knowledge;
CREATE POLICY "managers read product knowledge" ON public.product_knowledge
  FOR SELECT TO authenticated USING (public.is_store_manager(store_id));

CREATE OR REPLACE FUNCTION public.upsert_product_knowledge(
  p_store_id uuid, p_label text, p_knowledge text,
  p_id uuid DEFAULT NULL, p_match_text text DEFAULT NULL,
  p_dropi_product_id bigint DEFAULT NULL, p_image_url text DEFAULT NULL,
  p_active boolean DEFAULT true
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT public.is_store_manager(p_store_id) THEN
    RAISE EXCEPTION 'Solo el dueño o supervisor puede configurar productos' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(NULLIF(trim(p_label), ''), '') = '' THEN
    RAISE EXCEPTION 'El nombre del producto es obligatorio' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(NULLIF(trim(p_knowledge), ''), '') = '' THEN
    RAISE EXCEPTION 'El conocimiento del producto es obligatorio' USING ERRCODE = '22023';
  END IF;
  IF p_id IS NULL THEN
    INSERT INTO public.product_knowledge (store_id, label, match_text, dropi_product_id, knowledge, image_url, active)
    VALUES (p_store_id, trim(p_label), NULLIF(trim(p_match_text), ''), p_dropi_product_id,
            trim(p_knowledge), NULLIF(trim(p_image_url), ''), COALESCE(p_active, true))
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.product_knowledge SET
      label = trim(p_label), match_text = NULLIF(trim(p_match_text), ''),
      dropi_product_id = p_dropi_product_id, knowledge = trim(p_knowledge),
      image_url = NULLIF(trim(p_image_url), ''), active = COALESCE(p_active, true), updated_at = now()
    WHERE id = p_id AND store_id = p_store_id
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'Producto no encontrado en esta tienda' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION public.delete_product_knowledge(p_store_id uuid, p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_store_manager(p_store_id) THEN
    RAISE EXCEPTION 'No autorizado' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.product_knowledge WHERE id = p_id AND store_id = p_store_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Producto no encontrado en esta tienda' USING ERRCODE = 'P0002';
  END IF;
END; $$;

REVOKE ALL ON FUNCTION public.upsert_product_knowledge(uuid, text, text, uuid, text, bigint, text, boolean) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.upsert_product_knowledge(uuid, text, text, uuid, text, bigint, text, boolean) TO authenticated;

REVOKE ALL ON FUNCTION public.delete_product_knowledge(uuid, uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.delete_product_knowledge(uuid, uuid) TO authenticated;

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS product_ids text;
-- Conocimiento por producto para el bot de WhatsApp — editable desde
-- /admin → "Productos (bot)".
--
-- El bot (wa-ai-responder) lee estas filas EN VIVO con service role e inyecta el
-- conocimiento del producto del pedido en la conversación, para responder qué es
-- el producto / para qué sirve / cómo se usa / dudas comunes. NO toca las reglas
-- de seguridad (no inventar guía/estado/tracking) — eso va en bloque aparte.
--
-- Matching (híbrido): el bot prefiere por dropi_product_id (cuando orders.product_ids
-- esté poblado, Fase B); si no, cae a match por nombre (match_text ⊂ orders.producto).
--
-- Solo managers (owner o supervisor) ven/editan — helper public.is_store_manager
-- (migración 20260522010000). Espejo de wa_bot_config / shopify_product_dropi_map.

CREATE TABLE IF NOT EXISTS public.product_knowledge (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id         uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  label            text NOT NULL,                 -- nombre legible (lo que ve el dueño)
  match_text       text,                          -- substring contra orders.producto (match por nombre, hoy)
  dropi_product_id bigint,                        -- match exacto por id de Dropi (Fase B)
  knowledge        text NOT NULL,                 -- qué es / beneficios / uso / objeciones
  image_url        text,                          -- (opcional) foto del producto
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_knowledge_store_active
  ON public.product_knowledge (store_id) WHERE active;

ALTER TABLE public.product_knowledge ENABLE ROW LEVEL SECURITY;

-- Solo managers (dueño o supervisor) leen. La edge function la lee con service
-- role (bypassa RLS), así que no depende de esta policy.
DROP POLICY IF EXISTS "managers read product knowledge" ON public.product_knowledge;
CREATE POLICY "managers read product knowledge" ON public.product_knowledge
  FOR SELECT TO authenticated
  USING (public.is_store_manager(store_id));

-- Upsert gated a manager. p_id NULL = alta; con id = edición de esa fila.
-- (p_store_id, p_label, p_knowledge obligatorios; el resto con default.)
CREATE OR REPLACE FUNCTION public.upsert_product_knowledge(
  p_store_id         uuid,
  p_label            text,
  p_knowledge        text,
  p_id               uuid    DEFAULT NULL,
  p_match_text       text    DEFAULT NULL,
  p_dropi_product_id bigint  DEFAULT NULL,
  p_image_url        text    DEFAULT NULL,
  p_active           boolean DEFAULT true
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid;
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
    VALUES (
      p_store_id,
      trim(p_label),
      NULLIF(trim(p_match_text), ''),
      p_dropi_product_id,
      trim(p_knowledge),
      NULLIF(trim(p_image_url), ''),
      COALESCE(p_active, true)
    )
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.product_knowledge SET
      label            = trim(p_label),
      match_text       = NULLIF(trim(p_match_text), ''),
      dropi_product_id = p_dropi_product_id,
      knowledge        = trim(p_knowledge),
      image_url        = NULLIF(trim(p_image_url), ''),
      active           = COALESCE(p_active, true),
      updated_at       = now()
    WHERE id = p_id AND store_id = p_store_id
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'Producto no encontrado en esta tienda' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_product_knowledge(
  p_store_id uuid,
  p_id       uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_store_manager(p_store_id) THEN
    RAISE EXCEPTION 'No autorizado' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.product_knowledge WHERE id = p_id AND store_id = p_store_id;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_product_knowledge(uuid, text, text, uuid, text, bigint, text, boolean) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.upsert_product_knowledge(uuid, text, text, uuid, text, bigint, text, boolean) TO authenticated;
REVOKE ALL ON FUNCTION public.delete_product_knowledge(uuid, uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.delete_product_knowledge(uuid, uuid) TO authenticated;

-- orders.product_ids: lo llena la Fase B (el mapper extrae orderdetails[].product.id,
-- coma-joined). Se agrega ya, idempotente, para que wa-ai-responder lo pueda leer
-- sin romper aunque todavía esté NULL.
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS product_ids text;

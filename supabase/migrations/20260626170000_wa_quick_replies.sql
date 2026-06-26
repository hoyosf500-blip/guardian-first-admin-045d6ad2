-- Respuestas rápidas (canned responses) del inbox de WhatsApp, por tienda.
--
-- Plantillas de un clic que las asesoras insertan en el composer del hilo
-- (/seguimiento → WhatsApp). LECTURA: cualquier MIEMBRO de la tienda (las
-- operadoras las usan). ESCRITURA: solo managers (owner/supervisor) las curan,
-- vía RPC — mismo patrón que upsert_wa_bot_config.
--
-- Usa los helpers existentes public.is_store_member / public.is_store_manager
-- (migraciones 20260521* / 20260522010000). NO aplicar sin coordinar.

CREATE TABLE IF NOT EXISTS public.wa_quick_replies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  label       text NOT NULL,                        -- título corto que se ve en el picker
  body        text NOT NULL,                        -- el mensaje que se inserta
  sort_order  integer NOT NULL DEFAULT 0,           -- orden manual en el picker
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wa_quick_replies_store_idx
  ON public.wa_quick_replies (store_id, sort_order);

ALTER TABLE public.wa_quick_replies ENABLE ROW LEVEL SECURITY;

-- Lectura: cualquier miembro de la tienda (las operadoras las usan en el inbox).
DROP POLICY IF EXISTS "members read wa quick replies" ON public.wa_quick_replies;
CREATE POLICY "members read wa quick replies" ON public.wa_quick_replies
  FOR SELECT TO authenticated
  USING (public.is_store_member(store_id));

-- Escritura: solo via RPC (manager-only). Sin policy de INSERT/UPDATE/DELETE
-- directa → el cliente no puede escribir saltándose la RPC.

-- Crear / actualizar (p_id NULL = crear). Manager-only.
CREATE OR REPLACE FUNCTION public.upsert_wa_quick_reply(
  p_store_id   uuid,
  p_label      text,
  p_body       text,
  p_id         uuid DEFAULT NULL,
  p_sort_order integer DEFAULT 0
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT public.is_store_manager(p_store_id) THEN
    RAISE EXCEPTION 'Solo el dueño o supervisor puede gestionar respuestas rápidas' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(trim(p_label), '') = '' OR COALESCE(trim(p_body), '') = '' THEN
    RAISE EXCEPTION 'Etiqueta y mensaje son obligatorios' USING ERRCODE = '22023';
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.wa_quick_replies (store_id, label, body, sort_order)
    VALUES (p_store_id, trim(p_label), trim(p_body), COALESCE(p_sort_order, 0))
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.wa_quick_replies
      SET label = trim(p_label),
          body = trim(p_body),
          sort_order = COALESCE(p_sort_order, 0),
          updated_at = now()
      WHERE id = p_id AND store_id = p_store_id
      RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'Respuesta rápida no encontrada para esta tienda' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  RETURN v_id;
END;
$$;

-- Borrar. Manager-only (chequea el dueño/supervisor de la tienda dueña de la fila).
CREATE OR REPLACE FUNCTION public.delete_wa_quick_reply(p_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_store uuid;
BEGIN
  SELECT store_id INTO v_store FROM public.wa_quick_replies WHERE id = p_id;
  IF v_store IS NULL THEN RETURN; END IF; -- idempotente
  IF NOT public.is_store_manager(v_store) THEN
    RAISE EXCEPTION 'Solo el dueño o supervisor puede borrar respuestas rápidas' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.wa_quick_replies WHERE id = p_id;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_wa_quick_reply(uuid, text, text, uuid, integer) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.upsert_wa_quick_reply(uuid, text, text, uuid, integer) TO authenticated;
REVOKE ALL ON FUNCTION public.delete_wa_quick_reply(uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.delete_wa_quick_reply(uuid) TO authenticated;

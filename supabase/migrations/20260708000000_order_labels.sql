-- Etiquetas MANUALES por pedido (Fase 2b del rediseño multi-asesor).
--
-- Las asesoras marcan un cliente con etiquetas de juicio humano ("Interesado",
-- "Difícil") que TODAS ven, para no repetir análisis. Las etiquetas AUTOMÁTICAS
-- ("Datos incompletos", "No contesta") NO se guardan acá: se derivan al render de
-- datos que ya existen (validationDecision/missingFields y el conteo de noresp),
-- así no hay que mantenerlas ni migrarlas. Esta tabla es solo para las manuales.
--
-- Modelo/RLS espeja `notes` (compartido por tienda, is_store_member): cualquier
-- miembro ve y pone etiquetas; solo el autor las quita (o un manager). Una etiqueta
-- por pedido (UNIQUE order_id+label) → poner/quitar = insert/delete idempotente.

CREATE TABLE IF NOT EXISTS public.order_labels (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid REFERENCES public.orders(id) ON DELETE CASCADE,
  phone       text,
  label       text NOT NULL,          -- 'dificil' | 'interesado' (solo manuales)
  operator_id uuid REFERENCES auth.users(id),
  store_id    uuid REFERENCES public.stores(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, label)
);

CREATE INDEX IF NOT EXISTS idx_order_labels_order_id ON public.order_labels(order_id);
CREATE INDEX IF NOT EXISTS idx_order_labels_store    ON public.order_labels(store_id);

ALTER TABLE public.order_labels ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS order_labels_select_member ON public.order_labels;
DROP POLICY IF EXISTS order_labels_insert_member ON public.order_labels;
DROP POLICY IF EXISTS order_labels_delete_author ON public.order_labels;

-- Cualquier miembro de la tienda ve las etiquetas de la tienda (compartido).
CREATE POLICY order_labels_select_member ON public.order_labels
  FOR SELECT TO authenticated
  USING (public.is_store_member(store_id));

-- Insertar: solo miembros de la tienda, y el operator_id debe ser uno mismo.
CREATE POLICY order_labels_insert_member ON public.order_labels
  FOR INSERT TO authenticated
  WITH CHECK (operator_id = auth.uid() AND public.is_store_member(store_id));

-- Quitar: el autor, o un manager (owner/supervisor) de la tienda.
CREATE POLICY order_labels_delete_author ON public.order_labels
  FOR DELETE TO authenticated
  USING (operator_id = auth.uid() OR public.is_store_manager(store_id));

-- Realtime para que una etiqueta puesta por una asesora aparezca en vivo en las demás.
-- Idempotente: no re-agregar si ya está en la publicación.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'order_labels'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.order_labels;
  END IF;
END$$;

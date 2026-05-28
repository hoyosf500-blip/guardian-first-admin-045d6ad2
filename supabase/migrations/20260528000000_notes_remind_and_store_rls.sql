-- Notas y recordatorios por pedido.
--
-- 1) `remind_at`: las asesoras dejan recordatorios con fecha/hora ("recoge el
--    viernes 3pm", "llamar a las 4"). La UI lo usa para resaltar el pedido
--    cuando llega la hora y para el filtro "Recordatorios para hoy".
-- 2) `store_id` defensivo: el deployed DB ya lo tiene (per generated types)
--    pero el repo no lo refleja (drift). Idempotente con IF NOT EXISTS.
-- 3) RLS endurecida: la política original (`USING (true)`) dejaba a cualquier
--    autenticado leer notas de cualquier tienda. La reemplazamos por
--    `is_store_member(store_id)` para aislamiento multi-tienda. Editar/borrar
--    queda solo para el autor de la nota.

ALTER TABLE public.notes ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES public.stores(id);
ALTER TABLE public.notes ADD COLUMN IF NOT EXISTS remind_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_notes_order_id ON public.notes(order_id);
-- Índice parcial: el filtro "Recordatorios" solo lee filas con remind_at,
-- así el índice se mantiene chico.
CREATE INDEX IF NOT EXISTS idx_notes_remind_at_pending
  ON public.notes(store_id, remind_at) WHERE remind_at IS NOT NULL;

-- Backfill defensivo: filas viejas sin store_id heredan del pedido.
UPDATE public.notes n
   SET store_id = o.store_id
  FROM public.orders o
 WHERE n.order_id = o.id
   AND n.store_id IS NULL;

-- RLS store-scoped. DROP idempotente (IF EXISTS) por si la migración corre
-- sobre un DB que ya tiene parte aplicada.
DROP POLICY IF EXISTS "Users can view notes"   ON public.notes;
DROP POLICY IF EXISTS "Users can insert notes" ON public.notes;
DROP POLICY IF EXISTS notes_select_member ON public.notes;
DROP POLICY IF EXISTS notes_insert_member ON public.notes;
DROP POLICY IF EXISTS notes_update_author ON public.notes;
DROP POLICY IF EXISTS notes_delete_author ON public.notes;

-- Cualquier miembro de la tienda ve las notas de la tienda (compartido).
CREATE POLICY notes_select_member ON public.notes
  FOR SELECT TO authenticated
  USING (public.is_store_member(store_id));

-- Insertar: solo miembros de la tienda, y el operator_id debe ser uno mismo.
CREATE POLICY notes_insert_member ON public.notes
  FOR INSERT TO authenticated
  WITH CHECK (operator_id = auth.uid() AND public.is_store_member(store_id));

-- Editar/borrar: solo el autor. Las asesoras no se pisan las notas entre sí.
CREATE POLICY notes_update_author ON public.notes
  FOR UPDATE TO authenticated
  USING (operator_id = auth.uid())
  WITH CHECK (operator_id = auth.uid());

CREATE POLICY notes_delete_author ON public.notes
  FOR DELETE TO authenticated
  USING (operator_id = auth.uid());

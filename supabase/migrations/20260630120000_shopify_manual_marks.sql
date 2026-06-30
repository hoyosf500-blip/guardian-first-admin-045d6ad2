-- Historial de "Ya lo metí" (marca manual del panel anti-fuga de Confirmar).
--
-- Problema que resuelve: hoy el botón "Ya lo metí" del ShopifyPendingPanel solo
-- esconde el pedido en sessionStorage (sin hora, sin operadora, sin rastro). Un
-- doble-click hace desaparecer 2 pedidos de la cola y queda IMPOSIBLE auditar
-- cuáles se marcaron ni si de verdad entraron a Dropi ("metió pero no metió").
--
-- Esta tabla persiste cada marca para:
--   1. Auditoría: qué pedido, qué operadora, a qué hora.
--   2. Revertir: marcar reverted_at -> el pedido vuelve a la cola de pendientes.
--   3. Anti-doble-marca: índice único parcial sobre marcas ACTIVAS (una sola
--      marca viva por pedido). Si se revierte y se vuelve a marcar, se permite.
--
-- La escribe el CLIENTE (la asesora) desde el navegador — por eso, a diferencia
-- de shopify_pushed_orders (service role), acá SÍ damos INSERT/UPDATE a miembros
-- de la tienda, con WITH CHECK de membresía + operator_id = auth.uid().

CREATE TABLE IF NOT EXISTS public.shopify_manual_marks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id         uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  operator_id      uuid NOT NULL REFERENCES auth.users(id),
  shopify_order_id text NOT NULL,                 -- = ShopifyPendingItem.id (para cruzar con Dropi)
  shopify_name     text,                          -- "#1234" (legible)
  customer         text,
  phone            text,
  total            numeric,
  city             text,
  marked_at        timestamptz NOT NULL DEFAULT now(),
  reverted_at      timestamptz,                   -- null = marca activa
  reverted_by      uuid REFERENCES auth.users(id)
);

-- Lectura del historial por día (filtro de fechas del modal).
CREATE INDEX IF NOT EXISTS shopify_manual_marks_store_idx
  ON public.shopify_manual_marks (store_id, marked_at DESC);

-- Anti-doble-marca a nivel DB: una sola marca VIVA por (tienda, pedido).
-- Parcial (WHERE reverted_at IS NULL) para que revertir + re-marcar sea válido.
CREATE UNIQUE INDEX IF NOT EXISTS shopify_manual_marks_active_uniq
  ON public.shopify_manual_marks (store_id, shopify_order_id)
  WHERE reverted_at IS NULL;

ALTER TABLE public.shopify_manual_marks ENABLE ROW LEVEL SECURITY;

-- Miembros de la tienda ven el historial.
DROP POLICY IF EXISTS "members read marks" ON public.shopify_manual_marks;
CREATE POLICY "members read marks" ON public.shopify_manual_marks
  FOR SELECT TO authenticated
  USING (public.is_store_member(store_id));

-- Marcar: el operador inserta su propia marca en una tienda de la que es miembro.
DROP POLICY IF EXISTS "members insert own marks" ON public.shopify_manual_marks;
CREATE POLICY "members insert own marks" ON public.shopify_manual_marks
  FOR INSERT TO authenticated
  WITH CHECK (public.is_store_member(store_id) AND operator_id = auth.uid());

-- Revertir: cualquier miembro de la tienda puede revertir (la asesora corrige su
-- error; el supervisor/dueño audita). Es un UPDATE de reverted_at/reverted_by,
-- no un DELETE — la marca original queda como traza.
DROP POLICY IF EXISTS "members update marks" ON public.shopify_manual_marks;
CREATE POLICY "members update marks" ON public.shopify_manual_marks
  FOR UPDATE TO authenticated
  USING (public.is_store_member(store_id))
  WITH CHECK (public.is_store_member(store_id));

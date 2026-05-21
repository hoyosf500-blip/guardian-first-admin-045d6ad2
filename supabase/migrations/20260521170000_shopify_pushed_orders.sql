-- Subir pedidos atascados de Shopify → Dropi (estilo Dropify).
--
-- Cuando la automatización Shopify→Dropi falla, quedan ventas en Shopify que
-- nunca se despachan. El panel anti-fuga ya las detecta; esta tabla registra
-- los empujes manuales (un clic "Subir a Dropi") para:
--   1. Idempotencia: NO crear dos veces el mismo pedido en Dropi (doble clic
--      = doble guía = doble flete). UNIQUE(store_id, shopify_order_id).
--   2. Auditoría: qué se mandó, quién, cuándo, y el id de la orden Dropi creada.
--
-- La edge function shopify-push-dropi escribe acá con service role.

CREATE TABLE IF NOT EXISTS public.shopify_pushed_orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id         uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  shopify_order_id text NOT NULL,
  dropi_order_id   text,
  status           text NOT NULL DEFAULT 'created',  -- created | error
  payload          jsonb,                            -- lo que se mandó a Dropi (auditoría)
  error_message    text,
  pushed_by        uuid REFERENCES auth.users(id),
  pushed_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, shopify_order_id)
);

CREATE INDEX IF NOT EXISTS shopify_pushed_orders_store_idx
  ON public.shopify_pushed_orders (store_id, pushed_at DESC);

ALTER TABLE public.shopify_pushed_orders ENABLE ROW LEVEL SECURITY;

-- Miembros de la tienda pueden ver el historial. La escritura es solo vía la
-- edge function (service role, no sujeta a RLS) — no damos INSERT a clientes
-- para que el id de orden creada y el payload no se puedan falsear.
DROP POLICY IF EXISTS "members read pushed" ON public.shopify_pushed_orders;
CREATE POLICY "members read pushed" ON public.shopify_pushed_orders
  FOR SELECT TO authenticated
  USING (public.is_store_member(store_id));

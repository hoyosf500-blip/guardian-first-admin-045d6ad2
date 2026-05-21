CREATE TABLE IF NOT EXISTS public.shopify_pushed_orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id         uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  shopify_order_id text NOT NULL,
  dropi_order_id   text,
  status           text NOT NULL DEFAULT 'created',
  payload          jsonb,
  error_message    text,
  pushed_by        uuid REFERENCES auth.users(id),
  pushed_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, shopify_order_id)
);

CREATE INDEX IF NOT EXISTS shopify_pushed_orders_store_idx
  ON public.shopify_pushed_orders (store_id, pushed_at DESC);

ALTER TABLE public.shopify_pushed_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "members read pushed" ON public.shopify_pushed_orders;
CREATE POLICY "members read pushed" ON public.shopify_pushed_orders
  FOR SELECT TO authenticated
  USING (public.is_store_member(store_id));
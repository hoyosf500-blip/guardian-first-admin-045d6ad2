
CREATE TABLE IF NOT EXISTS public.shopify_product_dropi_map (
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  shopify_product_id bigint NOT NULL,
  dropi_product_id bigint NOT NULL,
  dropi_variation_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  PRIMARY KEY (store_id, shopify_product_id)
);

ALTER TABLE public.shopify_product_dropi_map ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "members read map" ON public.shopify_product_dropi_map;
CREATE POLICY "members read map" ON public.shopify_product_dropi_map
  FOR SELECT TO authenticated USING (public.is_store_member(store_id));

CREATE OR REPLACE FUNCTION public.upsert_shopify_product_dropi_map(
  p_store_id uuid,
  p_shopify_product_id bigint,
  p_dropi_product_id bigint,
  p_dropi_variation_id bigint DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_store_member(p_store_id) THEN
    RAISE EXCEPTION 'No autorizado' USING ERRCODE='42501';
  END IF;
  INSERT INTO public.shopify_product_dropi_map(
    store_id, shopify_product_id, dropi_product_id, dropi_variation_id, created_by
  ) VALUES (
    p_store_id, p_shopify_product_id, p_dropi_product_id, p_dropi_variation_id, auth.uid()
  )
  ON CONFLICT (store_id, shopify_product_id) DO UPDATE SET
    dropi_product_id = EXCLUDED.dropi_product_id,
    dropi_variation_id = EXCLUDED.dropi_variation_id,
    created_by = auth.uid(),
    created_at = now();
END $$;

CREATE OR REPLACE FUNCTION public.delete_shopify_product_dropi_map(
  p_store_id uuid,
  p_shopify_product_id bigint
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_store_member(p_store_id) THEN
    RAISE EXCEPTION 'No autorizado' USING ERRCODE='42501';
  END IF;
  DELETE FROM public.shopify_product_dropi_map
    WHERE store_id = p_store_id AND shopify_product_id = p_shopify_product_id;
END $$;

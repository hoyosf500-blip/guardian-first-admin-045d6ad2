-- Delete duplicates keeping only the newest row per external_id
DELETE FROM public.orders
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY external_id ORDER BY created_at DESC) as rn
    FROM public.orders
    WHERE external_id IS NOT NULL
  ) sub
  WHERE rn > 1
);

-- Now create the unique partial index
CREATE UNIQUE INDEX orders_external_id_unique ON public.orders (external_id) WHERE external_id IS NOT NULL;
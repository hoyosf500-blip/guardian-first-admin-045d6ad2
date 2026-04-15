DROP INDEX IF EXISTS orders_external_id_unique;
ALTER TABLE public.orders ADD CONSTRAINT orders_external_id_key UNIQUE (external_id);
SET lock_timeout = '5s';

DO $$
DECLARE n_null bigint;
BEGIN
  SELECT count(*) INTO n_null FROM public.order_status_history WHERE store_id IS NULL;
  IF n_null > 0 THEN
    RAISE WARNING 'order_status_history: % filas con store_id NULL quedan ocultas', n_null;
  ELSE
    RAISE NOTICE 'order_status_history: 0 filas con store_id NULL';
  END IF;
END $$;

DROP POLICY IF EXISTS "members read order status history" ON public.order_status_history;

CREATE POLICY "members read order status history" ON public.order_status_history
  FOR SELECT TO authenticated
  USING (public.is_store_member(store_id));
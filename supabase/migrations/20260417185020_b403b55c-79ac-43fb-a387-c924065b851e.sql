
-- 1. Add lock columns to orders
ALTER TABLE public.orders
  ADD COLUMN locked_by UUID REFERENCES auth.users(id),
  ADD COLUMN locked_at TIMESTAMPTZ;

-- Partial index for active locks
CREATE INDEX idx_orders_locked ON public.orders(locked_by) WHERE locked_by IS NOT NULL;

-- 2. RPC: claim_order — atomically lock a order for the calling operator
CREATE OR REPLACE FUNCTION public.claim_order(p_order_id UUID)
RETURNS SETOF public.orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'operator') AND NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'No tienes permiso para reclamar pedidos';
  END IF;

  RETURN QUERY
  UPDATE public.orders
  SET locked_by = auth.uid(),
      locked_at = NOW()
  WHERE id = p_order_id
    AND (locked_by IS NULL
         OR locked_by = auth.uid()
         OR locked_at < NOW() - INTERVAL '15 minutes')
  RETURNING *;
END;
$$;

-- 3. RPC: release_order — clear lock after processing
CREATE OR REPLACE FUNCTION public.release_order(p_order_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.orders
  SET locked_by = NULL, locked_at = NULL
  WHERE id = p_order_id
    AND (locked_by = auth.uid() OR public.has_role(auth.uid(), 'admin'));
END;
$$;

-- 4. Cron: clean stale locks every minute
SELECT cron.schedule(
  'release-stale-locks',
  '* * * * *',
  $$UPDATE public.orders SET locked_by = NULL, locked_at = NULL WHERE locked_by IS NOT NULL AND locked_at < NOW() - INTERVAL '15 minutes'$$
);

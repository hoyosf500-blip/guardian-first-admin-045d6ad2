ALTER TABLE public.order_results
  ADD COLUMN IF NOT EXISTS dropi_sync_status text NOT NULL DEFAULT 'synced',
  ADD COLUMN IF NOT EXISTS result_notes text;

ALTER TABLE public.order_results
  DROP CONSTRAINT IF EXISTS order_results_dropi_sync_status_check;

ALTER TABLE public.order_results
  ADD CONSTRAINT order_results_dropi_sync_status_check
  CHECK (dropi_sync_status IN ('synced', 'pending', 'failed'));

CREATE INDEX IF NOT EXISTS idx_order_results_dropi_sync_status
  ON public.order_results (dropi_sync_status)
  WHERE dropi_sync_status IN ('pending', 'failed');
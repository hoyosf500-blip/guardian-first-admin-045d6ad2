ALTER TABLE public.order_status_history
  ADD COLUMN IF NOT EXISTS dropi_history_id bigint;

CREATE UNIQUE INDEX IF NOT EXISTS uq_osh_dropi_history_id
  ON public.order_status_history (dropi_history_id);
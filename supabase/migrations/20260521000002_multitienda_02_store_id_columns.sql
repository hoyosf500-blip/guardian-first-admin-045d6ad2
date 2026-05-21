-- Multi-tienda SP1a — Migración 2/3: store_id (nullable) + índices.
-- Aditiva. NO toca RLS de estas tablas (eso es SP1b).

ALTER TABLE public.orders                   ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);
ALTER TABLE public.order_results            ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);
ALTER TABLE public.notes                    ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);
ALTER TABLE public.touchpoints              ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);
ALTER TABLE public.address_validations      ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);
ALTER TABLE public.dropi_wallet_movements   ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);
ALTER TABLE public.monthly_ad_spend         ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);
ALTER TABLE public.monthly_business_inputs  ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);
ALTER TABLE public.tc_debt_snapshots        ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);
ALTER TABLE public.personal_card_movements  ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);
ALTER TABLE public.cfo_monthly_retrospective ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);
ALTER TABLE public.daily_reports            ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);
ALTER TABLE public.operator_daily_reports   ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);
ALTER TABLE public.sync_logs                ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);
ALTER TABLE public.audit_log                ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);
ALTER TABLE public.operator_pool            ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(id);

CREATE INDEX IF NOT EXISTS idx_orders_store                   ON public.orders(store_id);
CREATE INDEX IF NOT EXISTS idx_order_results_store            ON public.order_results(store_id);
CREATE INDEX IF NOT EXISTS idx_notes_store                    ON public.notes(store_id);
CREATE INDEX IF NOT EXISTS idx_touchpoints_store              ON public.touchpoints(store_id);
CREATE INDEX IF NOT EXISTS idx_address_validations_store      ON public.address_validations(store_id);
CREATE INDEX IF NOT EXISTS idx_dropi_wallet_movements_store   ON public.dropi_wallet_movements(store_id);
CREATE INDEX IF NOT EXISTS idx_monthly_ad_spend_store         ON public.monthly_ad_spend(store_id);
CREATE INDEX IF NOT EXISTS idx_monthly_business_inputs_store  ON public.monthly_business_inputs(store_id);
CREATE INDEX IF NOT EXISTS idx_tc_debt_snapshots_store        ON public.tc_debt_snapshots(store_id);
CREATE INDEX IF NOT EXISTS idx_personal_card_movements_store  ON public.personal_card_movements(store_id);
CREATE INDEX IF NOT EXISTS idx_cfo_monthly_retrospective_store ON public.cfo_monthly_retrospective(store_id);
CREATE INDEX IF NOT EXISTS idx_daily_reports_store            ON public.daily_reports(store_id);
CREATE INDEX IF NOT EXISTS idx_operator_daily_reports_store   ON public.operator_daily_reports(store_id);
CREATE INDEX IF NOT EXISTS idx_sync_logs_store                ON public.sync_logs(store_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_store                ON public.audit_log(store_id);
CREATE INDEX IF NOT EXISTS idx_operator_pool_store            ON public.operator_pool(store_id);

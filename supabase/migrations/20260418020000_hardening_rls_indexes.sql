-- Hardening final: RLS más estricto en operator_daily_reports e índices
-- para las consultas calientes del CRM (seguimiento, rescate, rescate-cron).

-- 1) operator_daily_reports: separar políticas.
--    - operator: SELECT/INSERT/UPDATE solo su propia fila; NO DELETE.
--    - admin  : SELECT global + DELETE (para reabrir un turno manualmente).
DROP POLICY IF EXISTS "Operators manage own daily reports" ON public.operator_daily_reports;
DROP POLICY IF EXISTS "Operators insert own daily reports" ON public.operator_daily_reports;
DROP POLICY IF EXISTS "Operators read own daily reports"   ON public.operator_daily_reports;
DROP POLICY IF EXISTS "Operators update own daily reports" ON public.operator_daily_reports;
DROP POLICY IF EXISTS "Admins read all daily reports"      ON public.operator_daily_reports;
DROP POLICY IF EXISTS "Admins delete daily reports"        ON public.operator_daily_reports;

ALTER TABLE public.operator_daily_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Operators read own daily reports"
  ON public.operator_daily_reports
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Operators insert own daily reports"
  ON public.operator_daily_reports
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Operators update own daily reports"
  ON public.operator_daily_reports
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Admins read all daily reports"
  ON public.operator_daily_reports
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'admin'));

CREATE POLICY "Admins delete daily reports"
  ON public.operator_daily_reports
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'admin'));

-- 2) Índices para consultas calientes.
CREATE INDEX IF NOT EXISTS idx_order_results_operator_module_date
  ON public.order_results (operator_id, module, result_date DESC);

CREATE INDEX IF NOT EXISTS idx_order_results_phone_date
  ON public.order_results (phone, result_date DESC);

CREATE INDEX IF NOT EXISTS idx_order_results_order_id
  ON public.order_results (order_id);

CREATE INDEX IF NOT EXISTS idx_order_results_pending_sync
  ON public.order_results (result_date)
  WHERE dropi_sync_status IN ('pending', 'failed') AND result = 'conf';

CREATE INDEX IF NOT EXISTS idx_orders_estado
  ON public.orders (estado);

CREATE INDEX IF NOT EXISTS idx_orders_phone
  ON public.orders (phone);

CREATE INDEX IF NOT EXISTS idx_orders_external_id
  ON public.orders (external_id);

CREATE INDEX IF NOT EXISTS idx_touchpoints_phone_date
  ON public.touchpoints (phone, action_date DESC);

-- Fix 23: envolver public.has_role(auth.uid(), ...) en (SELECT ...) para que
-- Postgres lo evalue una sola vez por query y no por cada fila. Mejora
-- noticeable en SELECTs grandes (orders, touchpoints, order_results) cuando
-- las RLS estaban evaluando has_role N veces.

-- app_settings
DROP POLICY IF EXISTS "Admins can read settings" ON public.app_settings;
CREATE POLICY "Admins can read settings" ON public.app_settings
  FOR SELECT TO authenticated
  USING ((SELECT public.has_role(auth.uid(), 'admin'::app_role)));

DROP POLICY IF EXISTS "Admins can insert settings" ON public.app_settings;
CREATE POLICY "Admins can insert settings" ON public.app_settings
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.has_role(auth.uid(), 'admin'::app_role)));

DROP POLICY IF EXISTS "Admins can update settings" ON public.app_settings;
CREATE POLICY "Admins can update settings" ON public.app_settings
  FOR UPDATE TO authenticated
  USING ((SELECT public.has_role(auth.uid(), 'admin'::app_role)));

-- audit_log
DROP POLICY IF EXISTS "Admins can read audit logs" ON public.audit_log;
CREATE POLICY "Admins can read audit logs" ON public.audit_log
  FOR SELECT TO authenticated
  USING ((SELECT public.has_role(auth.uid(), 'admin'::app_role)));

-- daily_reports
DROP POLICY IF EXISTS "Users can view own reports" ON public.daily_reports;
CREATE POLICY "Users can view own reports" ON public.daily_reports
  FOR SELECT TO authenticated
  USING (operator_id = auth.uid() OR (SELECT public.has_role(auth.uid(), 'admin'::app_role)));

-- operator_daily_reports
DROP POLICY IF EXISTS "Operadora ve sus reportes" ON public.operator_daily_reports;
CREATE POLICY "Operadora ve sus reportes" ON public.operator_daily_reports
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR (SELECT public.has_role(auth.uid(), 'admin'::app_role)));

-- operator_pool
DROP POLICY IF EXISTS "Admins manage operator_pool" ON public.operator_pool;
CREATE POLICY "Admins manage operator_pool" ON public.operator_pool
  FOR ALL TO authenticated
  USING ((SELECT public.has_role(auth.uid(), 'admin'::app_role)))
  WITH CHECK ((SELECT public.has_role(auth.uid(), 'admin'::app_role)));

-- order_results
DROP POLICY IF EXISTS "Users can delete own results" ON public.order_results;
CREATE POLICY "Users can delete own results" ON public.order_results
  FOR DELETE TO authenticated
  USING (operator_id = auth.uid() OR (SELECT public.has_role(auth.uid(), 'admin'::app_role)));

DROP POLICY IF EXISTS "Users can view results" ON public.order_results;
CREATE POLICY "Users can view results" ON public.order_results
  FOR SELECT TO authenticated
  USING (
    operator_id = auth.uid()
    OR (SELECT public.has_role(auth.uid(), 'admin'::app_role))
    OR (SELECT public.has_role(auth.uid(), 'operator'::app_role))
  );

-- sync_logs
DROP POLICY IF EXISTS "Admins can view sync logs" ON public.sync_logs;
CREATE POLICY "Admins can view sync logs" ON public.sync_logs
  FOR SELECT TO authenticated
  USING ((SELECT public.has_role(auth.uid(), 'admin'::app_role)));

-- touchpoints
DROP POLICY IF EXISTS "Users can delete own touchpoints" ON public.touchpoints;
CREATE POLICY "Users can delete own touchpoints" ON public.touchpoints
  FOR DELETE TO authenticated
  USING (operator_id = auth.uid() OR (SELECT public.has_role(auth.uid(), 'admin'::app_role)));

-- user_roles
DROP POLICY IF EXISTS "Users can view own roles" ON public.user_roles;
CREATE POLICY "Users can view own roles" ON public.user_roles
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR (SELECT public.has_role(auth.uid(), 'admin'::app_role)));

-- Fix 25: índices faltantes para queries frecuentes (locks, asignación,
-- ordenamiento por created_at, agregaciones de touchpoints/order_results).
CREATE INDEX IF NOT EXISTS idx_orders_locked_by ON public.orders (locked_by) WHERE locked_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_locked_at ON public.orders (locked_at) WHERE locked_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_assigned_to ON public.orders (assigned_to) WHERE assigned_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON public.orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_touchpoints_operator_id ON public.touchpoints (operator_id);
CREATE INDEX IF NOT EXISTS idx_touchpoints_operator_created ON public.touchpoints (operator_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_results_result ON public.order_results (result);
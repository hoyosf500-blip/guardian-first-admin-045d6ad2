-- Fix: operators could update their assigned orders but not orders from the
-- shared Dropi-synced queue, and could not see other operators' results.
-- This completes 20260416220000_fix_orders_rls_operator_view.sql by also
-- opening UPDATE on orders and SELECT on order_results to the 'operator' role.

DROP POLICY IF EXISTS "Users can update orders" ON public.orders;
CREATE POLICY "Users can update orders" ON public.orders
  FOR UPDATE TO authenticated
  USING (
    uploaded_by = auth.uid()
    OR assigned_to = auth.uid()
    OR public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'operator')
  );

DROP POLICY IF EXISTS "Users can view results" ON public.order_results;
CREATE POLICY "Users can view results" ON public.order_results
  FOR SELECT TO authenticated
  USING (
    operator_id = auth.uid()
    OR public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'operator')
  );

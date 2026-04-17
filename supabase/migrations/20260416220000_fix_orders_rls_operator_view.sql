-- Fix: operators could not see orders synced from Dropi because the RLS policy
-- only allowed viewing orders where uploaded_by = auth.uid().
-- Orders inserted by the Edge Function (dropi-sync) use the admin's user_id
-- or service_role, so regular operators saw nothing in Confirmar/Seguimiento.
-- Solution: allow any authenticated user with the 'operator' role to read all orders.

DROP POLICY IF EXISTS "Users can view orders" ON public.orders;

CREATE POLICY "Users can view orders" ON public.orders
  FOR SELECT TO authenticated
  USING (
    uploaded_by = auth.uid()
    OR assigned_to = auth.uid()
    OR public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'operator')
  );

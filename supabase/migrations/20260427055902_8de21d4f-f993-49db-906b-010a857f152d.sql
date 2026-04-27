-- Fix 1: RLS orders — SELECT abierto para visibilidad mutua, UPDATE restringido al dueño/asignado/lock/admin
DROP POLICY IF EXISTS "Users can view orders" ON public.orders;
CREATE POLICY "Users can view orders" ON public.orders
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Users can update orders" ON public.orders;
CREATE POLICY "Users can update orders" ON public.orders
  FOR UPDATE TO authenticated
  USING (
    (SELECT public.has_role(auth.uid(), 'admin'))
    OR uploaded_by = auth.uid()
    OR assigned_to = auth.uid()
    OR locked_by = auth.uid()
    OR (assigned_to IS NULL AND locked_by IS NULL)
  );

-- Fix 19: handle_new_user sin auto-admin para el primer usuario
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _name TEXT;
BEGIN
  _name := COALESCE(NEW.raw_user_meta_data->>'display_name', NEW.email);
  INSERT INTO public.profiles (user_id, display_name) VALUES (NEW.id, _name);
  -- Solo asignar rol operator. Admin se asigna manualmente desde el dashboard.
  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'operator')
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
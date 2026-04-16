-- Passive audit log for sensitive operations on orders.
-- Fires AFTER UPDATE/DELETE so it NEVER blocks or modifies operations.
-- Does NOT interfere with Dropi sync, RLS policies, or existing triggers.

CREATE TABLE IF NOT EXISTS public.audit_log (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  table_name text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('UPDATE', 'DELETE')),
  row_id text NOT NULL,
  old_data jsonb,
  new_data jsonb,
  changed_fields text[],
  user_id uuid,
  created_at timestamptz DEFAULT now() NOT NULL
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_audit_log_table_row ON public.audit_log(table_name, row_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_user ON public.audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON public.audit_log(created_at DESC);

-- RLS: only admins can read audit logs
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can read audit logs"
  ON public.audit_log FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- No INSERT/UPDATE/DELETE policies for users — only the trigger writes.

-- Trigger function: logs changes to critical fields on orders
CREATE OR REPLACE FUNCTION public.audit_order_changes()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  changed text[] := ARRAY[]::text[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO public.audit_log (table_name, operation, row_id, old_data, user_id)
    VALUES ('orders', 'DELETE', OLD.id::text, to_jsonb(OLD), auth.uid());
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.estado IS DISTINCT FROM OLD.estado THEN changed := array_append(changed, 'estado'); END IF;
    IF NEW.valor IS DISTINCT FROM OLD.valor THEN changed := array_append(changed, 'valor'); END IF;
    IF NEW.flete IS DISTINCT FROM OLD.flete THEN changed := array_append(changed, 'flete'); END IF;
    IF NEW.costo_prod IS DISTINCT FROM OLD.costo_prod THEN changed := array_append(changed, 'costo_prod'); END IF;
    IF NEW.costo_dev IS DISTINCT FROM OLD.costo_dev THEN changed := array_append(changed, 'costo_dev'); END IF;
    IF NEW.nombre IS DISTINCT FROM OLD.nombre THEN changed := array_append(changed, 'nombre'); END IF;
    IF NEW.phone IS DISTINCT FROM OLD.phone THEN changed := array_append(changed, 'phone'); END IF;
    IF NEW.novedad IS DISTINCT FROM OLD.novedad THEN changed := array_append(changed, 'novedad'); END IF;
    IF NEW.novedad_sol IS DISTINCT FROM OLD.novedad_sol THEN changed := array_append(changed, 'novedad_sol'); END IF;
    IF NEW.guia IS DISTINCT FROM OLD.guia THEN changed := array_append(changed, 'guia'); END IF;
    IF NEW.transportadora IS DISTINCT FROM OLD.transportadora THEN changed := array_append(changed, 'transportadora'); END IF;
    IF NEW.fecha_conf IS DISTINCT FROM OLD.fecha_conf THEN changed := array_append(changed, 'fecha_conf'); END IF;
    IF NEW.dias IS DISTINCT FROM OLD.dias THEN changed := array_append(changed, 'dias'); END IF;
    IF NEW.dias_conf IS DISTINCT FROM OLD.dias_conf THEN changed := array_append(changed, 'dias_conf'); END IF;

    -- Only log if something actually changed
    IF array_length(changed, 1) > 0 THEN
      INSERT INTO public.audit_log (table_name, operation, row_id, old_data, new_data, changed_fields, user_id)
      VALUES ('orders', 'UPDATE', NEW.id::text, to_jsonb(OLD), to_jsonb(NEW), changed, auth.uid());
    END IF;
    RETURN NEW;
  END IF;

  RETURN NULL;
END;
$$;

-- AFTER trigger — passive observer, cannot block the operation
CREATE TRIGGER trg_audit_orders
  AFTER UPDATE OR DELETE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.audit_order_changes();

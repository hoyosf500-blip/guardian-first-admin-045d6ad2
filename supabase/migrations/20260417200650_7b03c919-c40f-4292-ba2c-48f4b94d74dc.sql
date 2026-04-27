-- 1. Add new columns
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS last_edit_sync_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_edited_by UUID REFERENCES auth.users(id);

-- 2. Replace protect_order_financial_fields with the extended version
CREATE OR REPLACE FUNCTION public.protect_order_financial_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_is_admin BOOLEAN;
  v_is_owner BOOLEAN;
BEGIN
  -- service_role bypass
  IF current_setting('request.jwt.claim.role', true) = 'service_role' THEN
    RETURN NEW;
  END IF;

  v_is_admin := public.has_role(v_uid, 'admin');
  IF v_is_admin THEN
    RETURN NEW;
  END IF;

  -- Hard-block fields for non-admins regardless of ownership
  IF NEW.valor IS DISTINCT FROM OLD.valor THEN
    RAISE EXCEPTION 'No tienes permiso para modificar el valor del pedido';
  END IF;
  IF NEW.flete IS DISTINCT FROM OLD.flete THEN
    RAISE EXCEPTION 'No tienes permiso para modificar el flete';
  END IF;
  IF NEW.costo_prod IS DISTINCT FROM OLD.costo_prod THEN
    RAISE EXCEPTION 'No tienes permiso para modificar el costo del producto';
  END IF;
  IF NEW.costo_dev IS DISTINCT FROM OLD.costo_dev THEN
    RAISE EXCEPTION 'No tienes permiso para modificar el costo de devolucion';
  END IF;
  IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to THEN
    RAISE EXCEPTION 'No tienes permiso para reasignar pedidos';
  END IF;
  IF NEW.external_id IS DISTINCT FROM OLD.external_id THEN
    RAISE EXCEPTION 'No tienes permiso para modificar el ID externo';
  END IF;
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'No tienes permiso para modificar la fecha de creación';
  END IF;

  -- Operator-editable fields require ownership
  v_is_owner := (OLD.assigned_to = v_uid);

  IF (NEW.nombre       IS DISTINCT FROM OLD.nombre)
     OR (NEW.phone       IS DISTINCT FROM OLD.phone)
     OR (NEW.direccion   IS DISTINCT FROM OLD.direccion)
     OR (NEW.ciudad      IS DISTINCT FROM OLD.ciudad)
     OR (NEW.departamento IS DISTINCT FROM OLD.departamento)
     OR (NEW.email       IS DISTINCT FROM OLD.email)
     OR (NEW.last_edit_sync_at IS DISTINCT FROM OLD.last_edit_sync_at)
     OR (NEW.last_edited_by    IS DISTINCT FROM OLD.last_edited_by)
  THEN
    IF NOT v_is_owner THEN
      RAISE EXCEPTION 'No puedes editar un pedido que no tienes asignado';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
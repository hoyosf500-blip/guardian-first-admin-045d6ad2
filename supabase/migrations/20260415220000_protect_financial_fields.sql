-- Prevent non-admin operators from modifying financial fields on orders.
-- The frontend never writes these fields (they come from Dropi sync via
-- service_role), but this trigger ensures a compromised JWT can't silently
-- alter values. Admins can override for manual corrections.

CREATE OR REPLACE FUNCTION public.protect_order_financial_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- service_role and admins can do anything
  IF current_setting('request.jwt.claim.role', true) = 'service_role' THEN
    RETURN NEW;
  END IF;
  IF public.has_role(auth.uid(), 'admin') THEN
    RETURN NEW;
  END IF;

  -- Block changes to financial and identity fields by regular operators
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
    RAISE EXCEPTION 'No tienes permiso para modificar el costo de devolución';
  END IF;
  IF NEW.nombre IS DISTINCT FROM OLD.nombre THEN
    RAISE EXCEPTION 'No tienes permiso para modificar el nombre del cliente';
  END IF;
  IF NEW.phone IS DISTINCT FROM OLD.phone THEN
    RAISE EXCEPTION 'No tienes permiso para modificar el teléfono';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_protect_order_financials
  BEFORE UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_order_financial_fields();

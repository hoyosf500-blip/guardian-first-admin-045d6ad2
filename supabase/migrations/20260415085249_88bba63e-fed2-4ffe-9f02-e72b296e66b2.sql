
CREATE OR REPLACE FUNCTION public.protect_confirmed_orders()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- If estado is being changed back to 'PENDIENTE CONFIRMACION' 
  -- but the order was confirmed locally today, block the change
  IF NEW.estado = 'PENDIENTE CONFIRMACION' AND OLD.estado IS DISTINCT FROM 'PENDIENTE CONFIRMACION' THEN
    IF EXISTS (
      SELECT 1 FROM public.order_results
      WHERE order_id = OLD.id
        AND result = 'conf'
        AND result_date = CURRENT_DATE::text
    ) THEN
      NEW.estado := OLD.estado; -- Keep the current estado, don't overwrite
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_protect_confirmed_orders
  BEFORE UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_confirmed_orders();

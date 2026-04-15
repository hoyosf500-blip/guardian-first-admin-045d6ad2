
CREATE OR REPLACE FUNCTION public.protect_confirmed_orders()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.estado = 'PENDIENTE CONFIRMACION' AND OLD.estado IS DISTINCT FROM 'PENDIENTE CONFIRMACION' THEN
    IF EXISTS (
      SELECT 1 FROM public.order_results
      WHERE order_id = OLD.id
        AND result = 'conf'
        AND result_date = CURRENT_DATE
    ) THEN
      NEW.estado := OLD.estado;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$;

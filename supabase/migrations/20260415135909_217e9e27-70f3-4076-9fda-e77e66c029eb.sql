CREATE OR REPLACE FUNCTION public.protect_resolved_novedades_today()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF (OLD.novedad_sol IS TRUE AND NEW.novedad_sol IS DISTINCT FROM TRUE)
     OR (OLD.estado = 'NOVEDAD SOLUCIONADA' AND NEW.estado IS DISTINCT FROM 'NOVEDAD SOLUCIONADA') THEN
    IF EXISTS (
      SELECT 1 FROM public.touchpoints
      WHERE phone = OLD.phone
        AND action LIKE 'NOVEDAD:%'
        AND action_date = CURRENT_DATE::text
    ) THEN
      NEW.novedad_sol := OLD.novedad_sol;
      NEW.estado := OLD.estado;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_resolved_novedades_today ON public.orders;

CREATE TRIGGER trg_protect_resolved_novedades_today
  BEFORE UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_resolved_novedades_today();
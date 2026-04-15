-- Protect novedades that were resolved locally today from being overwritten
-- by the next dropi-sync/dropi-cron run.
--
-- When an operator resolves a novedad from the Novedades tab:
--   - orders.novedad_sol is set to true
--   - orders.estado is set to 'NOVEDAD SOLUCIONADA'
--   - A touchpoint row is inserted with action LIKE 'NOVEDAD:%' for today
--
-- If the next Dropi sync runs before Dropi's own backend reflects the change
-- (there can be a delay while the carrier processes it), the sync would
-- otherwise flip novedad_sol back to false or overwrite the estado.
-- This trigger uses the touchpoints table as the source of truth: if there
-- is a NOVEDAD touchpoint for this phone today, keep the local state.
--
-- Mirrors the shape of protect_confirmed_orders (migration 20260415085249).

CREATE OR REPLACE FUNCTION public.protect_resolved_novedades_today()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Only act when a sync is trying to reset novedad_sol from TRUE back to FALSE,
  -- or when it is trying to flip estado away from a 'NOVEDAD SOLUCIONADA' set today.
  IF (OLD.novedad_sol IS TRUE AND NEW.novedad_sol IS DISTINCT FROM TRUE)
     OR (OLD.estado = 'NOVEDAD SOLUCIONADA' AND NEW.estado IS DISTINCT FROM 'NOVEDAD SOLUCIONADA') THEN
    IF EXISTS (
      SELECT 1 FROM public.touchpoints
      WHERE phone = OLD.phone
        AND action LIKE 'NOVEDAD:%'
        AND action_date = CURRENT_DATE::text
    ) THEN
      -- Keep the local resolution, ignore the incoming reset
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

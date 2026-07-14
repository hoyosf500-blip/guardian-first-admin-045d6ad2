-- Triggers de protección: alinear la fecha "hoy" con la del cliente (Bogotá).
--
-- BUG (auditoría pre-operación 2026-07-14, #4): el cliente escribe
-- order_results.result_date y touchpoints.action_date con bogotaToday()
-- (fecha en America/Bogota, UTC-5), pero estos dos triggers comparaban contra
-- CURRENT_DATE (UTC). Entre las 19:00 y la medianoche de Bogotá, UTC ya es el
-- día SIGUIENTE → el EXISTS no matchea → el trigger DEJA DE PROTEGER →
-- si el sync corre en esa ventana y Dropi todavía muestra el estado viejo
-- (el bot no propagó aún), sobrescribe la confirmación/novedad recién hecha
-- y el pedido REAPARECE en la cola del turno de la tarde.
--
-- Fix: comparar contra (now() AT TIME ZONE 'America/Bogota')::date — misma
-- "fecha de hoy" que usa el cliente. CO y EC comparten offset (UTC-5), así que
-- una sola zona sirve para ambas tiendas. Cuerpos reproducidos verbatim de
-- 20260415085519 (protect_confirmed_orders) y 20260526061659
-- (protect_resolved_novedades_today); ÚNICO cambio: CURRENT_DATE → Bogotá.

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
        AND result_date = (now() AT TIME ZONE 'America/Bogota')::date
    ) THEN
      NEW.estado := OLD.estado;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.protect_resolved_novedades_today()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (OLD.novedad_sol IS TRUE AND NEW.novedad_sol IS DISTINCT FROM TRUE)
     OR (OLD.estado = 'NOVEDAD SOLUCIONADA' AND NEW.estado IS DISTINCT FROM 'NOVEDAD SOLUCIONADA') THEN
    IF EXISTS (
      SELECT 1 FROM public.touchpoints
      WHERE phone = OLD.phone
        AND action LIKE 'NOVEDAD:%'
        AND action_date = (now() AT TIME ZONE 'America/Bogota')::date
    ) THEN
      NEW.novedad_sol := OLD.novedad_sol;
      NEW.estado := OLD.estado;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

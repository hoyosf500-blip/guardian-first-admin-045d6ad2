-- Historial de estados por pedido.
--
-- La API de integraciones de Dropi (GET /integrations/orders/myorders/{id}) NO
-- devuelve el historial de estados — solo el estado ACTUAL. El "Historial de
-- estados" que Dropi muestra en su panel sale de otro endpoint. Por eso Guardian
-- solo guardaba `orders.estado` y lo pisaba en cada sync → nunca acumulaba el
-- recorrido (PENDIENTE → GUIA_GENERADA → PREPARADO PARA TRANSPORTADORA → DESPACHADA…).
--
-- Solución: Guardian CONSTRUYE el historial registrando cada cambio de
-- `orders.estado` a medida que el sync (cron / refresh-order / refresh-batch) lo
-- detecta. Un trigger en `orders` lo captura, sin importar qué edge function hizo
-- el upsert. NO backfillea transiciones que ya pasaron (la API no las da), pero de
-- aquí en adelante el timeline del pedido muestra el recorrido completo.

CREATE TABLE IF NOT EXISTS public.order_status_history (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id    uuid REFERENCES public.orders(id) ON DELETE CASCADE,
  store_id    uuid,
  external_id text,
  status      text NOT NULL,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_osh_order ON public.order_status_history (order_id, changed_at);
CREATE INDEX IF NOT EXISTS idx_osh_external ON public.order_status_history (external_id);

ALTER TABLE public.order_status_history ENABLE ROW LEVEL SECURITY;

-- Los miembros de la tienda leen el historial de sus pedidos. (El INSERT lo hace
-- el trigger SECURITY DEFINER — no hay policy de INSERT, los usuarios no escriben
-- directo.)
DROP POLICY IF EXISTS "members read order status history" ON public.order_status_history;
CREATE POLICY "members read order status history" ON public.order_status_history
  FOR SELECT TO authenticated
  USING (store_id IS NULL OR public.is_store_member(store_id));

-- Trigger: registra el estado en el INSERT del pedido y cada vez que `estado`
-- cambia. `changed_at` usa last_movement_at (el updated_at de Dropi) cuando existe.
CREATE OR REPLACE FUNCTION public.record_order_status_change()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    IF NEW.estado IS NOT NULL AND btrim(NEW.estado) <> '' THEN
      INSERT INTO public.order_status_history (order_id, store_id, external_id, status, changed_at)
      VALUES (NEW.id, NEW.store_id, NEW.external_id, NEW.estado, COALESCE(NEW.last_movement_at, NEW.created_at, now()));
    END IF;
  ELSIF (NEW.estado IS DISTINCT FROM OLD.estado) THEN
    INSERT INTO public.order_status_history (order_id, store_id, external_id, status, changed_at)
    VALUES (NEW.id, NEW.store_id, NEW.external_id, NEW.estado, COALESCE(NEW.last_movement_at, now()));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_record_order_status ON public.orders;
CREATE TRIGGER trg_record_order_status
  AFTER INSERT OR UPDATE OF estado ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.record_order_status_change();

-- Seed: una fila con el estado ACTUAL de cada pedido existente, para que el
-- timeline no quede vacío. De aquí en adelante el trigger agrega los cambios.
INSERT INTO public.order_status_history (order_id, store_id, external_id, status, changed_at)
SELECT o.id, o.store_id, o.external_id, o.estado, COALESCE(o.last_movement_at, o.created_at, now())
FROM public.orders o
WHERE o.estado IS NOT NULL AND btrim(o.estado) <> ''
  AND NOT EXISTS (SELECT 1 FROM public.order_status_history h WHERE h.order_id = o.id);

-- last_movement_at: timestamp del ÚLTIMO movimiento real del pedido en Dropi
-- (mapeado desde el `updated_at` que devuelve la API de Dropi).
--
-- Por qué: las "Listas SLA" de /seguimiento medían antigüedad desde la
-- CREACIÓN del pedido (orders.fecha), así que un pedido viejo pero que SÍ se
-- movió ayer caía igual en los buckets de "indemnización / sin movimiento".
-- Con este campo podemos medir días hábiles SIN MOVIMIENTO de verdad.
--
-- `fecha_conf`/`dias_conf` ya derivaban de `updated_at` pero (a) truncados a
-- fecha y (b) NULL para PENDIENTE CONFIRMACION → no servían como timestamp de
-- movimiento confiable. Este campo es dedicado, full timestamptz y se llena
-- para todo estado.
--
-- IMPORTANTE (Lovable): esta migración debe correr ANTES de que el frontend
-- (ORDER_COLUMNS) o la RPC upsert_orders_from_dropi referencien la columna,
-- o el SELECT/INSERT explota con "column orders.last_movement_at does not
-- exist". Ver orden de despliegue en el plan.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS last_movement_at timestamptz;

COMMENT ON COLUMN public.orders.last_movement_at IS
  'Último movimiento del pedido en Dropi (updated_at de la API). Usado por las Listas SLA de /seguimiento para medir días hábiles sin movimiento real (no antigüedad desde creación).';

-- Índice parcial para las queries de seguimiento (orders no terminales
-- ordenados/filtrados por movimiento). Barato y ayuda a Logística también.
CREATE INDEX IF NOT EXISTS idx_orders_last_movement_at
  ON public.orders (last_movement_at);

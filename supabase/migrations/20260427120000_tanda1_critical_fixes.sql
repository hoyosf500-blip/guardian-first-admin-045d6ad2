-- Tanda 1 — fixes críticos
-- C2: cancel_orphan_pending_orders restringido a casos seguros
-- C3: UNIQUE en order_results para evitar dobles confirmaciones
-- C4: trigger protect_resolved_novedades_today con DATE en vez de TEXT

-- ─────────────────────────────────────────────────────────────────
-- C2: cancel_orphan_pending_orders
-- ─────────────────────────────────────────────────────────────────
-- Antes: cancelaba CUALQUIER PENDIENTE CONFIRMACION si existía otro
-- pedido con mismo phone+producto en estado terminal y created_at
-- posterior. Eso cancelaba ventas legítimas: cliente compra el mismo
-- producto el lunes (cancelado), vuelve a comprar el viernes — el
-- cron cancelaba la 2da venta automáticamente.
--
-- Ahora: solo cancelamos cuando el "nuevo" pedido fue creado dentro
-- de las 48h posteriores al "viejo" (Dropi edita un pedido y crea
-- uno nuevo — siempre ocurre dentro de un par de horas) Y el viejo
-- tiene < 7 días (pedidos pendientes muy viejos son cobranza, no
-- huérfanos por edición de Dropi).
CREATE OR REPLACE FUNCTION public.cancel_orphan_pending_orders()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INT;
BEGIN
  UPDATE public.orders viejo
  SET estado = 'CANCELADO'
  WHERE viejo.estado = 'PENDIENTE CONFIRMACION'
    AND viejo.created_at > NOW() - INTERVAL '7 days'
    AND EXISTS (
      SELECT 1 FROM public.orders nuevo
      WHERE nuevo.phone = viejo.phone
        AND nuevo.producto = viejo.producto
        AND nuevo.id != viejo.id
        AND nuevo.estado IN ('CANCELADO', 'ENTREGADO', 'DEVOLUCION', 'DEVOLUCION EN TRANSITO')
        AND nuevo.created_at > viejo.created_at
        AND nuevo.created_at < viejo.created_at + INTERVAL '48 hours'
    );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_orphan_pending_orders() TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────
-- C3: UNIQUE en order_results
-- ─────────────────────────────────────────────────────────────────
-- Antes: nada impedía 2 inserts de result='conf' para mismo order_id.
-- Una operadora con 2 pestañas, o doble-click justo cuando llega el
-- realtime de release, podía duplicar. Counters mienten y dropi-update
-- se llama dos veces.
--
-- Ahora: índice parcial UNIQUE para results resolutivos. Permite
-- result='resolving' u otros tipos múltiples si se necesita en el
-- futuro, pero bloquea conf/canc duplicado por pedido.
--
-- IMPORTANTE: si ya hay duplicados en producción esta migración
-- fallará. Si pasa, ejecutar primero:
--   DELETE FROM public.order_results r1 USING public.order_results r2
--   WHERE r1.id < r2.id AND r1.order_id = r2.order_id AND r1.result = r2.result
--     AND r1.result IN ('conf','canc');
CREATE UNIQUE INDEX IF NOT EXISTS order_results_unique_resolving
  ON public.order_results (order_id, result)
  WHERE result IN ('conf', 'canc');

-- ─────────────────────────────────────────────────────────────────
-- C4: protect_resolved_novedades_today — DATE en vez de TEXT (Fix 27)
-- ─────────────────────────────────────────────────────────────────
-- Antes: `action_date = CURRENT_DATE::text` forzaba Seq Scan en
-- touchpoints porque la columna `action_date` es DATE. Cada UPDATE
-- en orders dispara este trigger; con cron de Dropi cada 1 min y
-- sync de cientos/miles de filas, el costo se acumulaba a segundos.
--
-- Ahora: comparación tipo DATE = DATE, usa el índice
-- idx_touchpoints_phone_date sin coerción.
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
        AND action_date = CURRENT_DATE
    ) THEN
      NEW.novedad_sol := OLD.novedad_sol;
      NEW.estado := OLD.estado;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

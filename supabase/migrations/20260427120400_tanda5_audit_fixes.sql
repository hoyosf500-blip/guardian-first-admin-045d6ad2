-- Tanda 5 — fixes de la auditoría post-Tanda 4
-- MIG-1 / REG-4: drop UNIQUE en touchpoints (rompía confirmaciones legítimas
--                de varios pedidos del mismo cliente en <60s; dedup vive en
--                código vía markingInFlightRef).
-- MIG-2: cancel_orphan_pending_orders con filter correcto del estado del nuevo.
-- MIG-3 / REG-5: trigger protect_fecha_conf_freeze con bypass admin.
-- REG-3: nueva RPC confirm_order_locally (UPDATE estado='PENDIENTE' atómico,
--        evita romperse cuando el lock expiró >15 min).
-- OLD-11: REVOKE con EXCEPTION específico en vez de OTHERS.

-- ─────────────────────────────────────────────────────────────────
-- MIG-1 / REG-4: drop UNIQUE en touchpoints
-- ─────────────────────────────────────────────────────────────────
-- El UNIQUE de Tanda 3 (operator_id, phone, action, action_date, action_time)
-- rompía un caso real: cliente con 2 pedidos del mismo phone confirmados en
-- el mismo minuto → segundo insert da 23505, código no captura el error,
-- tpData queda null y el undo del segundo no funciona.
--
-- La protección contra doble-click vive ya en código:
--   - markingInFlightRef en CrmTable.tsx
--   - markingInFlight en OrderContext (Confirmar)
--   - debounce de realtime
-- Eso cubre el caso original que motivaba el UNIQUE.
DROP INDEX IF EXISTS public.touchpoints_dedup;

-- ─────────────────────────────────────────────────────────────────
-- MIG-2: cancel_orphan_pending_orders — filter del estado del nuevo
-- ─────────────────────────────────────────────────────────────────
-- Antes (Tanda 1): el nuevo debía estar en estado terminal
-- (CANCELADO/ENTREGADO/DEVOLUCION...). Pero cuando Dropi edita un pedido,
-- el "nuevo" empieza como PENDIENTE CONFIRMACION o pasa a PENDIENTE — NUNCA
-- a estado terminal en las primeras 48h. El filter hacía que la función
-- fuera prácticamente no-op.
--
-- Ahora: el nuevo solo debe NO estar en PENDIENTE CONFIRMACION (eso evita
-- cancelar 2 pedidos pendientes legítimos del mismo cliente). El check
-- de ventana de 48h y el viejo<7d siguen acotando el riesgo.
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
        AND nuevo.estado <> 'PENDIENTE CONFIRMACION'
        AND nuevo.created_at > viejo.created_at
        AND nuevo.created_at < viejo.created_at + INTERVAL '48 hours'
    );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_orphan_pending_orders() TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────
-- MIG-3 / REG-5: protect_fecha_conf_freeze con bypass admin
-- ─────────────────────────────────────────────────────────────────
-- Antes: el trigger congelaba `fecha_conf` para CUALQUIER UPDATE, incluyendo
-- los del admin desde la UI corrigiendo manualmente un pedido con fecha
-- corrupta. Quedaba sin solución desde la app.
--
-- Ahora: si el caller es admin (auth.uid() tiene rol admin), bypass. El
-- cron de Dropi corre como service_role (auth.uid() NULL), así que
-- has_role(NULL,...)=false → trigger sigue protegiendo del Dropi sync.
CREATE OR REPLACE FUNCTION public.protect_fecha_conf_freeze()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.fecha_conf IS NOT NULL
     AND OLD.fecha_conf <> ''
     AND NOT public.has_role(auth.uid(), 'admin') THEN
    NEW.fecha_conf := OLD.fecha_conf;
    IF OLD.fecha_conf ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      NEW.dias_conf := GREATEST(0, (CURRENT_DATE - OLD.fecha_conf::date));
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ─────────────────────────────────────────────────────────────────
-- REG-3: confirm_order_locally — RPC para confirmar después del lock
-- ─────────────────────────────────────────────────────────────────
-- Antes: OrderContext.markResult hacía UPDATE estado='PENDIENTE' directo.
-- Si el lock había expirado (>15 min, operadora habló mucho), la nueva
-- RLS UPDATE de Tanda 2 (sin rama IS NULL/IS NULL) hacía que el UPDATE
-- silenciosamente devolviera 0 filas. El counter local subía pero el
-- pedido reaparecía en la cola.
--
-- Ahora: RPC SECURITY DEFINER que solo exige rol admin u operator. No
-- depende del lock — la operadora puede confirmar incluso si su lock
-- expiró mientras hablaba con el cliente.
CREATE OR REPLACE FUNCTION public.confirm_order_locally(p_order_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'operator')) THEN
    RAISE EXCEPTION 'No autorizado' USING ERRCODE = '42501';
  END IF;

  UPDATE public.orders
    SET estado = 'PENDIENTE'
    WHERE id = p_order_id AND estado = 'PENDIENTE CONFIRMACION';
  RETURN FOUND;
END;
$$;

GRANT EXECUTE ON FUNCTION public.confirm_order_locally(UUID) TO authenticated;

-- ─────────────────────────────────────────────────────────────────
-- OLD-11: REVOKE extensions con exception específico
-- ─────────────────────────────────────────────────────────────────
-- La Tanda 4 usaba EXCEPTION WHEN OTHERS THEN NULL — eso traga errores
-- reales (ej. extension http no instalada, permission denied del propio
-- migrator). Ahora capturamos solo insufficient_privilege.
DO $$
BEGIN
  REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA extensions FROM authenticated;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipped REVOKE on extensions: insufficient privilege at migration time';
END $$;

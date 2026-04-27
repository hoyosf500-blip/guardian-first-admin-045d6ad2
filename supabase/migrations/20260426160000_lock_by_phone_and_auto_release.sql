-- Capa adicional de protección anti-doble-llamada para Confirmar:
-- Lock por TELÉFONO en lugar de por pedido. Si Juan tiene 2 pedidos
-- PENDIENTE CONFIRMACION, una sola operadora maneja ambos. Previene
-- que dos operadoras llamen al mismo cliente al mismo tiempo (aún
-- siendo pedidos distintos).
--
-- Mantiene la firma original de claim_order(p_order_id UUID) y devuelve
-- SETOF orders, así el frontend (useOrderLock + CallView) sigue
-- funcionando sin cambios.

CREATE OR REPLACE FUNCTION public.claim_order(p_order_id UUID)
RETURNS SETOF public.orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone TEXT;
BEGIN
  IF NOT public.has_role(auth.uid(), 'operator') AND NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'No tienes permiso para reclamar pedidos';
  END IF;

  -- Obtener el teléfono del pedido solicitado
  SELECT phone INTO v_phone FROM public.orders WHERE id = p_order_id;
  IF v_phone IS NULL OR v_phone = '' THEN
    RETURN;
  END IF;

  -- Rechazar si CUALQUIER pedido de este teléfono está activamente
  -- lockeado por otra operadora (lock fresco, < 15 min).
  IF EXISTS (
    SELECT 1 FROM public.orders
    WHERE phone = v_phone
      AND estado = 'PENDIENTE CONFIRMACION'
      AND locked_by IS NOT NULL
      AND locked_by != auth.uid()
      AND locked_at >= NOW() - INTERVAL '15 minutes'
  ) THEN
    RETURN;
  END IF;

  -- Lockear TODOS los pedidos PENDIENTE CONFIRMACION del mismo
  -- teléfono atómicamente. Devuelve los pedidos lockeados.
  RETURN QUERY
  UPDATE public.orders
  SET locked_by = auth.uid(), locked_at = NOW()
  WHERE phone = v_phone
    AND estado = 'PENDIENTE CONFIRMACION'
  RETURNING *;
END;
$$;

-- Auto-release de assigned_to en Seguimiento/Rescate.
-- Si una operadora se enferma, sale de vacaciones o simplemente abandona
-- pedidos asignados, el sistema los libera al pool después de 48h sin
-- touchpoint de ella. Quita la necesidad de un botón "Liberar" manual.
--
-- Aplica a TODOS los estados activos (post-PENDIENTE CONFIRMACION) excepto
-- los terminales (entregado, cancelado, rechazado, devolución).
-- PENDIENTE CONFIRMACION usa locked_by (15 min), no assigned_to, así que
-- queda fuera de este cron.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'release-stale-seg-assignments') THEN
    PERFORM cron.unschedule('release-stale-seg-assignments');
  END IF;
END;
$$;

SELECT cron.schedule(
  'release-stale-seg-assignments',
  '0 * * * *',
  $$UPDATE public.orders
    SET assigned_to = NULL
    WHERE assigned_to IS NOT NULL
      AND estado NOT IN ('PENDIENTE CONFIRMACION', 'ENTREGADO', 'CANCELADO', 'RECHAZADO', 'DEVOLUCION', 'DEVOLUCION EN TRANSITO')
      AND NOT EXISTS (
        SELECT 1 FROM public.touchpoints
        WHERE phone = public.orders.phone
          AND operator_id = public.orders.assigned_to
          AND created_at > NOW() - INTERVAL '48 hours'
      )$$
);

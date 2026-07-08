-- FIX "Siguiente salta ~10" en /confirmar (2026-07-07) — parte servidor.
--
-- claim_order lockea por TELÉFONO (todos los PENDIENTE CONFIRMACION del mismo
-- cliente, ver 20260426160000 y la versión race-safe 20260427062623), pero
-- release_order soltaba UNA sola fila (WHERE id = p_order_id). Resultado: al
-- marcar un pedido de un cliente con 2+ pendientes, los hermanos quedaban
-- lockeados 15 min como huérfanos. Combinado con que navegar entre pedidos
-- no soltaba nada (fix cliente en CallView.tsx), con 3 operadoras simultáneas
-- se acumulaban ~9 locks frescos (medido en vivo 2026-07-07: una operadora
-- tenía 7 a la vez) y el skip anti-doble-llamada saltaba en cascada por encima
-- de todos → "Siguiente salta como a 10 pedidos".
--
-- Esta versión libera TODOS los pedidos PENDIENTE CONFIRMACION del mismo
-- teléfono lockeados por la operadora que llama (simetría exacta con claim).
-- Admin puede liberar locks de cualquiera (mismo privilegio que ya tenía).
-- Mantiene firma y permisos — el frontend no cambia.

CREATE OR REPLACE FUNCTION public.release_order(p_order_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone TEXT;
BEGIN
  SELECT phone INTO v_phone FROM public.orders WHERE id = p_order_id;

  UPDATE public.orders
  SET locked_by = NULL, locked_at = NULL
  WHERE (
      id = p_order_id
      OR (
        v_phone IS NOT NULL AND v_phone != ''
        AND phone = v_phone
        AND estado = 'PENDIENTE CONFIRMACION'
      )
    )
    AND locked_by IS NOT NULL
    AND (locked_by = auth.uid() OR public.has_role(auth.uid(), 'admin'));
END;
$$;

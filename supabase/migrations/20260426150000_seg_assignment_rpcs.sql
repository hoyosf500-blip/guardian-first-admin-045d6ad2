-- Asignación persistente de pedidos para Seguimiento y Rescate.
-- A diferencia del par claim_order/release_order (que usan locked_by/locked_at
-- como bloqueo TEMPORAL de 15 min para Confirmar), estas RPCs operan sobre
-- assigned_to como ASIGNACIÓN PERSISTENTE: el pedido pertenece a la operadora
-- hasta que ella ejecute una acción resolutiva o lo libere manualmente.

-- claim_seg_order: asigna el pedido al caller si está sin asignar o ya es suyo.
-- Devuelve TRUE si la asignación quedó en manos del caller, FALSE si pertenece
-- a otra operadora.
CREATE OR REPLACE FUNCTION public.claim_seg_order(p_order_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current UUID;
BEGIN
  SELECT assigned_to INTO v_current FROM public.orders WHERE id = p_order_id;
  IF v_current IS NULL OR v_current = auth.uid() THEN
    UPDATE public.orders SET assigned_to = auth.uid() WHERE id = p_order_id;
    RETURN TRUE;
  END IF;
  RETURN FALSE;
END;
$$;

-- release_seg_order: libera la asignación solo si el caller es el dueño actual.
-- Devuelve TRUE si efectivamente se liberó, FALSE si no era suyo.
CREATE OR REPLACE FUNCTION public.release_seg_order(p_order_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.orders SET assigned_to = NULL
    WHERE id = p_order_id AND assigned_to = auth.uid();
  RETURN FOUND;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_seg_order(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_seg_order(UUID) TO authenticated;

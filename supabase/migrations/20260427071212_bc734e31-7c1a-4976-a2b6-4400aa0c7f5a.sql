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
    AND EXISTS (
      SELECT 1 FROM public.orders nuevo
      WHERE nuevo.phone = viejo.phone
        AND nuevo.producto = viejo.producto
        AND nuevo.id != viejo.id
        AND nuevo.estado IN ('CANCELADO', 'ENTREGADO', 'DEVOLUCION', 'DEVOLUCION EN TRANSITO')
        AND nuevo.created_at > viejo.created_at
    );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_orphan_pending_orders() TO authenticated, service_role;
-- Fix race condition en claim_seg_order.
--
-- La versión anterior hacía SELECT + UPDATE como operaciones SEPARADAS.
-- Bajo READ COMMITTED (default en Postgres), dos llamadas concurrentes
-- podían leer assigned_to=NULL al mismo tiempo y ambas hacer UPDATE,
-- terminando con last-write-wins y ambas operadoras creyendo que el
-- pedido era suyo.
--
-- La corrección hace UPDATE atómico con WHERE clause: solo se actualiza
-- si la fila aún cumple la condición. Postgres adquiere row-level lock
-- durante el UPDATE, así dos UPDATE concurrentes se serializan sobre la
-- misma fila — solo uno gana.

CREATE OR REPLACE FUNCTION public.claim_seg_order(p_order_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated INT;
BEGIN
  UPDATE public.orders
  SET assigned_to = auth.uid()
  WHERE id = p_order_id
    AND (assigned_to IS NULL OR assigned_to = auth.uid());
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

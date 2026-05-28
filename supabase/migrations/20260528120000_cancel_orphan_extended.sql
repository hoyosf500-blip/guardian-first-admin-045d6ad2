-- Extiende cancel_orphan_pending_orders para detectar reemplazos de Dropi
-- donde la orden nueva NO está en estado terminal (Entregado/Devolución).
--
-- Caso real (Rushmira Ecuador, 2026-05-23): Dropi reemplazó la orden 5524001
-- por 5529961 (mismo cliente, mismo producto). La nueva (5529961) progresó
-- naturalmente: PENDIENTE CONFIRMACION → PENDIENTE → GUIA_GENERADA →
-- INGRESANDO DE RECOLECCION A → EN RUTA → INGRESANDO OPERATIVO A. La función
-- vieja exigía que la nueva fuera ENTREGADO/DEVOLUCION para cancelar la vieja
-- — pero en este caso la nueva sigue en tránsito, así que 5524001 quedaba
-- como PENDIENTE stale para siempre.
--
-- El histórico de Dropi para la nueva trae un comentario explícito ("Esta
-- orden reemplaza a la orden 5524001 que fue editada por el usuario.") pero
-- el sync no parsea ese comentario. Usamos el heurístico phone+producto+
-- ventana 48h, igual que findSupersededPendingConf del frontend, pero ahora
-- aceptando CUALQUIER estado distinto a PENDIENTE CONFIRMACION/CANCELADO.

CREATE OR REPLACE FUNCTION public.cancel_orphan_pending_orders()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_count INT;
BEGIN
  UPDATE public.orders viejo
  SET estado = 'CANCELADO'
  WHERE viejo.estado = 'PENDIENTE CONFIRMACION'
    -- Solo pendientes "frescos" (≤7 días). Más allá de eso es muy posible
    -- que sea una recompra del mismo cliente, no un reemplazo.
    AND viejo.created_at > NOW() - INTERVAL '7 days'
    AND EXISTS (
      SELECT 1
      FROM public.orders nuevo
      WHERE nuevo.phone = viejo.phone
        AND nuevo.producto = viejo.producto
        AND nuevo.id != viejo.id
        AND nuevo.store_id = viejo.store_id
        -- Antes: nuevo.estado IN ('ENTREGADO','DEVOLUCION','DEVOLUCION EN TRANSITO')
        -- Ahora: cualquier estado que NO sea PENDIENTE CONFIRMACION/CANCELADO
        -- — captura reemplazos donde la nueva sigue en tránsito (caso del usuario).
        AND UPPER(nuevo.estado) NOT IN ('PENDIENTE CONFIRMACION', 'CANCELADO')
        AND nuevo.created_at > viejo.created_at
        AND nuevo.created_at < viejo.created_at + INTERVAL '48 hours'
    );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.cancel_orphan_pending_orders() IS
  'Cancela PENDIENTE CONFIRMACION "huérfanos" superados por una nueva orden del mismo phone+producto dentro de 48h (post-reemplazo Dropi). Acepta cualquier estado para la nueva excepto PENDIENTE CONFIRMACION/CANCELADO (relajada desde la versión 20260507054125 que sólo aceptaba estados terminales).';

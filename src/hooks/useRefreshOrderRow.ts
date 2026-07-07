import { useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useOrders } from '@/contexts/OrderContext';
import { OrderData, dbToOrderData } from '@/lib/orderUtils';
import { ORDER_COLUMNS } from '@/lib/orderColumns';

/**
 * Re-fetch de UNA fila de `orders` por dbId + merge en el estado de Confirmar
 * preservando el resultado local de la operadora (result/reason/retryCount).
 *
 * Extraído del patrón que CallView repetía 3 veces en los onSuccess de los
 * diálogos de edición. Lo usan CallView y WorkList (que antes NO refrescaba —
 * editar desde la lista dependía del próximo sync).
 *
 * Devuelve la fila actualizada (o null) para que el caller pueda re-anclarse:
 * tras una recreación en Dropi el external_id CAMBIA y CallView usa ese id
 * como ancla del pedido activo.
 */
export function useRefreshOrderRow() {
  const { allOrders, setAllOrders, buildWorkQueue } = useOrders();

  return useCallback(async (dbId: string | null | undefined): Promise<OrderData | null> => {
    if (!dbId) return null;
    const { data } = await supabase
      .from('orders')
      .select(ORDER_COLUMNS)
      .eq('id', dbId)
      .maybeSingle();
    if (!data) return null;
    const updated = dbToOrderData(data as unknown as Parameters<typeof dbToOrderData>[0], 0);
    const merged = allOrders.map(ord => ord.dbId === updated.dbId
      ? { ...ord, ...updated, result: ord.result, reason: ord.reason, retryCount: ord.retryCount }
      : ord);
    setAllOrders(merged);
    buildWorkQueue(merged);
    return updated;
  }, [allOrders, setAllOrders, buildWorkQueue]);
}

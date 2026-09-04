import { useCallback } from 'react';
import { toast } from 'sonner';
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
    // ⛔ El error SE LEE (4-sep-2026). Antes se destructuraba solo `data` y un
    // fallo de red devolvía `null` en silencio. Importa por lo que se desplegó
    // esta mañana: cuando la edición RECREA el pedido en Dropi, el `external_id`
    // CAMBIA y `CallView` usa esta fila para volver a anclarse. Sin relectura y
    // sin aviso, la asesora se queda trabajando el pedido VIEJO — el que Dropi
    // acaba de marcar REEMPLAZADA.
    const { data, error } = await supabase
      .from('orders')
      .select(ORDER_COLUMNS)
      .eq('id', dbId)
      .maybeSingle();
    if (error) {
      console.warn('[useRefreshOrderRow] no se pudo releer el pedido:', error.message);
      toast.error('No pude releer el pedido después de guardarlo.', {
        description: 'El cambio SÍ se aplicó. Refrescá la pantalla antes de seguir con este cliente.',
      });
      return null;
    }
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

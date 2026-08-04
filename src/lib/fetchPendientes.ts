/**
 * La cola de Confirmar: los pedidos PENDIENTE CONFIRMACION de una tienda.
 *
 * Existía TRES veces (OrderContext.loadWorkQueue, la carga inicial de
 * ConfirmarTab y la recarga tras "Sincronizar Dropi") y las tres copias no eran
 * iguales: dos filtraban con `ilike` y la tercera con `eq`, así que después de
 * sincronizar podía verse un conjunto distinto al de la carga inicial si el
 * estado venía con otra caja. Ninguna paginaba, y PostgREST corta en ~1000
 * filas sin avisar (ver `paginarQuery`).
 *
 * Un solo lugar: la cola no puede depender de por cuál de los tres caminos se
 * llegó a ella.
 */
import { supabase } from '@/integrations/supabase/client';
import { ORDER_COLUMNS } from './orderColumns';
import { paginarQuery, type Paginable, type ResultadoPaginado } from './paginarQuery';
import type { DbOrderRow } from './orderUtils';

/**
 * Orden ESTABLE, requisito de paginar: `created_at` desc para que lo nuevo
 * llegue primero, y `id` como desempate. Sin el desempate dos pedidos creados
 * en el mismo instante —cosa normal, el sync los inserta en lote— pueden
 * ordenarse distinto entre página y página, y ahí una fila sale repetida y otra
 * no sale nunca.
 */
export function fetchPendientesDeConfirmar(
  storeId: string,
  cancelado?: () => boolean,
): Promise<ResultadoPaginado<DbOrderRow>> {
  return paginarQuery<DbOrderRow>(
    () =>
      supabase
        .from('orders')
        .select(ORDER_COLUMNS)
        .eq('store_id', storeId)
        .ilike('estado', 'PENDIENTE CONFIRMACION')
        .order('created_at', { ascending: false })
        .order('id', { ascending: true }) as unknown as Paginable<DbOrderRow>,
    { cancelado },
  );
}

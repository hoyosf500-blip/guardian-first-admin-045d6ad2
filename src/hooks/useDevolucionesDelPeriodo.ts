import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useActiveStoreId } from '@/contexts/StoreContext';
import { isRpcMissing } from '@/lib/rpcError';

// Devoluciones que LLEGARON en el período, por `devuelto_at` (la fecha REAL en
// que el pedido pasó a devolución — columna + trigger sellador del 14-ago-2026).
//
// Es la pregunta que la cascada por cohorte NO contesta: /logística atribuye
// cada devolución al mes en que el pedido se CREÓ, así que una devolución de
// agosto sobre un pedido de julio empeora julio retroactivamente y agosto se ve
// limpio. Las tasas por cohorte están BIEN así (su denominador es la cohorte);
// esta métrica responde lo otro: "¿cuántas devoluciones me golpearon la caja
// ESTE período?" — que es cuando el wallet cobra el costo_devolucion.
//
// RPC nueva `devoluciones_del_periodo` (ADITIVA — no toca ninguna función
// desplegada). `null` = RPC aún sin aplicar en la base → la tarjeta no se
// dibuja (degradación intencional, patrón isRpcMissing).

export interface DevolucionesDelPeriodo {
  /** Cuántos pedidos pasaron a devolución dentro del rango (fecha Bogotá). */
  devoluciones: number;
  /** Valor de venta de esos pedidos (lo que se dejó de cobrar). */
  valor: number;
  /** Cuántos venían de pedidos CREADOS en meses anteriores al de su llegada. */
  deMesesPrevios: number;
}

function num(v: unknown): number {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

export function useDevolucionesDelPeriodo(from: string, to: string) {
  const storeId = useActiveStoreId();
  return useQuery<DevolucionesDelPeriodo | null>({
    queryKey: ['devoluciones-del-periodo', storeId, from, to],
    queryFn: async () => {
      // Cast inline (patrón estándar del repo para RPCs nuevas): la RPC es más
      // nueva que los tipos generados. Inline, no detach — un `const rpc =`
      // suelto pierde el `this` del cliente (memoria rpc_supabase_binding_pattern).
      const { data, error } = await (supabase.rpc as unknown as (
        fn: string, args: Record<string, unknown>
      ) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>)(
        'devoluciones_del_periodo',
        { p_store_id: storeId, p_from: from, p_to: to },
      );
      if (error) {
        // SQL aún no aplicado → sin tarjeta, sin ruido. Cualquier otro error se
        // propaga: React Query reintenta y el caller decide (no inventar un 0).
        if (isRpcMissing(error)) return null;
        throw error;
      }
      const row = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
      if (!row) return { devoluciones: 0, valor: 0, deMesesPrevios: 0 };
      return {
        devoluciones: num(row.devoluciones),
        valor: num(row.valor),
        deMesesPrevios: num(row.de_meses_previos),
      };
    },
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    enabled: Boolean(from && to && storeId),
  });
}

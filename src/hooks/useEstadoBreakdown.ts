import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useActiveStoreId } from '@/contexts/StoreContext';
import type { EstadoRow } from '@/lib/estadoBuckets';

// Desglose CRUDO por estado de los pedidos de la tienda activa, vía RPC
// `orders_estado_breakdown` (store-scoped, _resolve_scope_store). Cada fila es
// un estado con su conteo, valor y unidades — el cliente bucketea con
// estadoBuckets. Si el RPC no está desplegado todavía (pre-`db push`, PGRST202),
// devuelve `null` y el componente cae al builder basado en logistics_summary.

interface RpcRow {
  estado: string | null;
  pedidos: number | string | null;
  valor: number | string | null;
  unidades: number | string | null;
}

function num(v: unknown): number {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

export function useEstadoBreakdown(from: string, to: string) {
  const storeId = useActiveStoreId();
  return useQuery<EstadoRow[] | null>({
    queryKey: ['orders-estado-breakdown', storeId, from, to],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('orders_estado_breakdown', {
        p_from: from,
        p_to: to,
      });
      // RPC no desplegado aún → degradar a null (el componente usa el fallback).
      if (error) {
        if (error.code === 'PGRST202' || /find the function|does not exist/i.test(error.message)) {
          return null;
        }
        throw error;
      }
      return ((data as RpcRow[]) ?? []).map((r) => ({
        estado: String(r.estado ?? '(sin estado)'),
        pedidos: num(r.pedidos),
        valor: num(r.valor),
        unidades: num(r.unidades),
      }));
    },
    staleTime: 60_000,
    // Frescura del hero "Cómo voy": refrescar al volver a la pestaña + poll de
    // 5 min (el default global es refetchOnWindowFocus:false → se congelaba).
    refetchOnWindowFocus: true,
    refetchInterval: 5 * 60 * 1000,
    enabled: Boolean(from && to && storeId),
  });
}

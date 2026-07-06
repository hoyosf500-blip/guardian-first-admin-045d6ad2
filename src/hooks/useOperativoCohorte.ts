import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useActiveStoreId } from '@/contexts/StoreContext';
import { isRpcMissing } from '@/lib/rpcError';

// Operativo del mes por COHORTE de pedido: utilidad operativa del wallet atribuida
// por la fecha de CREACIÓN del pedido asociado (related_order_id → orders.external_id),
// no por la fecha de pago. Reconcilia con la "Utilidad Total" de Dropi (~$4.8M),
// a diferencia de useGananciaNetaDropi (por fecha de movimiento, ~$7.2M).
//
// RPC store-scoped `operativo_mes_cohorte` (migration 20260623180000). Si el RPC
// no está desplegado aún, la query devuelve null → el call-site cae al fallback
// wallet (useGananciaNetaDropi). DEGRADA, no rompe.

export interface OperativoCohorte {
  operativo: number;
  total_entradas: number;
  total_salidas: number;
  movimientos_sin_link: number;
}

function num(v: unknown): number {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

export function useOperativoCohorte(yearMonth: string) {
  const storeId = useActiveStoreId();
  return useQuery<OperativoCohorte | null>({
    queryKey: ['operativo-cohorte', storeId ?? 'all', yearMonth],
    enabled: Boolean(storeId && yearMonth),
    staleTime: 60_000,
    // Frescura del hero "Cómo voy": refresco al volver a la pestaña + poll 5 min.
    refetchOnWindowFocus: true,
    refetchInterval: 5 * 60 * 1000,
    queryFn: async () => {
      // .bind(supabase) preserva el `this` (mismo patrón que useMonthlyAdSpend).
      const rpc = supabase.rpc.bind(supabase) as unknown as (
        fn: string, args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message?: string } | null }>;
      const { data, error } = await rpc('operativo_mes_cohorte', {
        p_store_id: storeId,
        p_year_month: yearMonth,
      });
      // RPC no desplegado → null → el call-site usa el fallback wallet (degradación
      // intencional). PERO un error transitorio (throttle, 500, permiso) se re-lanza
      // → React Query reintenta → el operativo real vuelve, en vez de quedar pegado
      // al fallback wallet inflado (~$7.2M vs ~$4.8M) sin señal. Ver [[rpcError]].
      if (error) {
        if (isRpcMissing(error)) return null;
        throw error;
      }
      // El RPC devuelve TABLE (1 fila) → el cliente lo entrega como array.
      const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        operativo: num(row.operativo),
        total_entradas: num(row.total_entradas),
        total_salidas: num(row.total_salidas),
        movimientos_sin_link: num(row.movimientos_sin_link),
      };
    },
  });
}

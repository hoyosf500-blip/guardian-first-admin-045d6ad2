import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { CarrierRecommendation, LogisticsFilters } from '@/lib/logistics.types';

interface RpcResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

async function callRpc<T>(fn: string, args: Record<string, unknown>): Promise<T[]> {
  const { data, error } = await (supabase.rpc as unknown as (
    fn: string, args: Record<string, unknown>
  ) => Promise<RpcResult<T>>)(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data ?? [];
}

interface Args {
  filters: LogisticsFilters;
  minOrders?: number;
}

/**
 * Recomendaciones de transportadora por ciudad. Para cada ciudad con
 * ≥minOrders pedidos, identifica la mejor y peor transportadora por
 * tasa de entrega y genera texto "Mantener X" o "Cambiar a X".
 */
export function useCarrierRecommendations({
  filters,
  minOrders = 20,
}: Args): UseQueryResult<CarrierRecommendation[]> {
  return useQuery<CarrierRecommendation[]>({
    queryKey: ['logistics-recommendations', filters.fromDate, filters.toDate, minOrders],
    queryFn: () => callRpc<CarrierRecommendation>('logistics_recommendations', {
      p_from_date: filters.fromDate,
      p_to_date: filters.toDate,
      p_min_orders: minOrders,
    }),
    staleTime: 5 * 60 * 1000,
  });
}

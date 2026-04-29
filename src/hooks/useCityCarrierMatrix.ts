import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { CityCarrierMatrix, LogisticsFilters } from '@/lib/logistics.types';

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
  topCities?: number;
}

/**
 * Matriz transportadora × ciudad para el heatmap de Decisiones.
 * Devuelve una fila por cada par (ciudad, transportadora) con tasa de
 * entrega y devolución. Solo incluye ciudades con ≥minOrders pedidos.
 */
export function useCityCarrierMatrix({
  filters,
  minOrders = 20,
  topCities = 20,
}: Args): UseQueryResult<CityCarrierMatrix[]> {
  return useQuery<CityCarrierMatrix[]>({
    queryKey: ['logistics-city-carrier-matrix', filters.fromDate, filters.toDate, minOrders, topCities],
    queryFn: () => callRpc<CityCarrierMatrix>('logistics_by_city_carrier', {
      p_from_date: filters.fromDate,
      p_to_date: filters.toDate,
      p_min_orders: minOrders,
      p_top_cities: topCities,
    }),
    staleTime: 5 * 60 * 1000,
  });
}

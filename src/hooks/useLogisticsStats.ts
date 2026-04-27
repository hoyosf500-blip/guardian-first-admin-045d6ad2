import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type {
  LogisticsSummary,
  CarrierStats,
  CityReturns,
  ProductFailure,
  LogisticsFilters,
} from '@/lib/logistics.types';

const STALE_5MIN = 5 * 60 * 1000;

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

export interface UseLogisticsStatsResult {
  summary: UseQueryResult<LogisticsSummary | null>;
  carriers: UseQueryResult<CarrierStats[]>;
  cities: UseQueryResult<CityReturns[]>;
  products: UseQueryResult<ProductFailure[]>;
  isLoading: boolean;
  isError: boolean;
}

export function useLogisticsStats(filters: LogisticsFilters): UseLogisticsStatsResult {
  const { fromDate, toDate, minOrders } = filters;
  const baseKey = ['logistics', fromDate, toDate, minOrders] as const;

  const summary = useQuery<LogisticsSummary | null>({
    queryKey: [...baseKey, 'summary'],
    queryFn: async () => {
      const rows = await callRpc<LogisticsSummary>('logistics_summary', {
        p_from_date: fromDate,
        p_to_date: toDate,
      });
      return rows[0] ?? null;
    },
    staleTime: STALE_5MIN,
  });

  const carriers = useQuery<CarrierStats[]>({
    queryKey: [...baseKey, 'carriers'],
    queryFn: () => callRpc<CarrierStats>('logistics_by_carrier', {
      p_from_date: fromDate,
      p_to_date: toDate,
      p_min_orders: minOrders,
    }),
    staleTime: STALE_5MIN,
  });

  const cities = useQuery<CityReturns[]>({
    queryKey: [...baseKey, 'cities'],
    queryFn: () => callRpc<CityReturns>('logistics_by_city', {
      p_from_date: fromDate,
      p_to_date: toDate,
      p_min_orders: minOrders,
      p_limit: 50,
    }),
    staleTime: STALE_5MIN,
  });

  const products = useQuery<ProductFailure[]>({
    queryKey: [...baseKey, 'products'],
    queryFn: () => callRpc<ProductFailure>('logistics_by_product', {
      p_from_date: fromDate,
      p_to_date: toDate,
      p_min_orders: minOrders,
      p_limit: 50,
    }),
    staleTime: STALE_5MIN,
  });

  return {
    summary, carriers, cities, products,
    isLoading: summary.isLoading || carriers.isLoading || cities.isLoading || products.isLoading,
    isError: summary.isError || carriers.isError || cities.isError || products.isError,
  };
}

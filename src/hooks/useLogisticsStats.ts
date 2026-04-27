import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type {
  LogisticsSummary,
  CarrierStats,
  CityReturns,
  ProductFailure,
  LogisticsFilters,
} from '@/lib/logistics.types';

// Cache corto: las RPCs son agregaciones, queremos data fresca.
// El realtime subscription (postgres_changes en `orders`) invalida el
// cache cuando hay cambios reales, así que `staleTime: 60s` es solo un piso.
const STALE_60S = 60 * 1000;

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
  const { fromDate, toDate } = filters;
  const baseKey = ['logistics', fromDate, toDate] as const;
  const queryClient = useQueryClient();

  const summary = useQuery<LogisticsSummary | null>({
    queryKey: [...baseKey, 'summary'],
    queryFn: async () => {
      const rows = await callRpc<LogisticsSummary>('logistics_summary', {
        p_from_date: fromDate,
        p_to_date: toDate,
      });
      return rows[0] ?? null;
    },
    staleTime: STALE_60S,
  });

  const carriers = useQuery<CarrierStats[]>({
    queryKey: [...baseKey, 'carriers'],
    queryFn: () => callRpc<CarrierStats>('logistics_by_carrier', {
      p_from_date: fromDate,
      p_to_date: toDate,
    }),
    staleTime: STALE_60S,
  });

  const cities = useQuery<CityReturns[]>({
    queryKey: [...baseKey, 'cities'],
    queryFn: () => callRpc<CityReturns>('logistics_by_city', {
      p_from_date: fromDate,
      p_to_date: toDate,
      p_limit: 50,
    }),
    staleTime: STALE_60S,
  });

  const products = useQuery<ProductFailure[]>({
    queryKey: [...baseKey, 'products'],
    queryFn: () => callRpc<ProductFailure>('logistics_by_product', {
      p_from_date: fromDate,
      p_to_date: toDate,
      p_limit: 50,
    }),
    staleTime: STALE_60S,
  });

  // Realtime: cualquier cambio en `orders` invalida los 4 queries
  // de logística. Debounce de 1.5s para coalescer ráfagas (ej. el
  // cron de Dropi sincronizando 100 filas en 2 segundos).
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const channel = supabase
      .channel(`logistics-rt-${fromDate}-${toDate}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'orders' },
        () => {
          if (debounceRef.current) clearTimeout(debounceRef.current);
          debounceRef.current = setTimeout(() => {
            queryClient.invalidateQueries({ queryKey: ['logistics'] });
            debounceRef.current = null;
          }, 1500);
        },
      )
      .subscribe();
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      void supabase.removeChannel(channel);
    };
  }, [queryClient, fromDate, toDate]);

  return {
    summary, carriers, cities, products,
    isLoading: summary.isLoading || carriers.isLoading || cities.isLoading || products.isLoading,
    isError: summary.isError || carriers.isError || cities.isError || products.isError,
  };
}

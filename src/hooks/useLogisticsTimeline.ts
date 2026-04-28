import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { TimelineEntry, TimelineFilters, LogisticsFilters } from '@/lib/logistics.types';

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

export interface TimelineResult {
  entries: TimelineEntry[];
  totalCount: number;
}

const DEFAULT_PAGE_SIZE = 50;

/**
 * Hook para el timeline paginado de la vista de Trazabilidad.
 *
 * El RPC devuelve `total_count` repetido en cada fila — evita un segundo
 * round-trip (vs un COUNT(*) separado). Si el resultset está vacío,
 * totalCount = 0.
 */
export function useLogisticsTimeline(
  range: LogisticsFilters,
  filters: TimelineFilters = {},
): UseQueryResult<TimelineResult> {
  const { fromDate, toDate } = range;
  const {
    estados,
    transportadora,
    search,
    page = 0,
    pageSize = DEFAULT_PAGE_SIZE,
  } = filters;

  const estadosKey = estados && estados.length > 0
    ? [...estados].map(s => s.toUpperCase()).sort()
    : null;
  const transportadoraKey = transportadora?.trim() || null;
  const searchKey = search?.trim() || null;

  return useQuery<TimelineResult>({
    queryKey: [
      'logistics', fromDate, toDate, 'timeline',
      estadosKey, transportadoraKey, searchKey, page, pageSize,
    ],
    queryFn: async () => {
      const rows = await callRpc<TimelineEntry>('logistics_timeline', {
        p_from_date: fromDate,
        p_to_date: toDate,
        p_estados: estadosKey,
        p_transportadora: transportadoraKey,
        p_search: searchKey,
        p_limit: pageSize,
        p_offset: page * pageSize,
      });
      return {
        entries: rows,
        totalCount: rows[0]?.total_count ?? 0,
      };
    },
    // El realtime de useLogisticsStats invalida toda la queryKey 'logistics'
    // cuando hay cambios en orders, así que aquí basta con un floor corto.
    staleTime: 30 * 1000,
    placeholderData: (prev) => prev,
  });
}

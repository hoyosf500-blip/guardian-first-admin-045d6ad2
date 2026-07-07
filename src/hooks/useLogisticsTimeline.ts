import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { TimelineEntry, TimelineFilters, LogisticsFilters } from '@/lib/logistics.types';

interface RpcResult<T> {
  data: T[] | null;
  error: { message: string; code?: string } | null;
}

async function rpcRaw<T>(fn: string, args: Record<string, unknown>): Promise<RpcResult<T>> {
  return await (supabase.rpc as unknown as (
    fn: string, args: Record<string, unknown>
  ) => Promise<RpcResult<T>>)(fn, args);
}

async function callRpc<T>(fn: string, args: Record<string, unknown>): Promise<T[]> {
  const { data, error } = await rpcRaw<T>(fn, args);
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
  // El filtro global de ciudad venía en `range` pero se ignoraba EN SILENCIO
  // (auditoría 2026-07-07): Trazabilidad mostraba todas las ciudades con el
  // filtro puesto. Con la RPC vieja (sin p_ciudad) reintenta sin el filtro.
  const ciudadKey = range.ciudad?.trim() || null;
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
      estadosKey, transportadoraKey, searchKey, ciudadKey, page, pageSize,
    ],
    queryFn: async () => {
      const base = {
        p_from_date: fromDate,
        p_to_date: toDate,
        p_estados: estadosKey,
        p_transportadora: transportadoraKey,
        p_search: searchKey,
        p_limit: pageSize,
        p_offset: page * pageSize,
      };
      let rows: TimelineEntry[];
      if (ciudadKey) {
        const { data, error } = await rpcRaw<TimelineEntry>('logistics_timeline', { ...base, p_ciudad: ciudadKey });
        if (!error) {
          rows = data ?? [];
        } else if (error.code === 'PGRST202' || /find the function|does not exist/i.test(error.message)) {
          // RPC deployada vieja sin p_ciudad → mismo comportamiento previo.
          rows = await callRpc<TimelineEntry>('logistics_timeline', base);
        } else {
          throw new Error(`logistics_timeline: ${error.message}`);
        }
      } else {
        rows = await callRpc<TimelineEntry>('logistics_timeline', base);
      }
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

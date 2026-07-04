import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useActiveStoreId } from '@/contexts/StoreContext';
import type { CityOption } from '@/lib/logistics.types';

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

/**
 * Lista de ciudades disponibles para el dropdown de filtro de Logística.
 * Devuelve las top N ciudades por volumen de pedidos histórico.
 *
 * Cache largo (1h) — la lista de ciudades cambia poco.
 */
export function useCityList(limit = 200): UseQueryResult<CityOption[]> {
  // get_top_cities es store-scoped server-side (_resolve_scope_store). Incluir
  // storeId en la queryKey hace que al cambiar de tienda el dropdown refetchee
  // solo, sin depender de la invalidación manual de StoreContext (que se saltea
  // si set_active_store falla). Antes: ['logistics-cities-list', limit] → mostraba
  // las ciudades de la tienda anterior hasta 1h (staleTime).
  const storeId = useActiveStoreId();
  return useQuery<CityOption[]>({
    queryKey: ['logistics-cities-list', storeId ?? 'all', limit],
    enabled: Boolean(storeId),
    queryFn: () => callRpc<CityOption>('get_top_cities', { p_limit: limit }),
    staleTime: 60 * 60 * 1000, // 1h
    gcTime: 24 * 60 * 60 * 1000,
  });
}

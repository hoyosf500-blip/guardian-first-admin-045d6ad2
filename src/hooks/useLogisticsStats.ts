import { useEffect, useId, useRef } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useActiveStoreId } from '@/contexts/StoreContext';
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
const STALE_5MIN = 5 * 60 * 1000;

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

/** ¿El error es "no existe una función con esos parámetros"? (RPC deployada
 *  vieja que aún no acepta el parámetro nuevo — PostgREST matchea por firma). */
function isFnSignatureMissing(err: { message: string; code?: string }): boolean {
  return err.code === 'PGRST202' || /find the function|does not exist/i.test(err.message);
}

/** Llama la RPC con p_ciudad; si la versión deployada aún no acepta el
 *  parámetro (migration 20260707120000 sin aplicar), reintenta SIN él —
 *  mismo comportamiento que antes del fix (filtro de ciudad ignorado). */
async function callRpcCityAware<T>(
  fn: string,
  base: Record<string, unknown>,
  ciudadKey: string | null,
): Promise<T[]> {
  if (!ciudadKey) return callRpc<T>(fn, base);
  const { data, error } = await rpcRaw<T>(fn, { ...base, p_ciudad: ciudadKey });
  if (!error) return data ?? [];
  if (isFnSignatureMissing(error)) return callRpc<T>(fn, base);
  throw new Error(`${fn}: ${error.message}`);
}

export interface UseLogisticsStatsResult {
  summary: UseQueryResult<LogisticsSummary | null>;
  carriers: UseQueryResult<CarrierStats[]>;
  cities: UseQueryResult<CityReturns[]>;
  products: UseQueryResult<ProductFailure[]>;
  isLoading: boolean;
  isError: boolean;
}

export function useLogisticsStats(
  filters: LogisticsFilters,
  opts?: { disableRealtime?: boolean },
): UseLogisticsStatsResult {
  const { fromDate, toDate, ciudad } = filters;
  const ciudadKey = ciudad?.trim() || null;
  // storeId en la key: las RPCs resuelven la tienda SERVER-side
  // (_resolve_scope_store), así que sin esto un cambio de tienda servía el
  // cache de la tienda anterior bajo la misma key (auditoría 2026-07-07).
  const storeId = useActiveStoreId();
  const baseKey = ['logistics', storeId ?? 'none', fromDate, toDate, ciudadKey] as const;
  const queryClient = useQueryClient();
  const storeReady = Boolean(storeId);

  const summary = useQuery<LogisticsSummary | null>({
    queryKey: [...baseKey, 'summary'],
    queryFn: async () => {
      const rows = await callRpc<LogisticsSummary>('logistics_summary', {
        p_from_date: fromDate,
        p_to_date: toDate,
        p_ciudad: ciudadKey,
      });
      return rows[0] ?? null;
    },
    staleTime: STALE_5MIN,
    enabled: storeReady,
  });

  const carriers = useQuery<CarrierStats[]>({
    queryKey: [...baseKey, 'carriers'],
    queryFn: () => callRpc<CarrierStats>('logistics_by_carrier', {
      p_from_date: fromDate,
      p_to_date: toDate,
      p_ciudad: ciudadKey,
    }),
    staleTime: STALE_5MIN,
    enabled: storeReady,
  });

  const cities = useQuery<CityReturns[]>({
    queryKey: [...baseKey, 'cities'],
    queryFn: () => callRpc<CityReturns>('logistics_by_city', {
      p_from_date: fromDate,
      p_to_date: toDate,
      p_limit: 50,
    }),
    staleTime: STALE_5MIN,
    // Cuando hay filtro de ciudad, esta query no aporta (sería 1 sola fila).
    // La deshabilitamos para ahorrar round-trip.
    enabled: storeReady && !ciudadKey,
  });

  const products = useQuery<ProductFailure[]>({
    queryKey: [...baseKey, 'products'],
    // p_ciudad con fallback: la RPC vieja no aceptaba ciudad y el filtro
    // global se ignoraba EN SILENCIO en la tab Productos (auditoría 2026-07-07).
    queryFn: () => callRpcCityAware<ProductFailure>('logistics_by_product', {
      p_from_date: fromDate,
      p_to_date: toDate,
      p_limit: 50,
    }, ciudadKey),
    staleTime: STALE_5MIN,
    enabled: storeReady,
  });

  // Realtime: cualquier cambio en `orders` invalida los 4 queries
  // de logística. Debounce de 5s para coalescer ráfagas (ej. el
  // cron de Dropi sincronizando 100 filas en 2 segundos) y evitar
  // que el panel parpadee mientras el admin lo está mirando.
  // El `instanceId` evita colisión cuando el mismo rango se monta
  // dos veces en la misma pantalla (ej. /cfo llama el hook para mes
  // actual desde useCfoSnapshot Y desde el bloque de productos).
  // Sin sufijo único, supabase.channel devuelve la MISMA instancia
  // y el segundo .on('postgres_changes', ...) tira "cannot add callbacks".
  const instanceId = useId();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // T3-5: opt-out de realtime cuando el hook se monta multiples veces
  // en la misma vista (ej. /cfo monta useCfoSnapshot para curr Y prev,
  // mas un tercer mount para top-products). Sin esto abrimos 3 canales
  // y cualquier UPDATE en orders dispara 3 invalidaciones.
  const disableRealtime = opts?.disableRealtime ?? false;
  useEffect(() => {
    if (disableRealtime) return;
    const channel = supabase
      .channel(`logistics-rt-${fromDate}-${toDate}-${instanceId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'orders' },
        () => {
          if (debounceRef.current) clearTimeout(debounceRef.current);
          debounceRef.current = setTimeout(() => {
            queryClient.invalidateQueries({ queryKey: ['logistics'] });
            // product-profitability NO comparte el prefijo 'logistics' → sin esto
            // la tabla de Rentabilidad quedaba stale hasta 5min mientras el resto
            // de /logística se refrescaba solo con cada sync del cron.
            queryClient.invalidateQueries({ queryKey: ['product-profitability'] });
            debounceRef.current = null;
          }, 5000);
        },
      )
      .subscribe();
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      void supabase.removeChannel(channel);
    };
  }, [queryClient, fromDate, toDate, instanceId, disableRealtime]);

  return {
    summary, carriers, cities, products,
    isLoading: summary.isLoading || carriers.isLoading || cities.isLoading || products.isLoading,
    isError: summary.isError || carriers.isError || cities.isError || products.isError,
  };
}

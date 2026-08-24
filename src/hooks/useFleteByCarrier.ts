import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useActiveStoreId } from '@/contexts/StoreContext';
import { agregarFletePorCarrier, type FleteCarrierAgg, type FleteOrderRow } from '@/lib/fleteByCarrier';

// Flete promedio por transportadora — select client-side sobre orders.
//
// Mismo patrón paginado que DashboardTab y el fallback de useGananciaNetaDropi:
// PostgREST corta en 1000 filas SIN avisar, así que se pagina a mano. Un mes de
// una tienda son ~1.000-3.000 filas de 3 columnas — liviano. La RLS desplegada
// (store-scoped) ya permite este select a cualquier miembro: es el mismo camino
// que usa /logistica → Cancelaciones en producción.

export interface FletePorCarrierData {
  porCarrier: Map<string, FleteCarrierAgg>;
  /** true si se cortó por el tope de páginas — promedios sobre muestra parcial. */
  parcial: boolean;
}

const PAGE = 1000;
// Backstop, no límite real: 10 páginas = 10.000 pedidos en un rango. Si un
// rango histórico lo supera, se marca `parcial` en vez de colgar la pestaña.
const MAX_PAGES = 10;

// `ciudad`: las filas de CarrierStatsTable vienen de logistics_by_carrier CON
// p_ciudad — si este hook no filtrara igual, con ciudad activa la columna
// "Flete prom." mezclaba conteos de la ciudad con flete de TODA la tienda en
// la misma fila (auditoría 24-ago-2026). Match .eq exacto, igual que la RPC.
// `enabled`: en modo comparación nadie dibuja esta columna — no se paga la query.
export function useFleteByCarrier(
  fromDate: string,
  toDate: string,
  ciudad?: string,
  enabled: boolean = true,
) {
  const storeId = useActiveStoreId();
  const ciudadKey = ciudad?.trim() || null;
  return useQuery<FletePorCarrierData>({
    queryKey: ['flete-por-carrier', storeId, fromDate, toDate, ciudadKey],
    queryFn: async () => {
      const filas: FleteOrderRow[] = [];
      let parcial = false;
      for (let page = 0; ; page++) {
        if (page >= MAX_PAGES) { parcial = true; break; }
        let q = supabase
          .from('orders')
          .select('transportadora, flete, estado')
          .eq('store_id', storeId as string)
          .gte('fecha', fromDate)
          .lte('fecha', toDate);
        if (ciudadKey) q = q.eq('ciudad', ciudadKey);
        const { data, error } = await q
          .order('id', { ascending: true })
          .range(page * PAGE, page * PAGE + PAGE - 1);
        if (error) throw error;
        filas.push(...((data ?? []) as FleteOrderRow[]));
        if (!data || data.length < PAGE) break;
      }
      return { porCarrier: agregarFletePorCarrier(filas), parcial };
    },
    staleTime: 5 * 60_000,
    retry: false,
    enabled: Boolean(enabled && storeId && fromDate && toDate),
  });
}

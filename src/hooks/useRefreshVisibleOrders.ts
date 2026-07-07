import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

/**
 * Sincroniza EN VIVO los pedidos recientes de la tienda contra Dropi, llamando a
 * la edge function `dropi-refresh-batch` (UNA query de lista paginada con backoff,
 * NO un request por pedido → no satura el rate-limit de Dropi). El upsert dispara
 * el realtime ya existente sobre `orders` y el tablero se mueve solo.
 *
 * Throttle GLOBAL: por defecto no re-sincroniza si la última corrida fue hace <
 * THROTTLE_MS (evita que el auto-trigger queme el cupo de Dropi). `force` lo
 * ignora (botón manual del operador).
 *
 * Uso:
 *   const { refreshNow, isRefreshing } = useRefreshVisibleOrders();
 *   refreshNow(activeStoreId, { force: true });
 */
const THROTTLE_MS = 4 * 60 * 1000; // 4 min entre sincronizaciones automáticas

// Anti-throttle 2026-07-07: el timestamp vive a NIVEL MÓDULO (antes era un
// useRef POR INSTANCIA — el doc-comment prometía "GLOBAL" pero cada navegación
// Confirmar↔Seguimiento remontaba el tab, reseteaba el ref y el auto-trigger
// del mount re-disparaba dropi-refresh-batch (hasta 20 páginas) dentro de la
// ventana de 4 min). Map por tienda: cada cuenta Dropi tiene su propio
// rate-limit — mismo patrón módulo-level que el cache de useOpenIncidences.
const lastRunByStore = new Map<string, number>();

export function useRefreshVisibleOrders() {
  const [isRefreshing, setIsRefreshing] = useState(false);

  const refreshNow = useCallback(async (
    storeId: string | null | undefined,
    opts: { silent?: boolean; force?: boolean; days?: number } = {},
  ): Promise<{ ok: boolean; refreshed?: number; partial?: boolean; rateLimited?: boolean; historyIngested?: number }> => {
    if (!storeId) {
      if (!opts.silent) toast.error('Sin tienda activa');
      return { ok: false };
    }
    const now = Date.now();
    if (!opts.force && now - (lastRunByStore.get(storeId) ?? 0) < THROTTLE_MS) {
      return { ok: true }; // throttled (silencioso)
    }
    lastRunByStore.set(storeId, now);

    setIsRefreshing(true);
    try {
      const { data, error } = await supabase.functions.invoke('dropi-refresh-batch', {
        body: { store_id: storeId, ...(opts.days ? { days: opts.days } : {}) },
      });
      if (error) {
        if (!opts.silent) toast.error(`No se pudo sincronizar: ${error.message || 'error'}`);
        return { ok: false };
      }
      const result = (data || {}) as {
        ok?: boolean; error?: string; refreshed?: number; partial?: boolean; rateLimited?: boolean; historyIngested?: number;
      };
      if (!result.ok) {
        if (!opts.silent) toast.error(result.error || 'No se pudo sincronizar');
        return { ok: false };
      }

      const refreshed = result.refreshed ?? 0;
      if (!opts.silent) {
        if (result.rateLimited && refreshed === 0) {
          toast.warning('Dropi está saturado ahora mismo — esperá ~1 min y reintentá', { duration: 6000 });
        } else if (result.rateLimited) {
          toast.warning(`Dropi limitó las peticiones — alcancé a sincronizar ${refreshed}`, { duration: 6000 });
        } else {
          const histNote = result.historyIngested ? ` · ${result.historyIngested} estados de historial` : '';
          toast.success(`Sincronizado · ${refreshed} pedido${refreshed === 1 ? '' : 's'} al día${histNote}${result.partial ? ' (parcial)' : ''}`);
        }
      }
      return { ok: true, refreshed, partial: result.partial, rateLimited: result.rateLimited, historyIngested: result.historyIngested };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!opts.silent) toast.error(`Error: ${msg}`);
      return { ok: false };
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  return { refreshNow, isRefreshing };
}

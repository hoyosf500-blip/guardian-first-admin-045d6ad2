import { useState, useCallback, useRef } from 'react';
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

export function useRefreshVisibleOrders() {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const lastRunRef = useRef<number>(0);

  const refreshNow = useCallback(async (
    storeId: string | null | undefined,
    opts: { silent?: boolean; force?: boolean; days?: number } = {},
  ): Promise<{ ok: boolean; refreshed?: number; partial?: boolean; rateLimited?: boolean }> => {
    if (!storeId) {
      if (!opts.silent) toast.error('Sin tienda activa');
      return { ok: false };
    }
    const now = Date.now();
    if (!opts.force && now - lastRunRef.current < THROTTLE_MS) {
      return { ok: true }; // throttled (silencioso)
    }
    lastRunRef.current = now;

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
        ok?: boolean; error?: string; refreshed?: number; partial?: boolean; rateLimited?: boolean;
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
          toast.success(`Sincronizado · ${refreshed} pedido${refreshed === 1 ? '' : 's'} al día${result.partial ? ' (parcial)' : ''}`);
        }
      }
      return { ok: true, refreshed, partial: result.partial, rateLimited: result.rateLimited };
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

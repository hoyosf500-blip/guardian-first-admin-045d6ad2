import { useState, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

/**
 * Refresca EN VIVO el estado real de Dropi de un conjunto de pedidos (los que
 * la operadora está viendo) en una sola llamada — versión por lotes de
 * useRefreshOrder. Llama a la edge function `dropi-refresh-batch`, que GETea
 * cada pedido en Dropi y los upsertea; el realtime ya existente sobre `orders`
 * mueve las tarjetas del tablero solo.
 *
 * Throttle client-side: por defecto NO re-pide un external_id refrescado hace
 * menos de THROTTLE_MS (evita martillar Dropi cuando el auto-trigger se dispara
 * seguido). `force` lo ignora (botón manual del operador).
 *
 * Uso:
 *   const { refreshVisible, isRefreshing } = useRefreshVisibleOrders();
 *   refreshVisible(activeStoreId, ['5524001','5529961'], { force: true });
 */
const THROTTLE_MS = 3 * 60 * 1000; // 3 min por external_id
const MAX_PER_CALL = 40;           // espejo del cap del edge

export function useRefreshVisibleOrders() {
  const [isRefreshing, setIsRefreshing] = useState(false);
  // external_id → timestamp del último refresh pedido (throttle).
  const lastRefreshRef = useRef<Map<string, number>>(new Map());

  const refreshVisible = useCallback(async (
    storeId: string | null | undefined,
    externalIds: Array<string | number | null | undefined>,
    opts: { silent?: boolean; force?: boolean } = {},
  ): Promise<{ ok: boolean; refreshed?: number; changed?: number; partial?: boolean }> => {
    if (!storeId) {
      if (!opts.silent) toast.error('Sin tienda activa');
      return { ok: false };
    }

    const now = Date.now();
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const raw of externalIds) {
      const id = String(raw ?? '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (!opts.force) {
        const last = lastRefreshRef.current.get(id);
        if (last && now - last < THROTTLE_MS) continue; // refrescado hace poco
      }
      ids.push(id);
      if (ids.length >= MAX_PER_CALL) break;
    }

    if (ids.length === 0) {
      if (!opts.silent) toast.info('Ya está al día — nada para refrescar ahora');
      return { ok: true, refreshed: 0, changed: 0 };
    }

    setIsRefreshing(true);
    try {
      const { data, error } = await supabase.functions.invoke('dropi-refresh-batch', {
        body: { store_id: storeId, external_ids: ids },
      });
      if (error) {
        if (!opts.silent) toast.error(`No se pudo sincronizar: ${error.message || 'error'}`);
        return { ok: false };
      }
      const result = (data || {}) as {
        ok?: boolean; error?: string; refreshed?: number; changed?: number;
        rateLimited?: boolean; partial?: boolean; total?: number;
      };
      if (!result.ok) {
        if (!opts.silent) toast.error(result.error || 'No se pudo sincronizar');
        return { ok: false };
      }

      // Marca como refrescados los que SÍ se enviaron.
      const stamp = Date.now();
      ids.forEach((id) => lastRefreshRef.current.set(id, stamp));

      if (!opts.silent) {
        const changed = result.changed ?? 0;
        const refreshed = result.refreshed ?? 0;
        if (result.rateLimited) {
          toast.warning(`Dropi limitó las peticiones — sincronicé ${refreshed} y sigo luego`, { duration: 6000 });
        } else if (changed > 0) {
          toast.success(`Sincronizado · ${changed} pedido${changed > 1 ? 's' : ''} cambió de estado`);
        } else {
          toast.success(`Sincronizado · ${refreshed} al día${result.partial ? ' (parcial)' : ''}`);
        }
      }
      return { ok: true, refreshed: result.refreshed, changed: result.changed, partial: result.partial };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!opts.silent) toast.error(`Error: ${msg}`);
      return { ok: false };
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  return { refreshVisible, isRefreshing };
}

import { useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { User } from '@supabase/supabase-js';

interface RealtimeCallbacks {
  /** Fires on any orders change (UPDATE/INSERT/DELETE). Use to refetch
   *  seguimiento, rescate and novedades queues. */
  onOrderChange?: () => void;
  /** Fires when an operator inserts an order_result (confirma/cancela/noresp). */
  onResultChange?: () => void;
}

/**
 * Subscribes to live changes on the `orders` and `order_results` tables.
 *
 * - One channel per user; closed on unmount or when the user signs out.
 * - Las callbacks se leen vía useRef en cada evento, por lo que su
 *   identidad NO reconstruye el canal. Solo cambios en `user` lo hacen.
 *
 * M6: el debounce interno de 500ms se eliminó. El callback de
 * `OrderContext.debouncedRefreshAll` ya tiene su propio debounce de
 * 800ms; teniendo dos en cadena se sumaban a ~1.3 s de latencia mínima
 * sin agregar protección real.
 */
export function useRealtimeOrders(
  user: User | null,
  { onOrderChange, onResultChange }: RealtimeCallbacks,
  storeId?: string | null,
) {
  const orderCb = useRef(onOrderChange);
  const resultCb = useRef(onResultChange);
  orderCb.current = onOrderChange;
  resultCb.current = onResultChange;

  // FIX "se reinicia al volver de la pestaña": mientras la pestaña está oculta,
  // los cambios (sobre todo del cron cada 5 min) se encolan y al volver disparan
  // TODOS de golpe → un refresh masivo que reconstruye las colas y resetea el
  // scroll / la tarjeta en la que estaba la operadora. Suprimimos los eventos
  // realtime mientras está oculta Y durante una ventana corta apenas vuelve
  // (drena el burst de reconexión). Los eventos nuevos en vivo siguen fluyendo;
  // si se pierde alguno, el poll de 15 min y el botón "Actualizar" lo recuperan.
  const suppressUntilRef = useRef(0);
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        suppressUntilRef.current = Date.now() + 2500;
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  useEffect(() => {
    if (!user || !storeId) return;

    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    const shouldSuppress = () =>
      document.visibilityState === 'hidden' || Date.now() < suppressUntilRef.current;
    const fireOrder = () => { if (!shouldSuppress()) orderCb.current?.(); };
    const fireResult = () => { if (!shouldSuppress()) resultCb.current?.(); };

    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (cancelled) return;
      if (session?.access_token) {
        await supabase.realtime.setAuth(session.access_token);
      }

      // Multi-tienda: filtramos orders por store_id activo. order_results
      // no tiene filter (RLS de operator_id ya lo limita al user).
      channel = supabase
        .channel(`realtime-orders-${user.id}-${storeId}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'orders', filter: `store_id=eq.${storeId}` },
          () => { fireOrder(); },
        )
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'order_results' },
          () => { fireResult(); },
        )
        .subscribe((status) => {
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            console.warn('[realtime] channel status', status);
          }
        });
    })();

    return () => {
      cancelled = true;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [user, storeId]);
}

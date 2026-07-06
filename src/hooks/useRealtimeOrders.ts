import { useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { User } from '@supabase/supabase-js';

interface RealtimeCallbacks {
  /** Fires on any orders change (UPDATE/INSERT/DELETE). Use to refetch
   *  seguimiento, rescate and novedades queues. */
  onOrderChange?: () => void;
  /** Fires when an operator inserts an order_result (confirma/cancela/noresp). */
  onResultChange?: () => void;
  /** Fires ONCE cuando la pestaña vuelve a estar visible, después de drenar el
   *  burst de reconexión. Hallazgo 6: mientras la pestaña estaba oculta,
   *  `shouldSuppress` DESCARTABA los eventos realtime sin recargar; al volver
   *  se perdían para siempre y la cola quedaba congelada. Este catch-up dispara
   *  un refresh explícito para recuperar lo perdido. Si no se pasa, cae a
   *  `onOrderChange`. */
  onVisibleCatchUp?: () => void;
  /** Fires en cada INSERT de un pedido nuevo en `orders` (Hallazgo 7). Recibe
   *  la fila cruda del payload. A diferencia de onOrderChange, NO se suprime
   *  con la pestaña oculta: justamente sirve para avisar a la operadora
   *  (notificación + badge en el título) que llegó un pedido y hay que llamar
   *  ahora, mientras la intención de compra está caliente. */
  onOrderInsert?: (row: Record<string, unknown>) => void;
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
  { onOrderChange, onResultChange, onVisibleCatchUp, onOrderInsert }: RealtimeCallbacks,
  storeId?: string | null,
) {
  const orderCb = useRef(onOrderChange);
  const resultCb = useRef(onResultChange);
  const catchUpCb = useRef(onVisibleCatchUp);
  const insertCb = useRef(onOrderInsert);
  orderCb.current = onOrderChange;
  resultCb.current = onResultChange;
  catchUpCb.current = onVisibleCatchUp;
  insertCb.current = onOrderInsert;

  // FIX "se reinicia al volver de la pestaña": mientras la pestaña está oculta,
  // los cambios (sobre todo del cron cada 5 min) se encolan y al volver disparan
  // TODOS de golpe → un refresh masivo que reconstruye las colas y resetea el
  // scroll / la tarjeta en la que estaba la operadora. Suprimimos los eventos
  // realtime mientras está oculta Y durante una ventana corta apenas vuelve
  // (drena el burst de reconexión). Los eventos nuevos en vivo siguen fluyendo;
  // si se pierde alguno, el poll de 15 min y el botón "Actualizar" lo recuperan.
  const suppressUntilRef = useRef(0);
  const catchUpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const DRAIN_MS = 2500;
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        suppressUntilRef.current = Date.now() + DRAIN_MS;
        // Hallazgo 6: tras drenar el burst de reconexión, disparamos UN
        // catch-up explícito. Los eventos que llegaron con la pestaña oculta
        // fueron descartados por `shouldSuppress`; sin este refresh la cola se
        // quedaría con datos viejos hasta el próximo poll. Debounce simple: si
        // el usuario alterna visibilidad varias veces, solo corre el último.
        if (catchUpTimerRef.current) clearTimeout(catchUpTimerRef.current);
        catchUpTimerRef.current = setTimeout(() => {
          catchUpTimerRef.current = null;
          // Solo si seguimos visibles (no re-ocultó durante el drain).
          if (document.visibilityState !== 'visible') return;
          (catchUpCb.current ?? orderCb.current)?.();
        }, DRAIN_MS);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      if (catchUpTimerRef.current) clearTimeout(catchUpTimerRef.current);
    };
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

      // Multi-tienda: filtramos AMBAS tablas por store_id activo. Antes
      // order_results iba sin filtro (se confiaba en RLS), así que un INSERT en
      // OTRA tienda de la que el user es miembro disparaba un refetch inútil de
      // la tienda activa. Con el filtro, el trigger queda scopeado a la tienda
      // que se está viendo — mismo patrón que `orders`.
      channel = supabase
        .channel(`realtime-orders-${user.id}-${storeId}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'orders', filter: `store_id=eq.${storeId}` },
          (payload) => {
            fireOrder();
            // Hallazgo 7: en INSERT de un pedido nuevo, avisamos SIEMPRE (aunque
            // la pestaña esté oculta — ese es el punto: traer de vuelta a la
            // operadora). El consumer filtra por estado PENDIENTE CONFIRMACION.
            if (payload.eventType === 'INSERT' && payload.new) {
              insertCb.current?.(payload.new as Record<string, unknown>);
            }
          },
        )
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'order_results', filter: `store_id=eq.${storeId}` },
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

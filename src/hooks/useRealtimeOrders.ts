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
 * - Bursts of events are coalesced via a 500ms trailing debounce so a
 *   sync of 1000 rows doesn't fire 1000 refetches.
 *
 * Pass stable callbacks (wrap in useCallback) — the channel is rebuilt
 * whenever a callback identity changes.
 */
export function useRealtimeOrders(user: User | null, { onOrderChange, onResultChange }: RealtimeCallbacks) {
  // Keep latest callback refs so we don't tear down the channel every
  // render of the parent component.
  const orderCb = useRef(onOrderChange);
  const resultCb = useRef(onResultChange);
  orderCb.current = onOrderChange;
  resultCb.current = onResultChange;

  useEffect(() => {
    if (!user) return;

    let orderTimer: ReturnType<typeof setTimeout> | null = null;
    let resultTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    const fireOrder = () => {
      if (orderTimer) clearTimeout(orderTimer);
      orderTimer = setTimeout(() => {
        orderCb.current?.();
        orderTimer = null;
      }, 500);
    };

    const fireResult = () => {
      if (resultTimer) clearTimeout(resultTimer);
      resultTimer = setTimeout(() => {
        resultCb.current?.();
        resultTimer = null;
      }, 500);
    };

    (async () => {
      // Realtime applies RLS, so it needs the user's JWT. Without this the
      // connection negotiates anonymously and the server eventually drops it
      // with TIMED_OUT.
      const { data: { session } } = await supabase.auth.getSession();
      if (cancelled) return;
      if (session?.access_token) {
        await supabase.realtime.setAuth(session.access_token);
      }

      channel = supabase
        .channel(`realtime-orders-${user.id}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'orders' },
          () => {
            fireOrder();
          },
        )
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'order_results' },
          () => {
            fireResult();
          },
        )
        .subscribe((status) => {
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            console.warn('[realtime] channel status', status);
          }
        });
    })();

    return () => {
      cancelled = true;
      if (orderTimer) clearTimeout(orderTimer);
      if (resultTimer) clearTimeout(resultTimer);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [user]);
}

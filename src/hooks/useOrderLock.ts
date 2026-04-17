import { useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { OrderData, dbToOrderData } from '@/lib/orderUtils';

/**
 * Order locking — prevents two operators from working the same order.
 * Locks expire after 15 minutes server-side and are cleaned by a cron job.
 */
export function useOrderLock() {
  const claimOrder = useCallback(async (orderId: string): Promise<OrderData | null> => {
    // claim_order RPC returns SETOF orders: row if claim succeeded, empty if locked by someone else.
    // Cast through unknown because the RPC isn't yet in the generated supabase types.
    const { data, error } = await (supabase.rpc as unknown as (
      fn: string, args: Record<string, unknown>
    ) => Promise<{ data: unknown; error: { message: string } | null }>)('claim_order', { p_order_id: orderId });
    if (error) {
      console.warn('claim_order failed:', error.message);
      return null;
    }
    const rows = Array.isArray(data) ? data : [];
    if (!rows.length) return null;
    return dbToOrderData(rows[0] as Parameters<typeof dbToOrderData>[0], 0);
  }, []);

  const releaseOrder = useCallback(async (orderId: string): Promise<void> => {
    const { error } = await (supabase.rpc as unknown as (
      fn: string, args: Record<string, unknown>
    ) => Promise<{ error: { message: string } | null }>)('release_order', { p_order_id: orderId });
    if (error) console.warn('release_order failed:', error.message);
  }, []);

  return { claimOrder, releaseOrder };
}

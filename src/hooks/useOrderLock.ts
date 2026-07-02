import { useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { OrderData, dbToOrderData } from '@/lib/orderUtils';

/**
 * Resultado discriminado de `claimOrder`.
 *  - `ok: true`  → conseguimos el lock; `order` es el pedido mapeado.
 *  - `ok: false, reason: 'error'`   → el RPC devolvió error (red/RLS/500/timeout).
 *      NO es un lock ajeno — la operadora debe QUEDARSE en el pedido y reintentar.
 *  - `ok: false, reason: 'locked'`  → el RPC volvió sin filas. No podemos
 *      distinguir server-side entre "lo tiene otra operadora" y "el pedido ya
 *      no es elegible" (phone vacío / estado cambiado) sin tocar la RPC, así que
 *      usamos 'locked' para el caso sin-filas. En ambos casos la acción del
 *      caller es la misma: saltar al siguiente.
 *  - `ok: false, reason: 'no-elegible'` → reservado para cuando la RPC pueda
 *      distinguir el motivo. Hoy no se emite, pero el caller lo trata igual que
 *      'locked' (saltar).
 */
export type ClaimResult =
  | { ok: true; order: OrderData }
  | { ok: false; reason: 'locked' | 'error' | 'no-elegible' };

/**
 * Order locking — prevents two operators from working the same order.
 * Locks expire after 15 minutes server-side and are cleaned by a cron job.
 */
export function useOrderLock() {
  const claimOrder = useCallback(async (orderId: string): Promise<ClaimResult> => {
    // claim_order RPC returns SETOF orders: row if claim succeeded, empty if locked by someone else.
    // Cast through unknown because the RPC isn't yet in the generated supabase types.
    const { data, error } = await (supabase.rpc as unknown as (
      fn: string, args: Record<string, unknown>
    ) => Promise<{ data: unknown; error: { message: string } | null }>)('claim_order', { p_order_id: orderId });
    if (error) {
      // Error REAL del RPC (red caída, RLS, 500, timeout). NO confundir con un
      // lock ajeno — sin filas ≠ error. El caller reintenta sin saltar.
      console.warn('claim_order failed:', error.message);
      return { ok: false, reason: 'error' };
    }
    const rows = Array.isArray(data) ? data : [];
    if (!rows.length) return { ok: false, reason: 'locked' };
    return { ok: true, order: dbToOrderData(rows[0] as Parameters<typeof dbToOrderData>[0], 0) };
  }, []);

  const releaseOrder = useCallback(async (orderId: string): Promise<void> => {
    const { error } = await (supabase.rpc as unknown as (
      fn: string, args: Record<string, unknown>
    ) => Promise<{ error: { message: string } | null }>)('release_order', { p_order_id: orderId });
    if (error) console.warn('release_order failed:', error.message);
  }, []);

  return { claimOrder, releaseOrder };
}

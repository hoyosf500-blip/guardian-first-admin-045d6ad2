import { useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

/**
 * Asignación persistente de pedidos en Seguimiento y Rescate.
 * Es distinta de useOrderLock — esa usa locked_by/locked_at como bloqueo
 * temporal (15 min) para Confirmar. Aquí usamos assigned_to: el pedido
 * permanece asignado hasta que la operadora ejecute una acción resolutiva
 * (Resuelto, Devolucion solicitada/Solicite devolucion) o lo libere manual.
 */
export function useSegAssignment() {
  const claimSegOrder = useCallback(async (orderId: string): Promise<boolean> => {
    const { data, error } = await (supabase.rpc as unknown as (
      fn: string, args: Record<string, unknown>
    ) => Promise<{ data: unknown; error: { message: string } | null }>)('claim_seg_order', { p_order_id: orderId });
    if (error) {
      console.warn('claim_seg_order failed:', error.message);
      return false;
    }
    return Boolean(data);
  }, []);

  const releaseSegOrder = useCallback(async (orderId: string): Promise<boolean> => {
    const { data, error } = await (supabase.rpc as unknown as (
      fn: string, args: Record<string, unknown>
    ) => Promise<{ data: unknown; error: { message: string } | null }>)('release_seg_order', { p_order_id: orderId });
    if (error) {
      console.warn('release_seg_order failed:', error.message);
      return false;
    }
    return Boolean(data);
  }, []);

  return { claimSegOrder, releaseSegOrder };
}

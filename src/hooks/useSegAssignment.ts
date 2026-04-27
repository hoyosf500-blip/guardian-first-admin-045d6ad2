import { useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

/**
 * Asignación persistente de pedidos en Seguimiento y Rescate.
 * Es distinta de useOrderLock — esa usa locked_by/locked_at como bloqueo
 * temporal (15 min) para Confirmar. Aquí usamos assigned_to: el pedido
 * permanece asignado hasta que la operadora ejecute una acción resolutiva
 * (Resuelto, Devolucion solicitada/Solicite devolucion) o lo libere manual.
 *
 * Admins NUNCA reclaman ni liberan pedidos: cuando un admin entra a la app
 * para auditar (o por error), no debe contaminar las asignaciones reales
 * de las operadoras. Las funciones devuelven `true` sin hacer la RPC para
 * que el flujo del UI siga funcionando (acciones, touchpoints) sin
 * modificar la columna assigned_to.
 */
export function useSegAssignment() {
  const { isAdmin } = useAuth();

  const claimSegOrder = useCallback(async (orderId: string): Promise<boolean> => {
    if (isAdmin) return true;
    const { data, error } = await (supabase.rpc as unknown as (
      fn: string, args: Record<string, unknown>
    ) => Promise<{ data: unknown; error: { message: string } | null }>)('claim_seg_order', { p_order_id: orderId });
    if (error) {
      console.warn('claim_seg_order failed:', error.message);
      return false;
    }
    return Boolean(data);
  }, [isAdmin]);

  const releaseSegOrder = useCallback(async (orderId: string): Promise<boolean> => {
    if (isAdmin) return true;
    const { data, error } = await (supabase.rpc as unknown as (
      fn: string, args: Record<string, unknown>
    ) => Promise<{ data: unknown; error: { message: string } | null }>)('release_seg_order', { p_order_id: orderId });
    if (error) {
      console.warn('release_seg_order failed:', error.message);
      return false;
    }
    return Boolean(data);
  }, [isAdmin]);

  return { claimSegOrder, releaseSegOrder };
}

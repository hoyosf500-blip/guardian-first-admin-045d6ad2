import { useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useStore } from '@/contexts/StoreContext';

/**
 * Asignación persistente de pedidos en Seguimiento y Rescate.
 * Es distinta de useOrderLock — esa usa locked_by/locked_at como bloqueo
 * temporal (15 min) para Confirmar. Aquí usamos assigned_to: el pedido
 * permanece asignado hasta que la operadora ejecute una acción resolutiva
 * (Resuelto, Devolucion solicitada/Solicite devolucion) o lo libere manual.
 *
 * Ni el admin global NI el DUEÑO de la tienda reclaman/liberan pedidos: cuando
 * el jefe entra a mirar la cola de su equipo, no debe robarles la asignación
 * (auditoría multi-tienda 2026-08-13: un dueño nuevo que abría Seguimiento se
 * auto-asignaba los pedidos de sus operadoras). El supervisor SÍ trabaja la cola,
 * así que sigue reclamando como una operadora. Las funciones devuelven `true`
 * sin hacer la RPC para que el flujo del UI siga (acciones, touchpoints) sin
 * tocar assigned_to.
 */
export function useSegAssignment() {
  const { isAdmin } = useAuth();
  const { isOwnerOfActive } = useStore();
  const esJefe = isAdmin || isOwnerOfActive;

  const claimSegOrder = useCallback(async (orderId: string): Promise<boolean> => {
    if (esJefe) return true;
    const { data, error } = await (supabase.rpc as unknown as (
      fn: string, args: Record<string, unknown>
    ) => Promise<{ data: unknown; error: { message: string } | null }>)('claim_seg_order', { p_order_id: orderId });
    if (error) {
      console.warn('claim_seg_order failed:', error.message);
      return false;
    }
    return Boolean(data);
  }, [esJefe]);

  const releaseSegOrder = useCallback(async (orderId: string): Promise<boolean> => {
    if (esJefe) return true;
    const { data, error } = await (supabase.rpc as unknown as (
      fn: string, args: Record<string, unknown>
    ) => Promise<{ data: unknown; error: { message: string } | null }>)('release_seg_order', { p_order_id: orderId });
    if (error) {
      console.warn('release_seg_order failed:', error.message);
      return false;
    }
    return Boolean(data);
  }, [esJefe]);

  return { claimSegOrder, releaseSegOrder };
}

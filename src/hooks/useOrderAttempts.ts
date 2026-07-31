import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { AttemptRow } from '@/lib/attemptFormat';

/**
 * Historial de intentos de confirmación de UN pedido (Fase 2a).
 * Lee `order_results` por order_id (cada conf/canc/noresp que quedó registrado,
 * con operator_id + hora) para mostrarlo en la ficha → la asesora ve qué hizo
 * cada quién y no repite trabajo. Realtime: si otra asesora registra un intento
 * sobre ESTE pedido, se refresca solo (filtro por order_id, no re-consulta por
 * cada acción de la tienda).
 */
export function useOrderAttempts(orderId?: string | null) {
  const [attempts, setAttempts] = useState<AttemptRow[]>([]);
  const [loading, setLoading] = useState(false);
  // "No se pudo leer" no es lo mismo que "nadie llamó todavía": con el error
  // tragado, la ficha decía "sin intentos" y la asesora volvía a llamar a un
  // cliente que su compañera ya había gestionado hace diez minutos.
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    if (!orderId) { setAttempts([]); setLoadError(false); return; }
    setLoading(true);
    const { data, error } = await supabase
      .from('order_results')
      .select('id, result, reason, operator_id, result_time, result_date, created_at')
      .eq('order_id', orderId)
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) {
      console.warn('[useOrderAttempts] no se pudo leer el historial:', error.message);
      setLoadError(true);
    } else {
      setLoadError(false);
      setAttempts((data || []) as AttemptRow[]);
    }
    setLoading(false);
  }, [orderId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!orderId) return;
    const ch = supabase
      .channel(`order-attempts-${orderId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'order_results', filter: `order_id=eq.${orderId}` },
        () => { void load(); },
      )
      .subscribe();
    return () => { void supabase.removeChannel(ch); };
  }, [orderId, load]);

  return { attempts, loading, loadError, reload: load };
}

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { isSegCloser } from '@/lib/segDailyReview';

/**
 * Ventana de búsqueda de cierres. Cubre con holgura la ventana de datos de
 * Seguimiento (45 días) → un pedido visible siempre cae dentro. Acota la query
 * para no traer touchpoints de hace meses que ya no aplican.
 */
const CLOSER_LOOKBACK_DAYS = 90;

/**
 * Mapa `phone → timestamp(ms)` del ÚLTIMO cierre (Resuelto/Devolución) registrado
 * por CUALQUIER operadora de la tienda. Sirve para sacar de Seguimiento, de forma
 * permanente, los pedidos que el equipo YA resolvió o devolvió — "si ya se
 * entregó o se devolvió, no vuelve a salir" (el panel solo debe tener pedidos
 * accionables).
 *
 * Es **team-wide** (no per-operadora): si una asesora cierra un pedido, desaparece
 * para todas, porque el panel es compartido y todo lo que está ahí hay que
 * gestionarlo. El consumidor (SeguimientoTab) cruza este mapa con la fecha del
 * pedido vía `isClosedOutByCloser` para no esconder pedidos NUEVOS de un cliente
 * que ya tuvo un cierre viejo (el match de touchpoints es por phone, no order_id).
 *
 * Store-scoped + reset al cambiar de tienda (evita mezcla — ver memoria
 * store_switch_stale_loaders). Realtime para reflejar cierres de otras operadoras
 * en vivo, sin recargar todo.
 */
export function useSegClosedPhones(storeId: string | null): Map<string, number> {
  const [closed, setClosed] = useState<Map<string, number>>(new Map());

  const load = useCallback(async () => {
    if (!storeId) { setClosed(new Map()); return; }
    const cutoffIso = new Date(Date.now() - CLOSER_LOOKBACK_DAYS * 86400000).toISOString();
    const { data, error } = await supabase
      .from('touchpoints')
      .select('phone, action, created_at')
      .eq('store_id', storeId)
      .ilike('action', 'SEG:%')
      .gte('created_at', cutoffIso);
    if (error || !data) return;
    const map = new Map<string, number>();
    for (const t of data as { phone: string; action: string; created_at: string }[]) {
      if (!t.phone || !isSegCloser(t.action)) continue;
      const ms = new Date(t.created_at).getTime();
      const prev = map.get(t.phone);
      if (prev === undefined || ms > prev) map.set(t.phone, ms);
    }
    setClosed(map);
  }, [storeId]);

  // Reset inmediato al cambiar de tienda + recarga. Sin el reset, el mapa de la
  // tienda anterior seguiría escondiendo phones en la nueva (mezcla client-side).
  useEffect(() => {
    setClosed(new Map());
    void load();
  }, [load]);

  // Realtime: un cierre nuevo de CUALQUIER operadora se refleja sin recargar.
  // Postgres Realtime no soporta ILIKE → filtramos client-side (action SEG:* de
  // cierre) + por store_id (multi-tenant). Mismo patrón que SegCounterBar.
  useEffect(() => {
    if (!storeId) return;
    const channel = supabase
      .channel(`seg-closed-${storeId}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'touchpoints' },
        (payload) => {
          const row = payload.new as { phone?: string; action?: string; store_id?: string; created_at?: string };
          if (row.store_id !== storeId) return;
          if (!row.phone || !row.action || !isSegCloser(row.action)) return;
          const ms = row.created_at ? new Date(row.created_at).getTime() : Date.now();
          setClosed(prev => {
            const cur = prev.get(row.phone!);
            if (cur !== undefined && cur >= ms) return prev;
            const next = new Map(prev);
            next.set(row.phone!, ms);
            return next;
          });
        },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [storeId]);

  return closed;
}

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';

/**
 * Índice agregado de notas por pedido para la lista (Confirmar / Seguimiento).
 *
 * Hace UNA sola query: `select order_id, remind_at from notes where store_id=?
 * and order_id in (...)`. Agrupa client-side por `order_id` y devuelve un Map
 * con el conteo y la próxima `remind_at` (la más vieja todavía pendiente, o la
 * mínima si no hay pendientes — la UI distingue con `isReminderDue`).
 *
 * Realtime: misma suscripción global `notes:store_id=eq.<storeId>` que
 * `useOrderNotes`, refetch al cambio.
 */
export interface NoteIndexEntry {
  count: number;
  nextReminderAt: string | null;
}
export type NoteIndex = Map<string, NoteIndexEntry>;

const EMPTY_INDEX: NoteIndex = new Map();

export function useOrderNotesIndex(
  storeId: string | null,
  orderIds: string[],
): NoteIndex {
  const [index, setIndex] = useState<NoteIndex>(EMPTY_INDEX);

  // Firma estable: ordenamos para no refetchear cuando solo cambia la
  // referencia del array padre (caso común con buildWorkQueue/visibleQueue).
  const idsKey = orderIds.length === 0 ? '' : [...orderIds].sort().join(',');

  const load = useCallback(async () => {
    if (!storeId || !idsKey) { setIndex(EMPTY_INDEX); return; }
    const ids = idsKey.split(',');
    const { data, error } = await supabase
      .from('notes')
      .select('order_id, remind_at')
      .eq('store_id', storeId)
      .in('order_id', ids);
    if (error || !data) { setIndex(EMPTY_INDEX); return; }
    const m: NoteIndex = new Map();
    for (const row of data as Array<{ order_id: string | null; remind_at: string | null }>) {
      if (!row.order_id) continue;
      const cur = m.get(row.order_id) || { count: 0, nextReminderAt: null };
      cur.count += 1;
      if (row.remind_at && (!cur.nextReminderAt || row.remind_at < cur.nextReminderAt)) {
        cur.nextReminderAt = row.remind_at;
      }
      m.set(row.order_id, cur);
    }
    setIndex(m);
  }, [storeId, idsKey]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!storeId) return;
    const ch = supabase
      .channel(`notes-index-${storeId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'notes', filter: `store_id=eq.${storeId}` },
        () => { void load(); },
      )
      .subscribe();
    return () => { void supabase.removeChannel(ch); };
  }, [storeId, load]);

  return index;
}

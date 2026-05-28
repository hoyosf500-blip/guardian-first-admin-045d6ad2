import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useStore } from '@/contexts/StoreContext';

/**
 * Notas y recordatorios por pedido (compartidas dentro de la tienda).
 *
 * Diseño:
 *  - Query default por `phone` (igual que OrderDetailPage) para que la asesora
 *    vea TODAS las notas del mismo cliente, no solo del pedido actual.
 *  - Si solo hay `orderId`, se cae a eso.
 *  - Realtime: una suscripción al canal de notas filtrada por la tienda
 *    activa. Cualquier INSERT/UPDATE/DELETE refresca la lista (volumen bajo,
 *    refetch simple). Esto hace que dos asesoras viendo el mismo cliente
 *    vean en vivo lo que escribe la otra (continuidad entre turnos).
 *  - INSERT incluye `store_id: activeStoreId` — la RLS nueva
 *    (`is_store_member(store_id)`) lo exige.
 */
export interface NoteRow {
  id: string;
  order_id: string | null;
  phone: string;
  note_text: string;
  operator_id: string;
  store_id: string | null;
  remind_at: string | null;
  created_at: string;
}

interface UseOrderNotesArgs {
  phone?: string | null;
  orderId?: string | null;
}

interface AddNoteOpts {
  remindAt?: string | Date | null;
}

export function useOrderNotes({ phone, orderId }: UseOrderNotesArgs) {
  const { user } = useAuth();
  const { activeStoreId } = useStore();
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!activeStoreId) { setNotes([]); return; }
    if (!phone && !orderId) { setNotes([]); return; }
    setIsLoading(true); setError(null);
    let q = supabase.from('notes').select('*')
      .eq('store_id', activeStoreId)
      .order('created_at', { ascending: false })
      .limit(50);
    if (phone) q = q.eq('phone', phone);
    else if (orderId) q = q.eq('order_id', orderId);
    const { data, error: e } = await q;
    if (e) {
      setError(e.message);
      setIsLoading(false);
      return;
    }
    setNotes((data || []) as NoteRow[]);
    setIsLoading(false);
  }, [phone, orderId, activeStoreId]);

  useEffect(() => { void load(); }, [load]);

  // Realtime: refresca cuando cualquier asesora de la tienda cambia notas.
  useEffect(() => {
    if (!activeStoreId) return;
    const ch = supabase
      .channel(`notes-${activeStoreId}-${phone || orderId || 'none'}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'notes', filter: `store_id=eq.${activeStoreId}` },
        () => { void load(); },
      )
      .subscribe();
    return () => { void supabase.removeChannel(ch); };
  }, [activeStoreId, phone, orderId, load]);

  const addNote = useCallback(async (text: string, opts: AddNoteOpts = {}) => {
    if (!user || !activeStoreId) return { ok: false as const, error: 'sin usuario o tienda activa' };
    const cleaned = (text || '').trim().slice(0, 1000);
    if (!cleaned) return { ok: false as const, error: 'nota vacía' };
    const remind_at = opts.remindAt
      ? (opts.remindAt instanceof Date
          ? opts.remindAt.toISOString()
          : new Date(opts.remindAt).toISOString())
      : null;
    const { data, error: e } = await supabase.from('notes').insert({
      order_id: orderId || null,
      phone: phone || '',
      note_text: cleaned,
      operator_id: user.id,
      store_id: activeStoreId,
      remind_at,
    }).select().single();
    if (e) return { ok: false as const, error: e.message };
    // Optimista (el realtime también lo traerá, pero la asesora ya lo ve al instante).
    setNotes(prev => [data as NoteRow, ...prev]);
    return { ok: true as const, note: data as NoteRow };
  }, [user, activeStoreId, orderId, phone]);

  const updateNote = useCallback(async (
    id: string,
    patch: { note_text?: string; remind_at?: string | null },
  ) => {
    if (!user) return { ok: false as const, error: 'sin usuario' };
    const { error: e } = await supabase.from('notes').update(patch).eq('id', id);
    if (e) return { ok: false as const, error: e.message };
    setNotes(prev => prev.map(n => n.id === id ? { ...n, ...patch } as NoteRow : n));
    return { ok: true as const };
  }, [user]);

  const deleteNote = useCallback(async (id: string) => {
    if (!user) return { ok: false as const, error: 'sin usuario' };
    const { error: e } = await supabase.from('notes').delete().eq('id', id);
    if (e) return { ok: false as const, error: e.message };
    setNotes(prev => prev.filter(n => n.id !== id));
    return { ok: true as const };
  }, [user]);

  return { notes, isLoading, error, addNote, updateNote, deleteNote, reload: load };
}

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { SupabaseClient } from '@supabase/supabase-js';

// wa_quick_replies es nueva y aún no está en los tipos generados → cast sin `any`
// (mismo patrón que useWaConversations / WaBotConfigPanel).
const sb = supabase as unknown as SupabaseClient;

export interface WaQuickReply {
  id: string;
  store_id: string;
  label: string;
  body: string;
  sort_order: number;
}

const COLS = 'id, store_id, label, body, sort_order';

/**
 * Respuestas rápidas (canned responses) de la tienda activa. LECTURA para
 * cualquier miembro (las operadoras las usan en el composer del inbox); ESCRITURA
 * solo managers vía RPC (upsert_wa_quick_reply / delete_wa_quick_reply). Ver
 * migración 20260626170000_wa_quick_replies.sql.
 */
export function useWaQuickReplies(storeId: string | null | undefined) {
  const [items, setItems] = useState<WaQuickReply[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!storeId) { setItems([]); return; }
    setLoading(true);
    const { data } = await sb
      .from('wa_quick_replies')
      .select(COLS)
      .eq('store_id', storeId)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    setItems((data as WaQuickReply[]) ?? []);
    setLoading(false);
  }, [storeId]);

  useEffect(() => { void load(); }, [load]);

  /** Crear (sin id) o actualizar (con id). Manager-only en el server. */
  const save = useCallback(async (args: { id?: string; label: string; body: string; sortOrder?: number }) => {
    if (!storeId) return { ok: false, error: 'Sin tienda activa' };
    type RpcRes = { error: { message: string } | null };
    const { error } = await (supabase.rpc as unknown as (fn: string, a: Record<string, unknown>) => Promise<RpcRes>)(
      'upsert_wa_quick_reply',
      { p_store_id: storeId, p_label: args.label, p_body: args.body, p_id: args.id ?? null, p_sort_order: args.sortOrder ?? 0 },
    );
    if (error) return { ok: false, error: error.message };
    await load();
    return { ok: true };
  }, [storeId, load]);

  /** Borrar. Manager-only en el server. */
  const remove = useCallback(async (id: string) => {
    type RpcRes = { error: { message: string } | null };
    const { error } = await (supabase.rpc as unknown as (fn: string, a: Record<string, unknown>) => Promise<RpcRes>)(
      'delete_wa_quick_reply', { p_id: id },
    );
    if (error) return { ok: false, error: error.message };
    await load();
    return { ok: true };
  }, [load]);

  return { items, loading, reload: load, save, remove };
}

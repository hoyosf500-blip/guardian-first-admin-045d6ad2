import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { SupabaseClient } from '@supabase/supabase-js';

// Las tablas wa_* son nuevas y todavía no están en los tipos generados
// (src/integrations/supabase/types.ts es auto-generado). Casteamos a un
// SupabaseClient sin genérico para poder consultarlas sin error de tipos y
// SIN usar `any` explícito (que es error de lint en este repo). Cuando se
// regeneren los tipos, esto sigue funcionando.
const sb = supabase as unknown as SupabaseClient;

export interface WaConversation {
  id: string;
  store_id: string;
  customer_phone: string;
  customer_name: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  last_direction: string | null;
  unread_count: number;
  ai_enabled: boolean;
  ai_state: string;
  status: string;
  assigned_operator_id: string | null;
  linked_external_id: string | null;
}

const COLS =
  'id, store_id, customer_phone, customer_name, last_message_at, last_message_preview, last_direction, unread_count, ai_enabled, ai_state, status, assigned_operator_id, linked_external_id';

/**
 * Conversaciones de WhatsApp de la tienda activa, ordenadas por último mensaje.
 * Realtime sobre wa_conversations (filtrado por store_id) refresca la lista sin
 * recargar — mismo patrón que useRealtimeOrders. Un null storeId = no fetch.
 */
export function useWaConversations(storeId: string | null | undefined) {
  const [conversations, setConversations] = useState<WaConversation[]>([]);
  const [loading, setLoading] = useState(false);
  const loadedOnceRef = useRef(false);

  const load = useCallback(async () => {
    if (!storeId) return;
    if (!loadedOnceRef.current) setLoading(true);
    const { data } = await sb
      .from('wa_conversations')
      .select(COLS)
      .eq('store_id', storeId)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(200);
    setConversations((data as WaConversation[]) ?? []);
    loadedOnceRef.current = true;
    setLoading(false);
  }, [storeId]);

  useEffect(() => {
    loadedOnceRef.current = false;
    load();
  }, [load]);

  useEffect(() => {
    if (!storeId) return;
    let cancelled = false;
    let channel: ReturnType<typeof sb.channel> | null = null;
    (async () => {
      const { data: { session } } = await sb.auth.getSession();
      if (cancelled) return;
      if (session?.access_token) await sb.realtime.setAuth(session.access_token);
      channel = sb
        .channel(`wa-conv-${storeId}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'wa_conversations', filter: `store_id=eq.${storeId}` },
          () => { load(); },
        )
        .subscribe();
    })();
    return () => { cancelled = true; if (channel) void sb.removeChannel(channel); };
  }, [storeId, load]);

  /** Marca la conversación como leída (unread_count = 0). RLS de miembro permite el UPDATE. */
  const markRead = useCallback(async (conversationId: string) => {
    setConversations((prev) =>
      prev.map((c) => (c.id === conversationId ? { ...c, unread_count: 0 } : c)));
    await sb.from('wa_conversations').update({ unread_count: 0 }).eq('id', conversationId);
  }, []);

  /** Enciende/apaga la IA autónoma para un hilo (kill switch por conversación). */
  const setAiEnabled = useCallback(async (conversationId: string, enabled: boolean) => {
    setConversations((prev) =>
      prev.map((c) => (c.id === conversationId
        ? { ...c, ai_enabled: enabled, ai_state: enabled ? 'auto' : c.ai_state }
        : c)));
    const patch: Record<string, unknown> = { ai_enabled: enabled };
    if (enabled) patch.ai_state = 'auto'; // re-activar tras un handoff
    await sb.from('wa_conversations').update(patch).eq('id', conversationId);
  }, []);

  /** Cambia el estado del hilo (open=Abierta · snoozed=Pendiente · closed=Resuelta).
   *  RLS de miembro permite el UPDATE; realtime sincroniza a las demás asesoras. */
  const setStatus = useCallback(async (conversationId: string, status: 'open' | 'snoozed' | 'closed') => {
    setConversations((prev) => prev.map((c) => (c.id === conversationId ? { ...c, status } : c)));
    await sb.from('wa_conversations').update({ status }).eq('id', conversationId);
  }, []);

  /** Asigna (o libera con null) el hilo a una asesora — evita que dos respondan lo
   *  mismo. assigned_operator_id existe en el schema; RLS de miembro permite el UPDATE. */
  const setAssigned = useCallback(async (conversationId: string, operatorId: string | null) => {
    setConversations((prev) => prev.map((c) => (c.id === conversationId ? { ...c, assigned_operator_id: operatorId } : c)));
    await sb.from('wa_conversations').update({ assigned_operator_id: operatorId }).eq('id', conversationId);
  }, []);

  const totalUnread = conversations.reduce((s, c) => s + (Number(c.unread_count) || 0), 0);

  return { conversations, loading, reload: load, markRead, setAiEnabled, setStatus, setAssigned, totalUnread };
}

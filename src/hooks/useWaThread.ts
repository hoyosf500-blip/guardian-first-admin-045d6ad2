import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { SupabaseClient } from '@supabase/supabase-js';
import { toast } from 'sonner';

// Ver nota en useWaConversations.ts sobre el cast (tablas wa_* aún no tipadas).
const sb = supabase as unknown as SupabaseClient;

export interface WaMessage {
  id: string;
  direction: string; // 'in' | 'out'
  sender: string; // 'customer' | 'ai' | 'operator' | 'system'
  body: string | null;
  status: string;
  ai_generated: boolean;
  created_at: string;
}

const COLS = 'id, direction, sender, body, status, ai_generated, created_at';

/**
 * Mensajes de UN hilo + envío manual (operadora). Realtime sobre wa_messages
 * filtrado por conversation_id pinta los entrantes y las respuestas de la IA en
 * vivo. El envío va por la edge function wa-send (que registra + escribe el
 * touchpoint de cobertura).
 */
export function useWaThread(conversationId: string | null, storeId: string | null | undefined, phone?: string | null) {
  const [messages, setMessages] = useState<WaMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    if (!conversationId) { setMessages([]); return; }
    setLoading(true);
    const { data } = await sb
      .from('wa_messages')
      .select(COLS)
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(500);
    setMessages((data as WaMessage[]) ?? []);
    setLoading(false);
  }, [conversationId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    let channel: ReturnType<typeof sb.channel> | null = null;
    (async () => {
      const { data: { session } } = await sb.auth.getSession();
      if (cancelled) return;
      if (session?.access_token) await sb.realtime.setAuth(session.access_token);
      channel = sb
        .channel(`wa-thread-${conversationId}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'wa_messages', filter: `conversation_id=eq.${conversationId}` },
          () => { load(); },
        )
        .subscribe();
    })();
    return () => { cancelled = true; if (channel) void sb.removeChannel(channel); };
  }, [conversationId, load]);

  const send = useCallback(async (text: string): Promise<boolean> => {
    const body = text.trim();
    if (!storeId || !body) return false;
    // Chat existente → por conversation_id. Chat NUEVO (sin conversación todavía)
    // → por teléfono: wa-send crea la conversación del lado servidor y envía. Así
    // la operadora inicia el chat desde el CRM sin abrir WhatsApp externo.
    if (!conversationId && !phone) return false;
    setSending(true);
    try {
      const sendBody = conversationId
        ? { store_id: storeId, conversation_id: conversationId, body }
        : { store_id: storeId, to: phone, body };
      const { data, error } = await supabase.functions.invoke('wa-send', { body: sendBody });
      if (error) { toast.error(`No se pudo enviar: ${error.message}`); return false; }
      const r = data as { ok?: boolean; error?: string };
      if (!r?.ok) { toast.error(r?.error || 'No se pudo enviar'); return false; }
      if (conversationId) await load();
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error al enviar');
      return false;
    } finally {
      setSending(false);
    }
  }, [conversationId, storeId, phone, load]);

  return { messages, loading, sending, send, reload: load };
}

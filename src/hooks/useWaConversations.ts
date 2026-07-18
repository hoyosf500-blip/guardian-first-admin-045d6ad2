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
  const [isError, setIsError] = useState(false);
  // null = no pudimos contar (la consulta falló). NO es "0 sin leer": un cero
  // inventado esconde el badge y se lee como "no hay nadie esperando".
  const [totalUnread, setTotalUnread] = useState<number | null>(0);
  const loadedOnceRef = useRef(false);
  // Espejo de `conversations` para descontar del contador al marcar leído sin
  // depender del estado dentro del updater.
  const conversationsRef = useRef<WaConversation[]>([]);

  /**
   * Única puerta para mutar la lista: calcula el próximo estado desde el ESPEJO
   * y lo deja sincronizado EN EL MISMO TICK que el estado de React.
   *
   * Por qué no un updater `setConversations(prev => ...)`: el updater corre
   * diferido, así que el espejo quedaría escrito DESPUÉS de que el código que
   * sigue ya lo leyó. Dos markRead de la misma conversación dentro del mismo
   * tick leerían ambos `unread_count = 3` y el badge se descontaría 6 — es
   * decir, mostraría MENOS clientes esperando de los que hay, que es
   * exactamente lo que este contador vino a arreglar.
   */
  const applyConversations = useCallback(
    (fn: (prev: WaConversation[]) => WaConversation[]) => {
      const next = fn(conversationsRef.current);
      conversationsRef.current = next;
      setConversations(next);
    },
    [],
  );

  const load = useCallback(async () => {
    if (!storeId) return;
    if (!loadedOnceRef.current) setLoading(true);
    // La LISTA se pagina a 200 (lo que se ve en el panel), pero el contador de
    // no leídos NO puede salir de esa página: una conversación sin responder
    // que quedó bajo el puesto 200 no se sumaría y el badge mostraría menos
    // mensajes de los que hay (o ninguno). Se cuenta aparte, sobre TODAS las
    // conversaciones de la tienda con unread_count > 0.
    const [listRes, unreadRes] = await Promise.all([
      sb
        .from('wa_conversations')
        .select(COLS)
        .eq('store_id', storeId)
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .limit(200),
      sb
        .from('wa_conversations')
        .select('unread_count')
        .eq('store_id', storeId)
        .gt('unread_count', 0),
    ]);

    const rows = (listRes.data as WaConversation[]) ?? [];
    applyConversations(() => rows);
    setIsError(Boolean(listRes.error || unreadRes.error));
    setTotalUnread(
      unreadRes.error
        ? null
        : ((unreadRes.data as { unread_count: number }[]) ?? []).reduce(
            (s, c) => s + (Number(c.unread_count) || 0),
            0,
          ),
    );
    loadedOnceRef.current = true;
    setLoading(false);
  }, [storeId, applyConversations]);

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
    const leidos = Number(
      conversationsRef.current.find((c) => c.id === conversationId)?.unread_count,
    ) || 0;
    // Deja el espejo en 0 YA: si vuelve a entrar por esta conversación antes de
    // que React re-renderice, `leidos` da 0 y no se descuenta dos veces.
    applyConversations((prev) =>
      prev.map((c) => (c.id === conversationId ? { ...c, unread_count: 0 } : c)));
    // El contador ya no se deriva de la lista (se cuenta aparte, sin el tope de
    // 200) → hay que descontarlo acá para que el badge baje al instante, como
    // hacía antes. Si el contador es null (falló la consulta) se queda null: no
    // inventamos un número a partir de un dato que no pudimos leer.
    if (leidos > 0) {
      setTotalUnread((t) => (t === null ? t : Math.max(t - leidos, 0)));
    }
    await sb.from('wa_conversations').update({ unread_count: 0 }).eq('id', conversationId);
  }, [applyConversations]);

  /** Enciende/apaga la IA autónoma para un hilo (kill switch por conversación). */
  const setAiEnabled = useCallback(async (conversationId: string, enabled: boolean) => {
    applyConversations((prev) =>
      prev.map((c) => (c.id === conversationId
        ? { ...c, ai_enabled: enabled, ai_state: enabled ? 'auto' : c.ai_state }
        : c)));
    const patch: Record<string, unknown> = { ai_enabled: enabled };
    if (enabled) patch.ai_state = 'auto'; // re-activar tras un handoff
    await sb.from('wa_conversations').update(patch).eq('id', conversationId);
  }, [applyConversations]);

  /** Cambia el estado del hilo (open=Abierta · snoozed=Pendiente · closed=Resuelta).
   *  RLS de miembro permite el UPDATE; realtime sincroniza a las demás asesoras. */
  const setStatus = useCallback(async (conversationId: string, status: 'open' | 'snoozed' | 'closed') => {
    applyConversations((prev) => prev.map((c) => (c.id === conversationId ? { ...c, status } : c)));
    await sb.from('wa_conversations').update({ status }).eq('id', conversationId);
  }, [applyConversations]);

  /** Asigna (o libera con null) el hilo a una asesora — evita que dos respondan lo
   *  mismo. assigned_operator_id existe en el schema; RLS de miembro permite el UPDATE. */
  const setAssigned = useCallback(async (conversationId: string, operatorId: string | null) => {
    applyConversations((prev) => prev.map((c) => (c.id === conversationId ? { ...c, assigned_operator_id: operatorId } : c)));
    await sb.from('wa_conversations').update({ assigned_operator_id: operatorId }).eq('id', conversationId);
  }, [applyConversations]);

  return {
    conversations,
    loading,
    // true = la consulta falló. La lista vacía / el contador en null NO
    // significan "no hay conversaciones", significan "no pudimos leer".
    isError,
    reload: load,
    markRead,
    setAiEnabled,
    setStatus,
    setAssigned,
    /** Mensajes sin leer de TODA la tienda (no solo de la página de 200).
     *  null = no se pudo contar; no mostrar 0 en ese caso. */
    totalUnread,
  };
}

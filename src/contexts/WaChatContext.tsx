import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { SupabaseClient } from '@supabase/supabase-js';
import { useStore } from '@/contexts/StoreContext';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import WaThreadView from '@/components/seguimiento/WaThread';
import type { WaConversation } from '@/hooks/useWaConversations';

// Ver nota en useWaConversations.ts sobre el cast (tablas wa_* aún no tipadas).
const sb = supabase as unknown as SupabaseClient;

const CONV_COLS =
  'id, store_id, customer_phone, customer_name, last_message_at, last_message_preview, last_direction, unread_count, ai_enabled, ai_state, status, linked_external_id';

export type OpenChatMode = 'thread' | 'wa' | 'none';

interface OpenChatArgs {
  /** Teléfono del cliente (cualquier formato; se normaliza a dígitos). */
  phone: string | null | undefined;
  /** URL wa.me a la que caer si NO existe conversación in-app (cliente nunca escribió al negocio). */
  fallbackWaUrl?: string;
}

interface WaChatContextValue {
  /**
   * Abre el hilo in-app del cliente (ves lo que responde la IA y escribís desde
   * el número del negocio) si existe una conversación para ese teléfono en la
   * tienda activa. Si no existe, abre `fallbackWaUrl` (wa.me). Devuelve el modo
   * resuelto para que el caller registre la comunicación solo cuando corresponde.
   */
  openChat: (args: OpenChatArgs) => Promise<OpenChatMode>;
}

const WaChatContext = createContext<WaChatContextValue | null>(null);

export function useWaChat(): WaChatContextValue {
  const ctx = useContext(WaChatContext);
  if (!ctx) throw new Error('useWaChat debe usarse dentro de <WaChatProvider>');
  return ctx;
}

/**
 * Lanzador GLOBAL del chat de WhatsApp in-app. Montado una vez en ProtectedLayout
 * (sobre el Outlet) → cualquier pantalla (detalle de pedido, tarjeta del tablero)
 * puede abrir el hilo del bot con `useWaChat().openChat(...)` sin montar su propio
 * Sheet ni duplicar lógica. Reusa WaThreadView (el mismo hilo del inbox).
 *
 * Resolución por teléfono: match por los últimos 8 dígitos (robusto a prefijos de
 * país CO 57 / EC 593), igual criterio que findLinkedExternalId del backend.
 */
export function WaChatProvider({ children }: { children: ReactNode }) {
  const { activeStoreId } = useStore();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<WaConversation | null>(null);

  const openChat = useCallback(async ({ phone, fallbackWaUrl }: OpenChatArgs): Promise<OpenChatMode> => {
    const goFallback = (): OpenChatMode => {
      if (fallbackWaUrl) {
        window.open(fallbackWaUrl, '_blank', 'noopener,noreferrer');
        return 'wa';
      }
      return 'none';
    };

    const digits = String(phone || '').replace(/[^0-9]/g, '');
    const last8 = digits.slice(-8);
    if (!activeStoreId || last8.length < 7) return goFallback();

    const { data, error } = await sb
      .from('wa_conversations')
      .select(CONV_COLS)
      .eq('store_id', activeStoreId)
      .ilike('customer_phone', `%${last8}%`)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) return goFallback();

    const conv = data as WaConversation;
    setSelected(conv);
    setOpen(true);
    if (conv.unread_count > 0) {
      void sb.from('wa_conversations').update({ unread_count: 0 }).eq('id', conv.id);
    }
    return 'thread';
  }, [activeStoreId]);

  const value = useMemo<WaChatContextValue>(() => ({ openChat }), [openChat]);

  return (
    <WaChatContext.Provider value={value}>
      {children}
      <Sheet open={open} onOpenChange={(o) => { setOpen(o); if (!o) setSelected(null); }}>
        <SheetContent side="right" className="w-full sm:max-w-xl p-0 flex flex-col gap-0">
          <SheetTitle className="sr-only">Conversación de WhatsApp</SheetTitle>
          {selected && (
            <WaThreadView
              key={selected.id}
              conversation={selected}
              storeId={activeStoreId}
              onBack={() => setOpen(false)}
              onToggleAi={(enabled) => {
                setSelected((prev) => (prev
                  ? { ...prev, ai_enabled: enabled, ai_state: enabled ? 'auto' : prev.ai_state }
                  : prev));
                const patch: Record<string, unknown> = { ai_enabled: enabled };
                if (enabled) patch.ai_state = 'auto'; // re-activar tras un handoff
                void sb.from('wa_conversations').update(patch).eq('id', selected.id);
              }}
            />
          )}
        </SheetContent>
      </Sheet>
    </WaChatContext.Provider>
  );
}

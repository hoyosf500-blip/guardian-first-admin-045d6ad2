import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { SupabaseClient } from '@supabase/supabase-js';
import { useStore } from '@/contexts/StoreContext';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import WaThreadView from '@/components/seguimiento/WaThread';
import type { WaConversation } from '@/hooks/useWaConversations';
import { getWhatsAppPhone } from '@/lib/orderUtils';

// Ver nota en useWaConversations.ts sobre el cast (tablas wa_* aún no tipadas).
const sb = supabase as unknown as SupabaseClient;

const CONV_COLS =
  'id, store_id, customer_phone, customer_name, last_message_at, last_message_preview, last_direction, unread_count, ai_enabled, ai_state, status, linked_external_id';

export type OpenChatMode = 'thread' | 'none';

interface OpenChatArgs {
  /** Teléfono del cliente (cualquier formato; se normaliza a dígitos). */
  phone: string | null | undefined;
  /** Nombre del cliente, para el encabezado del chat nuevo (opcional). */
  name?: string | null;
}

interface WaChatContextValue {
  /**
   * Abre el chat de WhatsApp del cliente SIEMPRE adentro del CRM (estilo Chatea
   * Pro) — NUNCA abre WhatsApp externo (wa.me). Si ya existe una conversación
   * para ese teléfono en la tienda activa, abre ese hilo (historial + IA); si no,
   * abre un hilo NUEVO y la operadora escribe el primer mensaje (wa-send crea la
   * conversación y envía por el número del negocio). Devuelve 'thread' si abrió el
   * panel, 'none' si faltaba teléfono, tienda, o la tienda no tiene WhatsApp.
   */
  openChat: (args: OpenChatArgs) => Promise<OpenChatMode>;
  /**
   * true SOLO si la tienda activa tiene un canal de WhatsApp configurado (con
   * número). Los botones de WhatsApp deben ocultarse cuando es false — ej.
   * Ecuador, mientras no se cargue su número. Se auto-habilita en cuanto se
   * configure el canal (vía RPC get_wa_channel_status), sin tocar código.
   */
  waEnabled: boolean;
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
  const { activeStoreId, activeStore } = useStore();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<WaConversation | null>(null);
  // ¿La tienda activa tiene WhatsApp configurado? Arranca en false y se confirma
  // por RPC al resolver la tienda. Default false = seguro: NO mostramos el botón
  // hasta saber que hay canal (evita abrir un chat que no puede enviar, ej. EC
  // sin número). get_wa_channel_status es member-safe (SECURITY DEFINER); RLS
  // directo sobre wa_channels es owner-only, por eso va por RPC.
  const [waEnabled, setWaEnabled] = useState(false);

  useEffect(() => {
    if (!activeStoreId) { setWaEnabled(false); return; }
    let cancelled = false;
    void (async () => {
      const { data, error } = await sb.rpc('get_wa_channel_status', { p_store_id: activeStoreId });
      if (cancelled) return;
      // Habilitado solo si hay al menos un canal con número cargado.
      const rows = (Array.isArray(data) ? data : []) as Array<{ phone_number?: string | null }>;
      setWaEnabled(!error && rows.some((r) => !!r.phone_number));
    })();
    return () => { cancelled = true; };
  }, [activeStoreId]);

  // Resuelve la conversación de un teléfono en la tienda activa (match últimos 8
  // dígitos, robusto a prefijo país CO 57 / EC 593). Devuelve la fila o null.
  const findByPhone = useCallback(async (phone: string | null | undefined): Promise<WaConversation | null> => {
    const last8 = String(phone || '').replace(/[^0-9]/g, '').slice(-8);
    if (!activeStoreId || last8.length < 7) return null;
    const { data, error } = await sb
      .from('wa_conversations')
      .select(CONV_COLS)
      .eq('store_id', activeStoreId)
      .ilike('customer_phone', `%${last8}%`)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    return (error || !data) ? null : (data as WaConversation);
  }, [activeStoreId]);

  const openChat = useCallback(async ({ phone, name }: OpenChatArgs): Promise<OpenChatMode> => {
    const digits = String(phone || '').replace(/[^0-9]/g, '');
    if (!activeStoreId || digits.length < 7) return 'none';
    // Defensa: si la tienda no tiene WhatsApp configurado, no abrimos nada (los
    // botones ya se ocultan con waEnabled; esto cubre llamadas programáticas).
    if (!waEnabled) return 'none';

    const existing = await findByPhone(digits);
    if (existing) {
      setSelected(existing);
      setOpen(true);
      if (existing.unread_count > 0) {
        void sb.from('wa_conversations').update({ unread_count: 0 }).eq('id', existing.id);
      }
      return 'thread';
    }

    // No hay conversación todavía → abrimos un hilo NUEVO in-app (sintético, id
    // vacío). El primer envío (wa-send por teléfono) crea la conversación real.
    //
    // CRÍTICO: el teléfono se guarda en formato internacional (57/593 + dígitos),
    // el MISMO que usa el webhook de entrada (onlyDigits del JID de WhatsApp). Si
    // guardáramos los dígitos pelados de Dropi (sin código de país), al responder
    // el cliente el webhook NO matchearía y crearía una conversación DUPLICADA
    // (historial partido), y además Whapi puede no entregar a un número sin país.
    // getWhatsAppPhone es idempotente (no duplica el prefijo si ya viene).
    //
    // ai_enabled:false para igualar el default de la tabla (chats iniciados por la
    // operadora son human-led) → el badge no miente diciendo "IA ON".
    setSelected({
      id: '',
      store_id: activeStoreId,
      customer_phone: getWhatsAppPhone(digits, activeStore?.country_code),
      customer_name: name ?? null,
      last_message_at: null,
      last_message_preview: null,
      last_direction: null,
      unread_count: 0,
      ai_enabled: false,
      ai_state: 'auto',
      status: 'open',
      linked_external_id: null,
    });
    setOpen(true);
    return 'thread';
  }, [activeStoreId, activeStore?.country_code, findByPhone, waEnabled]);

  // Tras enviar el 1er mensaje de un chat nuevo, wa-send ya creó la conversación
  // → la cargamos por teléfono y reemplazamos el hilo sintético por el real (así
  // arranca el realtime y los próximos mensajes van por conversation_id).
  const resolveByPhone = useCallback(async (phone: string) => {
    const real = await findByPhone(phone);
    if (real) setSelected(real);
  }, [findByPhone]);

  const value = useMemo<WaChatContextValue>(() => ({ openChat, waEnabled }), [openChat, waEnabled]);

  return (
    <WaChatContext.Provider value={value}>
      {children}
      <Sheet open={open} onOpenChange={(o) => { setOpen(o); if (!o) setSelected(null); }}>
        <SheetContent side="right" className="w-full sm:max-w-xl p-0 flex flex-col gap-0">
          <SheetTitle className="sr-only">Conversación de WhatsApp</SheetTitle>
          {selected && (
            <WaThreadView
              key={selected.id || selected.customer_phone}
              conversation={selected}
              storeId={activeStoreId}
              onBack={() => setOpen(false)}
              onSent={() => void resolveByPhone(selected.customer_phone)}
              onToggleAi={(enabled) => {
                // Sin conversación real todavía (chat nuevo, id='') no hay fila que
                // actualizar — un UPDATE con id='' rompe (uuid inválido). El toggle
                // del hilo nuevo está deshabilitado en la UI; esto es defensa extra.
                if (!selected.id) return;
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

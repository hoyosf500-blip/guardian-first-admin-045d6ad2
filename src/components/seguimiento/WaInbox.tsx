import { useMemo, useState } from 'react';
import { Bot, MessageCircle, User } from 'lucide-react';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { useWaConversations, type WaConversation } from '@/hooks/useWaConversations';
import WaThreadView, { waTimeLabel } from './WaThread';

interface WaInboxProps {
  storeId: string | null | undefined;
}

/**
 * Bandeja de WhatsApp estilo KOMMO, montada DENTRO de /seguimiento (sin ruta
 * nueva → no toca App.tsx). Master-detail en un Sheet: lista de conversaciones
 * → hilo con mensajes en vivo (realtime), composer y kill-switch de la IA.
 * Cruza con el pedido por teléfono (linked_external_id) → link a /pedido/:id.
 *
 * El hilo (WaThreadView) está extraído a ./WaThread y se reusa desde el lanzador
 * global (WaChatContext) — así el botón WhatsApp del detalle/tarjeta abre el mismo
 * hilo del bot.
 */
export default function WaInbox({ storeId }: WaInboxProps) {
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { conversations, totalUnread, markRead, setAiEnabled } = useWaConversations(storeId);

  const selected = useMemo(
    () => conversations.find((c) => c.id === selectedId) ?? null,
    [conversations, selectedId],
  );

  const openConversation = (c: WaConversation) => {
    setSelectedId(c.id);
    if (c.unread_count > 0) markRead(c.id);
  };

  return (
    <Sheet open={open} onOpenChange={(o) => { setOpen(o); if (!o) setSelectedId(null); }}>
      <SheetTrigger asChild>
        <button
          type="button"
          className="relative inline-flex items-center gap-2 rounded-lg border border-transparent bg-[#25D366] px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-[#1da851] transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-[#25D366]/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:outline-none"
        >
          <MessageCircle size={15} className="text-white" aria-hidden="true" />
          <span className="hidden sm:inline">WhatsApp</span>
          {totalUnread > 0 && (
            <span className="ml-0.5 inline-flex min-w-[18px] h-[18px] items-center justify-center rounded-full bg-white px-1 text-[10px] font-bold text-[#128C7E] tabular-nums">
              {totalUnread > 99 ? '99+' : totalUnread}
            </span>
          )}
        </button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full sm:max-w-xl p-0 flex flex-col gap-0">
        {!selected ? (
          <ConversationList conversations={conversations} onSelect={openConversation} />
        ) : (
          <WaThreadView
            key={selected.id}
            conversation={selected}
            storeId={storeId}
            onBack={() => setSelectedId(null)}
            onToggleAi={(en) => setAiEnabled(selected.id, en)}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function ConversationList({
  conversations,
  onSelect,
}: {
  conversations: WaConversation[];
  onSelect: (c: WaConversation) => void;
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border shrink-0">
        <h2 className="text-sm font-bold text-foreground flex items-center gap-2">
          <MessageCircle size={16} className="text-accent" aria-hidden="true" />
          Conversaciones
        </h2>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          WhatsApp en vivo — la IA responde sola los hilos activados.
        </p>
      </div>
      <div className="flex-1 overflow-y-auto">
        {conversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 px-6 text-center gap-2">
            <MessageCircle size={28} className="text-muted-foreground" aria-hidden="true" />
            <p className="text-sm font-semibold text-foreground">Sin conversaciones todavía</p>
            <p className="text-xs text-muted-foreground">
              Cuando un cliente escriba al WhatsApp conectado, su hilo aparece acá.
            </p>
          </div>
        ) : (
          conversations.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onSelect(c)}
              className="w-full text-left px-4 py-3 border-b border-border/60 hover:bg-muted/30 transition-colors focus-visible:outline-none focus-visible:bg-muted/40"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-foreground truncate">
                  {c.customer_name || c.customer_phone}
                </span>
                <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                  {waTimeLabel(c.last_message_at)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2 mt-0.5">
                <span className="text-xs text-muted-foreground truncate">
                  {c.last_direction === 'out' ? 'Tú: ' : ''}{c.last_message_preview || '—'}
                </span>
                <span className="flex items-center gap-1 shrink-0">
                  {c.ai_state === 'handed_off' ? (
                    <span className="inline-flex items-center gap-0.5 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-warning/15 text-warning border border-warning/30">
                      <User size={9} /> Humano
                    </span>
                  ) : c.ai_enabled ? (
                    <span className="inline-flex items-center gap-0.5 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-accent/15 text-accent border border-accent/30">
                      <Bot size={9} /> IA
                    </span>
                  ) : null}
                  {c.unread_count > 0 && (
                    <span className="inline-flex min-w-[18px] h-[18px] items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-white tabular-nums">
                      {c.unread_count}
                    </span>
                  )}
                </span>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

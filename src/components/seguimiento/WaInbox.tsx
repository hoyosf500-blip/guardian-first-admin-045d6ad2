import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Bot, ExternalLink, MessageCircle, Send, User } from 'lucide-react';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useWaConversations, type WaConversation } from '@/hooks/useWaConversations';
import { useWaThread } from '@/hooks/useWaThread';

interface WaInboxProps {
  storeId: string | null | undefined;
}

function timeLabel(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Bandeja de WhatsApp estilo KOMMO, montada DENTRO de /seguimiento (sin ruta
 * nueva → no toca App.tsx). Master-detail en un Sheet: lista de conversaciones
 * → hilo con mensajes en vivo (realtime), composer y kill-switch de la IA.
 * Cruza con el pedido por teléfono (linked_external_id) → link a /pedido/:id.
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
          <ThreadView
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
                  {timeLabel(c.last_message_at)}
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

function ThreadView({
  conversation,
  storeId,
  onBack,
  onToggleAi,
}: {
  conversation: WaConversation;
  storeId: string | null | undefined;
  onBack: () => void;
  onToggleAi: (enabled: boolean) => void;
}) {
  const { messages, sending, send } = useWaThread(conversation.id, storeId);
  const [draft, setDraft] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const onSend = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    const ok = await send(text);
    if (ok) setDraft('');
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-3 py-2.5 border-b border-border shrink-0 flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="p-1.5 rounded-md hover:bg-muted/40 text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          aria-label="Volver a la lista"
        >
          <ArrowLeft size={16} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold text-foreground truncate">
            {conversation.customer_name || conversation.customer_phone}
          </div>
          <div className="text-[11px] text-muted-foreground truncate flex items-center gap-2">
            <span className="tabular-nums">{conversation.customer_phone}</span>
            {conversation.linked_external_id && (
              <Link
                to={`/pedido/${conversation.linked_external_id}`}
                className="inline-flex items-center gap-0.5 text-accent hover:underline"
              >
                <ExternalLink size={10} /> Pedido #{conversation.linked_external_id}
              </Link>
            )}
          </div>
        </div>
        {/* Kill switch de la IA */}
        <button
          type="button"
          onClick={() => onToggleAi(!conversation.ai_enabled)}
          aria-pressed={conversation.ai_enabled && conversation.ai_state !== 'handed_off'}
          className={cn(
            'inline-flex items-center gap-1 rounded-lg border px-2 py-1.5 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            conversation.ai_enabled && conversation.ai_state !== 'handed_off'
              ? 'bg-accent/15 text-accent border-accent/40'
              : 'bg-card text-muted-foreground border-border hover:border-border-strong',
          )}
          title={conversation.ai_state === 'handed_off'
            ? 'Derivado a humano — tocá para reactivar la IA'
            : conversation.ai_enabled ? 'IA respondiendo sola — tocá para apagar' : 'IA apagada — tocá para encender'}
        >
          <Bot size={12} />
          {conversation.ai_state === 'handed_off' ? 'Reactivar IA' : conversation.ai_enabled ? 'IA ON' : 'IA OFF'}
        </button>
      </div>

      {conversation.ai_state === 'handed_off' && (
        <div className="px-4 py-1.5 bg-warning/10 border-b border-warning/20 text-[11px] text-warning font-medium flex items-center gap-1.5 shrink-0">
          <User size={12} /> La IA derivó este hilo a un humano. Respondé vos o reactivá la IA.
        </div>
      )}

      {/* Mensajes */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2 bg-muted/10">
        {messages.length === 0 ? (
          <p className="text-center text-xs text-muted-foreground py-8">Sin mensajes en este hilo.</p>
        ) : (
          messages.map((m) => {
            const isOut = m.direction === 'out';
            return (
              <div key={m.id} className={cn('flex', isOut ? 'justify-end' : 'justify-start')}>
                <div
                  className={cn(
                    'max-w-[78%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words',
                    isOut
                      ? 'bg-accent text-accent-foreground rounded-br-sm'
                      : 'bg-card border border-border text-foreground rounded-bl-sm',
                  )}
                >
                  {isOut && (
                    <span className="flex items-center gap-1 text-[9px] font-bold uppercase opacity-70 mb-0.5">
                      {m.sender === 'ai' ? <><Bot size={9} /> IA</> : m.sender === 'operator' ? 'Tú' : 'Sistema'}
                    </span>
                  )}
                  {m.body}
                  <span className={cn('block text-[9px] mt-0.5 tabular-nums', isOut ? 'opacity-70' : 'text-muted-foreground')}>
                    {timeLabel(m.created_at)}{m.status === 'failed' ? ' · falló' : ''}
                  </span>
                </div>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      <div className="border-t border-border p-2.5 shrink-0 flex items-end gap-2">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void onSend();
            }
          }}
          placeholder="Escribí un mensaje… (Enter envía, Shift+Enter salto de línea)"
          rows={1}
          className="min-h-[40px] max-h-32 resize-none text-sm"
        />
        <button
          type="button"
          onClick={() => void onSend()}
          disabled={sending || !draft.trim()}
          className="shrink-0 inline-flex items-center justify-center h-10 w-10 rounded-lg bg-accent text-accent-foreground hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          aria-label="Enviar mensaje"
        >
          <Send size={16} className={sending ? 'animate-pulse' : ''} />
        </button>
      </div>
    </div>
  );
}

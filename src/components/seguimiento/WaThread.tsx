import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Bot, ExternalLink, Send, User } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useWaThread } from '@/hooks/useWaThread';
import type { WaConversation } from '@/hooks/useWaConversations';

/** Hora corta (HH:MM) de un ISO, o '' si no parsea. Compartido por la lista y el hilo. */
export function waTimeLabel(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Vista de UN hilo de WhatsApp: mensajes en vivo (realtime), composer y kill-switch
 * de la IA. Extraído de WaInbox para reusarlo desde el lanzador global (WaChatContext)
 * — así el botón WhatsApp del detalle/tarjeta abre ESTE hilo (ves lo que habla el bot
 * y escribís desde el número del negocio), no wa.me.
 *
 * `onBack`: en el inbox vuelve a la lista; abierto desde un pedido, cierra el panel.
 */
export default function WaThreadView({
  conversation,
  storeId,
  onBack,
  onToggleAi,
  onSent,
}: {
  conversation: WaConversation;
  storeId: string | null | undefined;
  onBack: () => void;
  onToggleAi: (enabled: boolean) => void;
  /** Se llama tras enviar el PRIMER mensaje de un chat nuevo (sin conversación
   *  previa) → el lanzador re-resuelve la conversación recién creada por teléfono. */
  onSent?: () => void;
}) {
  // conversation.id vacío = chat NUEVO (todavía no existe la conversación). En ese
  // caso enviamos por teléfono (wa-send la crea) en vez de por conversation_id.
  const isNew = !conversation.id;
  const { messages, sending, send } = useWaThread(conversation.id || null, storeId, conversation.customer_phone);
  const [draft, setDraft] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const onSend = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    const ok = await send(text);
    if (ok) {
      setDraft('');
      if (isNew) onSent?.(); // el chat se acaba de crear → que el lanzador lo cargue
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-3 py-2.5 border-b border-border shrink-0 flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="p-2 -ml-1 rounded-md hover:bg-muted/40 text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          aria-label="Volver"
        >
          <ArrowLeft size={18} />
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
          disabled={isNew}
          aria-pressed={conversation.ai_enabled && conversation.ai_state !== 'handed_off'}
          className={cn(
            'inline-flex items-center gap-1 rounded-lg border px-2.5 py-2 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 disabled:cursor-not-allowed',
            conversation.ai_enabled && conversation.ai_state !== 'handed_off'
              ? 'bg-accent/15 text-accent border-accent/40'
              : 'bg-card text-muted-foreground border-border hover:border-border-strong',
          )}
          title={isNew
            ? 'La IA se activa una vez exista la conversación (después del primer mensaje)'
            : conversation.ai_state === 'handed_off'
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
          <p className="text-center text-xs text-muted-foreground py-8">
            {isNew
              ? 'Escribile el primer mensaje. Se envía desde el WhatsApp del negocio.'
              : 'Sin mensajes en este hilo.'}
          </p>
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
                    {waTimeLabel(m.created_at)}{m.status === 'failed' ? ' · falló' : ''}
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
          className="min-h-[44px] max-h-32 resize-none text-sm"
        />
        <button
          type="button"
          onClick={() => void onSend()}
          disabled={sending || !draft.trim()}
          className="shrink-0 inline-flex items-center justify-center h-11 w-11 rounded-lg bg-accent text-accent-foreground hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          aria-label="Enviar mensaje"
        >
          <Send size={16} className={sending ? 'animate-pulse' : ''} />
        </button>
      </div>
    </div>
  );
}

import { useMemo, useState } from 'react';
import { Bot, MessageCircle, User, Search, UserCheck } from 'lucide-react';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { useWaConversations, type WaConversation } from '@/hooks/useWaConversations';
import { useAuth } from '@/contexts/AuthContext';
import WaThreadView, { waTimeLabel } from './WaThread';

interface WaInboxProps {
  storeId: string | null | undefined;
}

type StatusFilter = 'all' | 'open' | 'snoozed' | 'closed';

// Tabs estilo wazapp/Kommo. Mapeo al campo `status` de wa_conversations.
const STATUS_TABS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'Todas' },
  { key: 'open', label: 'Abiertas' },
  { key: 'snoozed', label: 'Pendientes' },
  { key: 'closed', label: 'Resueltas' },
];

/**
 * Bandeja de WhatsApp estilo KOMMO, montada DENTRO de /seguimiento (sin ruta
 * nueva → no toca App.tsx). Master-detail en un Sheet: lista de conversaciones
 * → hilo con mensajes en vivo (realtime), composer y kill-switch de la IA.
 * Cruza con el pedido por teléfono (linked_external_id) → link a /pedido/:id.
 *
 * Para equipos de asesoras: tabs por estado (Abiertas/Pendientes/Resueltas),
 * búsqueda, y asignación de hilos (evita que dos respondan lo mismo).
 *
 * El hilo (WaThreadView) está extraído a ./WaThread y se reusa desde el lanzador
 * global (WaChatContext) — así el botón WhatsApp del detalle/tarjeta abre el mismo
 * hilo del bot.
 */
export default function WaInbox({ storeId }: WaInboxProps) {
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const { conversations, totalUnread, markRead, setAiEnabled, setStatus, setAssigned } = useWaConversations(storeId);
  const { user } = useAuth();
  const currentUserId = user?.id ?? null;

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
        {/* Verde oscuro y NO blanco sobre el verde de marca: blanco sobre
            #25D366 da 1.98:1 (falla en los dos temas) y ni el teal oficial
            #075E54 llega. #0b3d2c da 6.16:1 y sigue leyéndose como WhatsApp. */}
        <button
          type="button"
          className="relative inline-flex items-center gap-2 rounded-lg border border-transparent bg-[#25D366] px-3 py-2 text-sm font-semibold text-[#0b3d2c] shadow-sm hover:bg-[#1da851] transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-[#25D366]/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:outline-none"
        >
          <MessageCircle size={15} className="text-[#0b3d2c]" aria-hidden="true" />
          <span className="hidden sm:inline">WhatsApp</span>
          {totalUnread > 0 && (
            <span className="ml-0.5 inline-flex min-w-[18px] h-[18px] items-center justify-center rounded-full bg-white px-1 text-[10px] font-bold text-[#0F7A6E] tabular-nums">
              {totalUnread > 99 ? '99+' : totalUnread}
            </span>
          )}
        </button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full sm:max-w-xl p-0 flex flex-col gap-0">
        {!selected ? (
          <ConversationList
            conversations={conversations}
            onSelect={openConversation}
            currentUserId={currentUserId}
            search={search}
            setSearch={setSearch}
            statusFilter={statusFilter}
            setStatusFilter={setStatusFilter}
          />
        ) : (
          <WaThreadView
            key={selected.id}
            conversation={selected}
            storeId={storeId}
            currentUserId={currentUserId}
            onBack={() => setSelectedId(null)}
            onToggleAi={(en) => setAiEnabled(selected.id, en)}
            onSetStatus={(s) => setStatus(selected.id, s)}
            onSetAssigned={(op) => setAssigned(selected.id, op)}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function ConversationList({
  conversations,
  onSelect,
  currentUserId,
  search,
  setSearch,
  statusFilter,
  setStatusFilter,
}: {
  conversations: WaConversation[];
  onSelect: (c: WaConversation) => void;
  currentUserId: string | null;
  search: string;
  setSearch: (v: string) => void;
  statusFilter: StatusFilter;
  setStatusFilter: (v: StatusFilter) => void;
}) {
  // Conteo por estado para los tabs (un hilo sin status cuenta como 'open').
  const counts = useMemo(() => {
    const c = { all: conversations.length, open: 0, snoozed: 0, closed: 0 } as Record<StatusFilter, number>;
    for (const conv of conversations) {
      const st = (conv.status || 'open') as 'open' | 'snoozed' | 'closed';
      if (st === 'open' || st === 'snoozed' || st === 'closed') c[st]++;
    }
    return c;
  }, [conversations]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return conversations.filter((c) => {
      if (statusFilter !== 'all' && (c.status || 'open') !== statusFilter) return false;
      if (q) {
        const hay = `${c.customer_name || ''} ${c.customer_phone} ${c.last_message_preview || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [conversations, statusFilter, search]);

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border shrink-0 space-y-2.5">
        <div>
          <h2 className="text-sm font-bold text-foreground flex items-center gap-2">
            <MessageCircle size={16} className="text-accent" aria-hidden="true" />
            Conversaciones
          </h2>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            WhatsApp en vivo — la IA responde sola los hilos activados.
          </p>
        </div>
        {/* Búsqueda */}
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nombre, teléfono o mensaje…"
            className="w-full h-9 rounded-lg border border-border bg-background pl-8 pr-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </div>
        {/* Tabs de estado */}
        <div className="flex items-center gap-1">
          {STATUS_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setStatusFilter(t.key)}
              className={`flex-1 text-[11px] font-semibold rounded-md px-2 py-1.5 transition-colors ${
                statusFilter === t.key
                  ? 'bg-accent/15 text-accent border border-accent/30'
                  : 'text-muted-foreground border border-transparent hover:bg-muted/40'
              }`}
            >
              {t.label}<span className="ml-1 tabular-nums opacity-70">{counts[t.key]}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 px-6 text-center gap-2">
            <MessageCircle size={28} className="text-muted-foreground" aria-hidden="true" />
            <p className="text-sm font-semibold text-foreground">
              {conversations.length === 0 ? 'Sin conversaciones todavía' : 'Nada en esta vista'}
            </p>
            <p className="text-xs text-muted-foreground">
              {conversations.length === 0
                ? 'Cuando un cliente escriba al WhatsApp conectado, su hilo aparece acá.'
                : 'Probá con otro estado o limpiá la búsqueda.'}
            </p>
          </div>
        ) : (
          filtered.map((c) => {
            const mine = !!currentUserId && c.assigned_operator_id === currentUserId;
            const assignedToOther = !!c.assigned_operator_id && !mine;
            return (
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
                    {mine && (
                      <span className="inline-flex items-center gap-0.5 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-success/15 text-success border border-success/30">
                        <UserCheck size={9} /> Tú
                      </span>
                    )}
                    {assignedToOther && (
                      <span className="inline-flex items-center gap-0.5 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border">
                        <UserCheck size={9} /> Asignada
                      </span>
                    )}
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
                      <span className="inline-flex min-w-[18px] h-[18px] items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-danger-foreground tabular-nums">
                        {c.unread_count}
                      </span>
                    )}
                  </span>
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

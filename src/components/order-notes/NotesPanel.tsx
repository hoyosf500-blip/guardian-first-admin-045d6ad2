import { useEffect, useMemo, useState } from 'react';
import { MessageSquare, Bell, Send, Trash2 } from 'lucide-react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useOrderNotes } from '@/hooks/useOrderNotes';
import { isReminderDue, summarizeReminder } from '@/lib/reminders';

interface Props {
  /** Phone del cliente. Si se pasa, carga TODAS las notas del cliente (mismo
   *  patrón que OrderDetailPage — continuidad entre pedidos del mismo número). */
  phone?: string | null;
  /** Order id de la fila actual. Cada nueva nota se guarda con este order_id. */
  orderId?: string | null;
  /** Estilo: 'full' (card grande, como OrderDetailPage) o 'compact' (más denso,
   *  para CallView que ya está en un panel). */
  variant?: 'full' | 'compact';
}

/** "hace 5 min", "hace 2 h", "ayer", "hace 3 d". */
function timeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (!t) return '';
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'recién';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'ayer';
  return `hace ${d} d`;
}

/** Convierte un string `<input type=datetime-local>` en ISO UTC. Devuelve null
 *  si está vacío. El input ya está en hora local del navegador; new Date(value)
 *  lo interpreta como local y produce el ISO correcto. */
function datetimeLocalToIso(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export default function NotesPanel({ phone, orderId, variant = 'full' }: Props) {
  const { user } = useAuth();
  const { notes, isLoading, addNote, deleteNote } = useOrderNotes({ phone, orderId });
  const [text, setText] = useState('');
  const [remindAt, setRemindAt] = useState(''); // datetime-local string
  const [submitting, setSubmitting] = useState(false);
  const [profiles, setProfiles] = useState<Record<string, string>>({});

  // Profiles (display_name por operator_id). Una sola carga al montar — la
  // tabla `profiles` es global y chica. Si crece, paginamos.
  useEffect(() => {
    let cancelled = false;
    supabase.from('profiles').select('user_id, display_name').then(({ data }) => {
      if (cancelled || !data) return;
      const m: Record<string, string> = {};
      (data as Array<{ user_id: string; display_name: string }>).forEach(p => {
        m[p.user_id] = p.display_name;
      });
      setProfiles(m);
    });
    return () => { cancelled = true; };
  }, []);

  const canSubmit = text.trim().length > 0 && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    const remindIso = datetimeLocalToIso(remindAt);
    const res = await addNote(text, { remindAt: remindIso });
    setSubmitting(false);
    if (res.ok) {
      setText('');
      setRemindAt('');
      toast.success(remindIso ? 'Nota + recordatorio guardado' : 'Nota guardada');
    } else {
      toast.error('No se pudo guardar: ' + res.error);
    }
  };

  const onTextareaKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sin Shift = guardar; Shift+Enter = nueva línea.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  // Orden visual: notas con recordatorio activo (due o por venir) arriba,
  // luego por created_at desc. El hook ya devuelve por created_at desc.
  const ordered = useMemo(() => {
    const withReminder = notes.filter(n => n.remind_at);
    const without = notes.filter(n => !n.remind_at);
    // Dentro de withReminder, las due primero (más urgentes).
    withReminder.sort((a, b) => {
      const aDue = isReminderDue(a.remind_at!) ? 0 : 1;
      const bDue = isReminderDue(b.remind_at!) ? 0 : 1;
      if (aDue !== bDue) return aDue - bDue;
      // dentro del mismo grupo, por remind_at asc (la más próxima primero)
      return (a.remind_at! < b.remind_at!) ? -1 : 1;
    });
    return [...withReminder, ...without];
  }, [notes]);

  const containerCls = variant === 'compact'
    ? 'bg-card border border-border/50 rounded-lg p-3 space-y-3'
    : 'bg-surface border border-border rounded-xl p-5 space-y-4 hover:border-border-strong transition-colors duration-200';

  return (
    <motion.section
      initial={variant === 'full' ? { opacity: 0, y: 10 } : false}
      animate={variant === 'full' ? { opacity: 1, y: 0 } : undefined}
      transition={{ delay: 0.25 }}
      className={containerCls}
      aria-label="Notas y recordatorios del pedido"
    >
      <h3 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
        <MessageSquare size={13} aria-hidden="true" /> Notas y recordatorios
      </h3>

      {/* Formulario */}
      <div className="space-y-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onTextareaKey}
          placeholder="Ej: el cliente recoge el viernes 3pm; llamar mañana temprano…"
          aria-label="Escribir una nota sobre el pedido"
          rows={2}
          className="w-full bg-card border border-border rounded-lg px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:border-accent/40 hover:border-border-strong transition-colors duration-200 resize-y"
        />
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-[10px] text-muted-foreground flex items-center gap-1.5">
            <Bell size={11} aria-hidden="true" /> Recuérdame el
          </label>
          <input
            type="datetime-local"
            value={remindAt}
            onChange={(e) => setRemindAt(e.target.value)}
            aria-label="Fecha y hora del recordatorio (opcional)"
            className="bg-card border border-border rounded-lg px-2 py-1 text-[11px] text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
          {remindAt && (
            <button
              type="button"
              onClick={() => setRemindAt('')}
              className="text-[10px] text-muted-foreground hover:text-foreground underline underline-offset-2"
              aria-label="Quitar recordatorio"
            >
              quitar
            </button>
          )}
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            aria-label="Guardar nota"
            className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-accent-foreground text-xs font-semibold hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          >
            <Send size={12} aria-hidden="true" /> Agregar
          </button>
        </div>
      </div>

      {/* Lista */}
      <div className="space-y-2 max-h-64 overflow-y-auto">
        {isLoading && notes.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-3">Cargando notas…</p>
        )}
        {!isLoading && notes.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-3">Sin notas todavía</p>
        )}
        {ordered.map((n) => {
          const mine = user?.id === n.operator_id;
          const due = n.remind_at ? isReminderDue(n.remind_at) : false;
          const author = profiles[n.operator_id] || 'Asesora';
          return (
            <div
              key={n.id}
              className={[
                'text-xs rounded-lg px-3 py-2 border',
                due
                  ? 'bg-warning/10 border-warning/40'
                  : 'bg-card border-border/50',
              ].join(' ')}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="font-semibold text-foreground">{author}</span>
                <span className="text-[10px] text-muted-foreground">{timeAgo(n.created_at)}</span>
                {n.remind_at && (
                  <span
                    className={[
                      'ml-auto text-[10px] px-1.5 py-0.5 rounded-md inline-flex items-center gap-1 border',
                      due
                        ? 'bg-warning/20 text-warning border-warning/40'
                        : 'bg-accent/10 text-accent border-accent/30',
                    ].join(' ')}
                    title={due ? 'Recordatorio vencido' : 'Recordatorio programado'}
                  >
                    <Bell size={9} aria-hidden="true" /> {summarizeReminder(n.remind_at)}
                  </span>
                )}
                {mine && (
                  <button
                    type="button"
                    onClick={async () => {
                      const ok = window.confirm('¿Borrar esta nota?');
                      if (!ok) return;
                      const r = await deleteNote(n.id);
                      if (!r.ok) toast.error('No se pudo borrar: ' + r.error);
                    }}
                    aria-label="Borrar nota"
                    className={`${n.remind_at ? '' : 'ml-auto'} text-muted-foreground hover:text-destructive`}
                  >
                    <Trash2 size={11} aria-hidden="true" />
                  </button>
                )}
              </div>
              <p className="text-muted-foreground whitespace-pre-wrap break-words">{n.note_text}</p>
            </div>
          );
        })}
      </div>
    </motion.section>
  );
}

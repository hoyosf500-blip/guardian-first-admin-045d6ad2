import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MessageSquare, Bell, Send, Trash2, CalendarIcon, X } from 'lucide-react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useOrderNotes, type NoteRow } from '@/hooks/useOrderNotes';
import { isReminderDue, summarizeReminder } from '@/lib/reminders';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

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

/** Formato `YYYY-MM-DDTHH:mm` en hora local del navegador (el que pide
 *  `<input type=datetime-local>`). */
const pad2 = (n: number) => String(n).padStart(2, '0');
function toDatetimeLocal(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Atajos rápidos para el recordatorio — para no tener que abrir el calendario
 *  en los casos comunes (90% de las veces es "en 1-3 horas" o "mañana"). El
 *  input manual sigue disponible debajo. */
const QUICK_REMINDERS: Array<{ label: string; build: () => Date }> = [
  { label: 'En 1 h', build: () => new Date(Date.now() + 60 * 60_000) },
  { label: 'En 3 h', build: () => new Date(Date.now() + 3 * 60 * 60_000) },
  {
    label: 'Mañana 9 am',
    build: () => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      return d;
    },
  },
  {
    label: 'Mañana 3 pm',
    build: () => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(15, 0, 0, 0);
      return d;
    },
  },
  {
    label: 'En 2 días',
    build: () => {
      const d = new Date();
      d.setDate(d.getDate() + 2);
      d.setHours(9, 0, 0, 0);
      return d;
    },
  },
];

export default function NotesPanel({ phone, orderId, variant = 'full' }: Props) {
  const { user } = useAuth();
  const { notes, isLoading, addNote, deleteNote } = useOrderNotes({ phone, orderId });
  const [text, setText] = useState('');
  const [remindAt, setRemindAt] = useState(''); // datetime-local string
  const [submitting, setSubmitting] = useState(false);
  const [profiles, setProfiles] = useState<Record<string, string>>({});
  // Nota cuya eliminación se está confirmando. null = sin diálogo abierto.
  // Usamos AlertDialog (shadcn) en vez de window.confirm — está estilizado,
  // es accesible (Radix), no se ve diminuto en iOS y respeta el tema.
  const [noteToDelete, setNoteToDelete] = useState<NoteRow | null>(null);
  // Auto-grow del textarea: ajustamos height al scrollHeight cada vez que
  // cambia el texto, evitando handler manual de resize. Spotify-style.
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`; // tope ~10 líneas
  }, [text]);

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
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onTextareaKey}
          placeholder="Ej: el cliente recoge el viernes 3pm; llamar mañana temprano…"
          aria-label="Escribir una nota sobre el pedido"
          rows={2}
          className="w-full bg-card border border-border rounded-lg px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:border-accent/40 hover:border-border-strong transition-colors duration-200 resize-none overflow-hidden min-h-[3.5rem]"
        />
        {/* Recordatorio: chips rápidos arriba (90% de los casos no abren el
            calendario) + input manual abajo como escape hatch. */}
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground inline-flex items-center gap-1.5 mr-1">
              <Bell size={11} aria-hidden="true" /> Recordatorio
            </span>
            {QUICK_REMINDERS.map(q => (
              <button
                key={q.label}
                type="button"
                aria-label={`Programar recordatorio: ${q.label}`}
                onClick={() => setRemindAt(toDatetimeLocal(q.build()))}
                className="text-xs px-3 min-h-[32px] inline-flex items-center rounded-md border border-transparent bg-muted/40 text-muted-foreground hover:bg-accent/10 hover:text-accent hover:border-accent/30 transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                {q.label}
              </button>
            ))}
          </div>
          {/* Selector de fecha+hora custom: reemplaza al `<input type=datetime-local>`
              (que mostraba `dd/mm/aaaa --:--` y obligaba a escribir en lugar de
              abrir un calendario; el target del ícono de calendario era diminuto).
              Ahora es un Button + Popover — click en CUALQUIER parte del botón
              abre el calendario; abajo del calendario hay un input de hora. */}
          <div className="flex flex-wrap items-center gap-2">
            {(() => {
              const remindDate = remindAt ? new Date(remindAt) : null;
              const displayText = remindDate
                ? format(remindDate, "EEE d MMM · h:mm a", { locale: es })
                : 'Elegir fecha y hora…';
              const timeValue = remindDate
                ? `${pad2(remindDate.getHours())}:${pad2(remindDate.getMinutes())}`
                : '09:00';
              return (
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className={`h-9 gap-1.5 text-xs font-medium rounded-lg cursor-pointer ${remindDate ? 'text-foreground border-accent/40' : 'text-muted-foreground'}`}
                      aria-label={remindDate ? `Recordatorio: ${displayText}. Cambiar.` : 'Elegir fecha y hora del recordatorio'}
                    >
                      <CalendarIcon size={14} aria-hidden="true" />
                      {displayText}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={remindDate ?? undefined}
                      onSelect={(d) => {
                        if (!d) return;
                        const target = new Date(d);
                        // Conserva la hora previa si había, sino 9am default
                        if (remindDate) {
                          target.setHours(remindDate.getHours(), remindDate.getMinutes(), 0, 0);
                        } else {
                          target.setHours(9, 0, 0, 0);
                        }
                        setRemindAt(toDatetimeLocal(target));
                      }}
                      initialFocus
                      className="p-3 pointer-events-auto"
                    />
                    <div className="border-t border-border p-3 flex items-center gap-2">
                      <label htmlFor="reminder-time" className="text-xs text-muted-foreground inline-flex items-center gap-1">
                        <Bell size={11} aria-hidden="true" /> Hora
                      </label>
                      <input
                        id="reminder-time"
                        type="time"
                        value={timeValue}
                        onChange={(e) => {
                          const [h, m] = e.target.value.split(':').map(Number);
                          if (!Number.isFinite(h) || !Number.isFinite(m)) return;
                          const target = remindDate ?? new Date();
                          target.setHours(h, m, 0, 0);
                          setRemindAt(toDatetimeLocal(target));
                        }}
                        className="bg-card border border-border rounded-md px-2 py-1 text-xs text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      />
                      {remindAt && (
                        <button
                          type="button"
                          onClick={() => setRemindAt('')}
                          aria-label="Quitar recordatorio"
                          className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-destructive"
                        >
                          <X size={11} aria-hidden="true" /> Quitar
                        </button>
                      )}
                    </div>
                  </PopoverContent>
                </Popover>
              );
            })()}
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
                    onClick={() => setNoteToDelete(n)}
                    aria-label="Borrar nota"
                    className={`${n.remind_at ? '' : 'ml-auto'} w-9 h-9 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors focus-visible:ring-2 focus-visible:ring-destructive focus-visible:outline-none`}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                )}
              </div>
              <p className="text-muted-foreground whitespace-pre-wrap break-words">{n.note_text}</p>
            </div>
          );
        })}
      </div>

      {/* Diálogo de confirmación de borrado — reemplaza al `window.confirm`
          (que en iOS sale chiquito, sin tema y rompe el flow mobile). */}
      <AlertDialog open={!!noteToDelete} onOpenChange={(open) => { if (!open) setNoteToDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Borrar esta nota?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <p className="text-sm text-muted-foreground">
                  Esta acción no se puede deshacer. La nota desaparecerá para todas las asesoras de la tienda.
                </p>
                {noteToDelete && (
                  <blockquote className="mt-3 max-h-32 overflow-y-auto rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-foreground whitespace-pre-wrap break-words">
                    {noteToDelete.note_text}
                  </blockquote>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (!noteToDelete) return;
                const r = await deleteNote(noteToDelete.id);
                setNoteToDelete(null);
                if (!r.ok) toast.error('No se pudo borrar: ' + r.error);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Borrar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </motion.section>
  );
}

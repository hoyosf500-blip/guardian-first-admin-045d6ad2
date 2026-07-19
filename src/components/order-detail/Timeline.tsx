import { motion } from 'framer-motion';
import {
  Clock,
  Phone,
  MessageSquare,
  Mail,
  FileText,
  CheckCircle2,
  Cloud,
  AlertTriangle,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { formatDistanceToNow, isToday, isYesterday, format } from 'date-fns';
import { es } from 'date-fns/locale';
import { TimelineEvent, TimelineCategory } from '@/lib/timelineBuilder';

interface Props {
  events: TimelineEvent[];
  /** Optional filter to a subset of categories (used by CommunicationLog). */
  allowedCategories?: TimelineCategory[];
  /** Compact mode — no day separators, smaller padding (used inside cards). */
  compact?: boolean;
  /** Empty state text when nothing to show. */
  emptyText?: string;
}

/**
 * Meta por categoría.
 *
 * `chip` sigue la fórmula de tinte del DS (bg/14 · border/30 · text) para el
 * nodo de la línea; `stroke` es el token CRUDO porque el aro y el halo del nodo
 * se dibujan con box-shadow, y un box-shadow por categoría no se puede expresar
 * con clases de Tailwind.
 */
const CATEGORY_META: Record<
  TimelineCategory,
  { icon: LucideIcon; chip: string; stroke: string }
> = {
  dropi:    { icon: Cloud,         chip: 'bg-cyan/14 border-cyan/30 text-cyan',             stroke: 'hsl(var(--cyan))' },
  call:     { icon: Phone,         chip: 'bg-info/14 border-info/30 text-info',             stroke: 'hsl(var(--info))' },
  whatsapp: { icon: MessageSquare, chip: 'bg-success/14 border-success/30 text-success',    stroke: 'hsl(var(--success))' },
  sms:      { icon: Mail,          chip: 'bg-accent/14 border-accent/30 text-accent',       stroke: 'hsl(var(--accent))' },
  note:     { icon: FileText,      chip: 'bg-warning/14 border-warning/30 text-warning',    stroke: 'hsl(var(--warning))' },
  status:   { icon: CheckCircle2,  chip: 'bg-muted/60 border-border text-muted-foreground', stroke: 'hsl(var(--muted-foreground))' },
  system:   { icon: Zap,           chip: 'bg-muted/60 border-border text-muted-foreground', stroke: 'hsl(var(--muted-foreground))' },
  novedad:  { icon: AlertTriangle, chip: 'bg-warning/14 border-warning/30 text-warning',    stroke: 'hsl(var(--warning))' },
};

/**
 * `hsl(var(--x))` → `hsl(var(--x) / a)`.
 * El idiom `${color}22` SOLO funciona con hex de 6 dígitos: sobre un string
 * `hsl(...)` genera CSS inválido y el halo no se pinta.
 */
const ring = (color: string, alpha: number) => color.replace(/\)$/, ` / ${alpha})`);

function dayLabel(date: Date): string {
  if (isToday(date)) return 'Hoy';
  if (isYesterday(date)) return 'Ayer';
  return format(date, "EEEE d 'de' MMMM", { locale: es });
}

function groupByDay(events: TimelineEvent[]): { day: string; events: TimelineEvent[] }[] {
  const groups = new Map<string, { day: string; events: TimelineEvent[] }>();
  for (const ev of events) {
    const key = format(ev.timestamp, 'yyyy-MM-dd');
    if (!groups.has(key)) {
      groups.set(key, { day: dayLabel(ev.timestamp), events: [] });
    }
    groups.get(key)!.events.push(ev);
  }
  return Array.from(groups.values());
}

export default function Timeline({ events, allowedCategories, compact = false, emptyText }: Props) {
  const filtered = allowedCategories
    ? events.filter((e) => allowedCategories.includes(e.category))
    : events;

  if (filtered.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 gap-3 text-muted-foreground">
        <span className="w-9 h-9 rounded-xl border border-border bg-muted/60 flex items-center justify-center" aria-hidden="true">
          <Clock size={17} />
        </span>
        <p className="text-xs">{emptyText || 'Sin eventos para mostrar'}</p>
      </div>
    );
  }

  const groups = compact ? [{ day: '', events: filtered }] : groupByDay(filtered);

  // `buildTimeline` ordena de más reciente a más viejo: el primero es el evento
  // que la asesora tiene que mirar primero, y es el único que lleva pulso.
  const latestId = filtered[0]?.id;

  // Geometría del nodo. La espina se dibuja a la mitad del nodo para que quede
  // enhebrada por el centro.
  const node = compact ? 20 : 24;
  const spineLeft = node / 2;

  return (
    <div className={compact ? 'space-y-4' : 'space-y-5'}>
      {groups.map((group, gi) => (
        <div key={gi}>
          {!compact && group.day && (
            <div className="flex items-center gap-2 mb-2.5">
              <span className="hud-label whitespace-nowrap">{group.day}</span>
              <span
                aria-hidden="true"
                className="h-px flex-1 rounded-full"
                style={{ background: 'linear-gradient(90deg, hsl(var(--border-strong)), transparent)' }}
              />
            </div>
          )}

          {/* La espina vive en este <div>, NO dentro del <ol>: el spec sólo
              admite <li>/<script>/<template> como hijos directos de una lista,
              y un <span> ahí es markup que cualquier linter de a11y marca. */}
          <div className="relative">
            <span
              aria-hidden="true"
              className="absolute top-1.5 bottom-1.5 w-px"
              style={{
                left: spineLeft,
                background:
                  'linear-gradient(180deg, hsl(var(--accent) / 0.85), hsl(var(--cyan) / 0.45) 45%, hsl(var(--border) / 0.55))',
                boxShadow: '0 0 10px hsl(var(--accent) / 0.35)',
              }}
            />

          <ol className="space-y-3" aria-label="Eventos del pedido">
            {group.events.map((ev, idx) => {
              const meta = CATEGORY_META[ev.category];
              const Icon = meta.icon;
              const isLatest = ev.id === latestId;
              return (
                <motion.li
                  key={ev.id}
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: Math.min(idx * 0.02, 0.2) }}
                  className="relative"
                  style={{ paddingLeft: node + 12 }}
                >
                  {/* Halo que late — solo el evento más reciente. */}
                  {isLatest && (
                    <span
                      aria-hidden="true"
                      className="absolute left-0 top-0 rounded-xl motion-safe:animate-gb-pulse"
                      style={{
                        width: node,
                        height: node,
                        boxShadow: `0 0 0 4px ${ring(meta.stroke, 0.18)}`,
                      }}
                    />
                  )}

                  {/* Nodo: chip teñido con el ícono adentro, recortado del fondo
                      por un aro del color de la superficie + halo del tono. */}
                  <span
                    aria-hidden="true"
                    className={`absolute left-0 top-0 flex items-center justify-center rounded-xl border ${meta.chip}`}
                    style={{
                      width: node,
                      height: node,
                      boxShadow: `0 0 0 3px hsl(var(--background)), 0 0 14px ${ring(meta.stroke, 0.35)}`,
                    }}
                  >
                    <Icon size={compact ? 11 : 12} />
                  </span>

                  {/* El evento más reciente va sobre una superficie teñida —
                      misma fórmula que la "fila propia" del ranking del DS —
                      para que se lea primero sin cambiar el contenido. */}
                  <div
                    className={
                      isLatest
                        ? 'min-w-0 rounded-xl border border-accent/32 bg-accent/12 glow-accent px-3 py-2 -mt-1.5'
                        : 'min-w-0'
                    }
                  >
                    <div className="text-xs font-semibold text-foreground leading-snug">{ev.title}</div>
                    {ev.description && (
                      <div className="text-[11px] text-muted-foreground mt-0.5 leading-snug break-words">
                        {ev.description}
                      </div>
                    )}
                    <div className="flex items-center gap-1.5 mt-1 text-[10px] text-muted-foreground/80">
                      <span className="font-mono tabular-nums">{formatDistanceToNow(ev.timestamp, { addSuffix: true, locale: es })}</span>
                      {ev.actor && (
                        <>
                          <span>·</span>
                          <span className="font-medium">por {ev.actor}</span>
                        </>
                      )}
                    </div>
                  </div>
                </motion.li>
              );
            })}
          </ol>
          </div>
        </div>
      ))}
    </div>
  );
}

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

const CATEGORY_META: Record<
  TimelineCategory,
  { icon: LucideIcon; dot: string; text: string }
> = {
  dropi:    { icon: Cloud,         dot: 'bg-cyan',    text: 'text-cyan' },
  call:     { icon: Phone,         dot: 'bg-info',    text: 'text-info' },
  whatsapp: { icon: MessageSquare, dot: 'bg-success', text: 'text-success' },
  sms:      { icon: Mail,          dot: 'bg-accent',  text: 'text-accent' },
  note:     { icon: FileText,      dot: 'bg-warning', text: 'text-warning' },
  status:   { icon: CheckCircle2,  dot: 'bg-muted-foreground', text: 'text-muted-foreground' },
  system:   { icon: Zap,           dot: 'bg-muted-foreground', text: 'text-muted-foreground' },
  novedad:  { icon: AlertTriangle, dot: 'bg-warning', text: 'text-warning' },
};

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
      <div className="flex flex-col items-center justify-center py-10 gap-2 text-muted-foreground">
        <Clock size={28} className="opacity-50" />
        <p className="text-xs">{emptyText || 'Sin eventos para mostrar'}</p>
      </div>
    );
  }

  const groups = compact ? [{ day: '', events: filtered }] : groupByDay(filtered);

  return (
    <div className="space-y-5">
      {groups.map((group, gi) => (
        <div key={gi}>
          {!compact && group.day && (
            <div className="hud-label mb-2 pl-1">
              {group.day}
            </div>
          )}
          <ol className="relative border-l-2 border-border ml-3 space-y-3" aria-label="Eventos del pedido">
            {group.events.map((ev, idx) => {
              const meta = CATEGORY_META[ev.category];
              const Icon = meta.icon;
              return (
                <motion.li
                  key={ev.id}
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: Math.min(idx * 0.02, 0.2) }}
                  className="ml-4"
                >
                  {/* Dot + icon */}
                  <div
                    className={`absolute -left-[9px] w-4 h-4 rounded-full ${meta.dot} ring-2 ring-background flex items-center justify-center`}
                  >
                    <div className="w-1.5 h-1.5 rounded-full bg-background" />
                  </div>

                  <div className="flex items-start gap-2">
                    <Icon size={13} className={`${meta.text} flex-shrink-0 mt-0.5`} />
                    <div className="flex-1 min-w-0">
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
                  </div>
                </motion.li>
              );
            })}
          </ol>
        </div>
      ))}
    </div>
  );
}

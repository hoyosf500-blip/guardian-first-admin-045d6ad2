import { OrderData } from '@/lib/orderUtils';
import { useMemo } from 'react';
import { Search, CheckCircle2, XCircle, PhoneOff, Clock, LayoutGrid, Bell } from 'lucide-react';
import type { NoteIndex } from '@/hooks/useOrderNotesIndex';

interface Props {
  workQueue: OrderData[];
  filter: string;
  setFilter: (f: string) => void;
  search: string;
  setSearch: (s: string) => void;
  /** Mapa agregado de notas por pedido. Si trae alguno con recordatorio
   *  cercano (≤1h o ya vencido), aparece el chip "Recordatorios". */
  notesIndex?: NoteIndex;
}

const filterMeta: Record<string, { icon: typeof Clock; color: string }> = {
  pending: { icon: Clock,        color: 'text-info' },
  conf:    { icon: CheckCircle2, color: 'text-success' },
  canc:    { icon: XCircle,      color: 'text-danger' },
  noresp:  { icon: PhoneOff,     color: 'text-warning' },
  remind:  { icon: Bell,         color: 'text-warning' },
  all:     { icon: LayoutGrid,   color: 'text-muted-foreground' },
};

/** "Próximo" = recordatorio que llega en ≤1h o que ya pasó (vencido). */
const REMIND_LOOKAHEAD_MS = 60 * 60 * 1000;

export default function WorkFilters({ workQueue, filter, setFilter, search, setSearch, notesIndex }: Props) {
  const counts = useMemo(() => {
    const confCount = workQueue.filter(o => o.result === 'conf').length;
    const cancCount = workQueue.filter(o => o.result === 'canc').length;
    const nrCount = workQueue.filter(o => o.result === 'noresp').length;
    const pendCount = workQueue.filter(o => !o.result).length;

    const now = Date.now();
    const remindCount = notesIndex
      ? workQueue.filter(o => {
          const r = o.dbId ? notesIndex.get(o.dbId)?.nextReminderAt : null;
          if (!r) return false;
          const t = Date.parse(r);
          return Number.isFinite(t) && t <= now + REMIND_LOOKAHEAD_MS;
        }).length
      : 0;

    const seen: Record<string, boolean> = {};
    const products = workQueue
      .map(o => o.producto)
      .filter(p => { if (!p || seen[p]) return false; seen[p] = true; return true; })
      .sort();

    return { confCount, cancCount, nrCount, pendCount, remindCount, products };
  }, [workQueue, notesIndex]);

  const filters = [
    { id: 'pending', label: 'Pendientes', count: counts.pendCount },
    ...(counts.remindCount ? [{ id: 'remind', label: 'Recordatorios', count: counts.remindCount }] : []),
    ...(counts.confCount ? [{ id: 'conf', label: 'Confirmados', count: counts.confCount }] : []),
    ...(counts.cancCount ? [{ id: 'canc', label: 'Cancelados', count: counts.cancCount }] : []),
    ...(counts.nrCount ? [{ id: 'noresp', label: 'No respondió', count: counts.nrCount }] : []),
    { id: 'all', label: 'Todos', count: workQueue.length },
    ...counts.products.map(p => {
      const c = workQueue.filter(o => o.producto === p && !o.result).length;
      return c ? { id: `prod_${p}`, label: p.slice(0, 14), count: c } : null;
    }).filter(Boolean) as { id: string; label: string; count: number }[],
  ];

  return (
    <div className="space-y-2.5 w-full">
      <div className="flex gap-1.5 flex-wrap">
        {filters.map(f => {
          const meta = filterMeta[f.id] || { icon: LayoutGrid, color: 'text-muted-foreground' };
          const Icon = meta.icon;
          const isActive = filter === f.id;
          return (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors duration-200 border cursor-pointer ${
                isActive
                  ? 'bg-accent/12 text-accent border-accent/30 shadow-ds-xs'
                  : 'bg-muted/40 text-muted-foreground border-transparent hover:bg-muted/70 hover:text-foreground'
              }`}
            >
              <Icon size={12} className={isActive ? meta.color : ''} aria-hidden="true" />
              <span>{f.label}</span>
              <span className={`ml-0.5 text-[10px] font-mono tabular-nums ${isActive ? 'text-accent/80' : 'text-muted-foreground/60'}`}>
                {f.count}
              </span>
            </button>
          );
        })}
      </div>

      <div className="relative">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/60" />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Buscar nombre, teléfono o ciudad..."
          className="w-full pl-8 pr-3 py-2 bg-muted/30 border border-border/60 rounded-lg text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/40 transition-colors duration-200"
        />
      </div>
    </div>
  );
}

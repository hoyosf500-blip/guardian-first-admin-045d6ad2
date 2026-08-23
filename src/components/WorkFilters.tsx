import { OrderData } from '@/lib/orderUtils';
import { useMemo } from 'react';
import { Search, CheckCircle2, XCircle, PhoneOff, Clock, LayoutGrid, Bell, CalendarClock } from 'lucide-react';
import type { NoteIndex } from '@/hooks/useOrderNotesIndex';
import { REMIND_LOOKAHEAD_MS, estaAplazado } from '@/lib/confirmarQueue';
import { isLockedByOther } from '@/lib/callQueueNav';

interface Props {
  workQueue: OrderData[];
  filter: string;
  setFilter: (f: string) => void;
  search: string;
  setSearch: (s: string) => void;
  /** Mapa agregado de notas por pedido. Si trae alguno con recordatorio
   *  cercano (≤1h o ya vencido), aparece el chip "Recordatorios". */
  notesIndex?: NoteIndex;
  /** Quién soy: para descontar del chip "Pendientes" los pedidos lockeados por
   *  OTRA asesora (la lista ya los esconde; el chip prometía filas que la lista
   *  no muestra). Sin el id, el conteo queda como antes. */
  currentUserId?: string | null;
}

const filterMeta: Record<string, { icon: typeof Clock; color: string }> = {
  pending: { icon: Clock,        color: 'text-info' },
  conf:    { icon: CheckCircle2, color: 'text-success' },
  canc:    { icon: XCircle,      color: 'text-danger' },
  noresp:  { icon: PhoneOff,     color: 'text-warning' },
  remind:  { icon: Bell,         color: 'text-warning' },
  aplazado:{ icon: CalendarClock, color: 'text-accent' },
  all:     { icon: LayoutGrid,   color: 'text-muted-foreground' },
};

// REMIND_LOOKAHEAD_MS y estaAplazado vienen de confirmarQueue: el chip, el filtro
// de ConfirmarTab y la regla de aplazado tienen que usar el MISMO número, o un
// pedido puede quedar escondido de la cola y fuera del chip a la vez.

export default function WorkFilters({ workQueue, filter, setFilter, search, setSearch, notesIndex, currentUserId }: Props) {
  const counts = useMemo(() => {
    const confCount = workQueue.filter(o => o.result === 'conf').length;
    const cancCount = workQueue.filter(o => o.result === 'canc').length;
    const nrCount = workQueue.filter(o => o.result === 'noresp').length;

    const now = Date.now();
    const reminderDe = (o: OrderData) =>
      (notesIndex && o.dbId ? notesIndex.get(o.dbId)?.nextReminderAt : null) ?? null;

    // Aplazados = reagendados a futuro. Salen de "Pendientes" (el cliente pidió
    // otro día), así que se descuentan del conteo o el chip prometería trabajo
    // que la cola no entrega — el desfase que ya pasó con los "no contestó"
    // enfriando (ver resumenSinRespuestaHoy).
    const aplazadoCount = notesIndex
      ? workQueue.filter(o => estaAplazado({ result: o.result, nextReminderAt: reminderDe(o) }, now)).length
      : 0;
    // `!isLockedByOther`: la lista esconde lo que otra asesora tiene tomado;
    // si el chip lo cuenta, promete una fila que no existe en pantalla.
    const pendCount = workQueue.filter(o =>
      !o.result &&
      !estaAplazado({ result: o.result, nextReminderAt: reminderDe(o) }, now) &&
      !(currentUserId !== undefined && isLockedByOther(o, currentUserId ?? null, now))).length;

    const remindCount = notesIndex
      ? workQueue.filter(o => {
          const r = reminderDe(o);
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

    return { confCount, cancCount, nrCount, pendCount, remindCount, aplazadoCount, products };
  }, [workQueue, notesIndex, currentUserId]);

  const filters = [
    { id: 'pending', label: 'Pendientes', count: counts.pendCount },
    ...(counts.remindCount ? [{ id: 'remind', label: 'Recordatorios', count: counts.remindCount }] : []),
    // Aplazados: el chip existe justamente para que reagendar no sea "esconder".
    ...(counts.aplazadoCount ? [{ id: 'aplazado', label: 'Aplazados', count: counts.aplazadoCount }] : []),
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
              aria-pressed={isActive}
              className={`inline-flex items-center gap-1.5 px-3 min-h-[36px] rounded-lg text-xs font-semibold transition-colors duration-200 border cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${
                isActive
                  ? 'bg-accent/12 text-accent border-accent/30 shadow-ds-xs'
                  : 'bg-muted/40 text-muted-foreground border-border/60 hover:bg-muted/70 hover:text-foreground'
              }`}
            >
              <Icon size={13} className={isActive ? meta.color : ''} aria-hidden="true" />
              <span>{f.label}</span>
              <span className={`ml-0.5 text-[11px] font-mono tabular-nums ${isActive ? 'text-accent/80' : 'text-muted-foreground/60'}`}>
                {f.count}
              </span>
            </button>
          );
        })}
      </div>

      <div className="relative">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60 pointer-events-none" aria-hidden="true" />
        <label className="sr-only" htmlFor="confirmar-search">Buscar nombre, teléfono o ciudad</label>
        <input
          id="confirmar-search"
          type="search"
          inputMode="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Buscar nombre, teléfono o ciudad..."
          className="w-full pl-10 pr-3 py-2.5 min-h-[44px] bg-muted/30 border border-border/60 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/40 transition-colors duration-200"
        />
      </div>
    </div>
  );
}

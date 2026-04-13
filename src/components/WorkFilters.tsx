import { OrderData } from '@/lib/orderUtils';
import { useMemo } from 'react';
import { Search, Clock, CheckCircle2, XCircle, PhoneOff, List } from 'lucide-react';

interface Props {
  workQueue: OrderData[];
  filter: string;
  setFilter: (f: string) => void;
  search: string;
  setSearch: (s: string) => void;
}

export default function WorkFilters({ workQueue, filter, setFilter, search, setSearch }: Props) {
  const counts = useMemo(() => {
    const confCount = workQueue.filter(o => o.result === 'conf').length;
    const cancCount = workQueue.filter(o => o.result === 'canc').length;
    const nrCount = workQueue.filter(o => o.result === 'noresp').length;
    const pendCount = workQueue.filter(o => !o.result).length;

    const seen: Record<string, boolean> = {};
    const products = workQueue
      .map(o => o.producto)
      .filter(p => { if (!p || seen[p]) return false; seen[p] = true; return true; })
      .sort();

    return { confCount, cancCount, nrCount, pendCount, products };
  }, [workQueue]);

  const filters = [
    { id: 'pending', label: `Pendientes (${counts.pendCount})` },
    ...(counts.confCount ? [{ id: 'conf', label: `Confirmados (${counts.confCount})` }] : []),
    ...(counts.cancCount ? [{ id: 'canc', label: `Cancelados (${counts.cancCount})` }] : []),
    ...(counts.nrCount ? [{ id: 'noresp', label: `No respondió (${counts.nrCount})` }] : []),
    { id: 'all', label: `Todos (${workQueue.length})` },
    ...counts.products.map(p => {
      const c = workQueue.filter(o => o.producto === p && !o.result).length;
      return c ? { id: `prod_${p}`, label: `${p.slice(0, 16)} (${c})` } : null;
    }).filter(Boolean) as { id: string; label: string }[],
  ];

  return (
    <>
      <div className="flex gap-1.5 flex-wrap mb-3">
        {filters.map(f => (
          <button key={f.id} onClick={() => setFilter(f.id)}
            className={`px-3.5 py-1.5 rounded-full text-xs font-semibold border transition-all ${filter === f.id ? 'bg-cyan/10 text-cyan border-cyan/30' : 'bg-muted/50 text-muted-foreground border-border'}`}>
            {f.label}
          </button>
        ))}
      </div>

      <div className="relative mb-3">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Buscar nombre, teléfono o ciudad..."
          className="w-full pl-9 pr-3 py-2.5 bg-card border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground"
        />
      </div>
    </>
  );
}

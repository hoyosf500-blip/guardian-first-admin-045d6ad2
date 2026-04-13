import { useOrders } from '@/contexts/OrderContext';

export default function CounterBar() {
  const { workQueue, counter } = useOrders();
  const total = counter.conf + counter.canc + counter.noresp;
  const goal = workQueue.length || 1;
  const pct = Math.min(100, Math.round(total / goal * 100));
  const tasa = total > 0 ? Math.round(counter.conf / total * 100) : 0;

  if (workQueue.length === 0) return null;

  const barColor = tasa >= 80 ? 'bg-green' : tasa >= 60 ? 'bg-orange' : 'bg-red';

  return (
    <div className="fixed top-0 left-0 right-0 z-40 bg-surface border-b border-border px-4 py-2 flex items-center gap-3">
      <div className="flex items-center gap-1 text-sm font-semibold">
        <span className="text-green">✅</span>
        <span className="font-mono text-base font-bold">{counter.conf}</span>
      </div>
      <div className="flex items-center gap-1 text-sm font-semibold">
        <span className="text-red">❌</span>
        <span className="font-mono text-base font-bold">{counter.canc}</span>
      </div>
      <div className="flex items-center gap-1 text-sm font-semibold">
        <span className="text-muted-foreground">📵</span>
        <span className="font-mono text-base font-bold">{counter.noresp}</span>
      </div>
      <div className="flex-1 h-1 bg-border rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-500 ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="flex items-center gap-1 text-sm font-semibold">
        <span className="font-mono text-base font-bold">{total}</span>
        <span className="text-muted-foreground text-xs">/{goal}</span>
      </div>
      <div className="relative w-10 h-10 flex-shrink-0">
        <svg width="40" height="40" className="-rotate-90">
          <circle cx="20" cy="20" r="16" fill="none" strokeWidth="4" stroke="hsl(var(--border))" />
          <circle cx="20" cy="20" r="16" fill="none" strokeWidth="4" stroke="hsl(var(--cyan))" strokeLinecap="round"
            strokeDasharray={100.5} strokeDashoffset={100.5 * (1 - pct / 100)}
            className="transition-all duration-500" />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center text-[9px] font-bold font-mono">{pct}%</div>
      </div>
    </div>
  );
}

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
    <div className="bg-card border border-border rounded-xl p-3 mb-4 flex items-center gap-3">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1 text-sm">
          <span className="text-green text-xs">✅</span>
          <span className="font-mono text-sm font-bold">{counter.conf}</span>
        </div>
        <div className="flex items-center gap-1 text-sm">
          <span className="text-red text-xs">❌</span>
          <span className="font-mono text-sm font-bold">{counter.canc}</span>
        </div>
        <div className="flex items-center gap-1 text-sm">
          <span className="text-muted-foreground text-xs">📵</span>
          <span className="font-mono text-sm font-bold">{counter.noresp}</span>
        </div>
      </div>
      <div className="flex-1 h-1.5 bg-border rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-500 ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="flex items-center gap-1.5 text-sm">
        <span className="font-mono font-bold">{total}</span>
        <span className="text-muted-foreground text-xs">/{goal}</span>
        <span className="text-xs text-muted-foreground ml-1">({pct}%)</span>
      </div>
    </div>
  );
}

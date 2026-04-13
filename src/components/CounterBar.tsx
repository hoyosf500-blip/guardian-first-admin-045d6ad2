import { useOrders } from '@/contexts/OrderContext';
import { CheckCircle2, XCircle, PhoneOff } from 'lucide-react';

export default function CounterBar() {
  const { workQueue, counter } = useOrders();
  const total = counter.conf + counter.canc + counter.noresp;
  const goal = workQueue.length || 1;
  const pct = Math.min(100, Math.round(total / goal * 100));
  const tasa = total > 0 ? Math.round(counter.conf / total * 100) : 0;

  if (workQueue.length === 0) return null;

  const barGradient = tasa >= 80
    ? 'from-emerald-500 to-green-400'
    : tasa >= 60
    ? 'from-amber-500 to-orange-400'
    : 'from-red-500 to-rose-400';

  return (
    <div className="bg-card border border-border rounded-2xl p-3.5 mb-4 flex items-center gap-4">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5 text-sm">
          <div className="w-6 h-6 rounded-lg bg-emerald-500/10 flex items-center justify-center">
            <CheckCircle2 size={13} className="text-emerald-500" />
          </div>
          <span className="font-mono text-sm font-bold text-foreground">{counter.conf}</span>
        </div>
        <div className="flex items-center gap-1.5 text-sm">
          <div className="w-6 h-6 rounded-lg bg-red-500/10 flex items-center justify-center">
            <XCircle size={13} className="text-red-500" />
          </div>
          <span className="font-mono text-sm font-bold text-foreground">{counter.canc}</span>
        </div>
        <div className="flex items-center gap-1.5 text-sm">
          <div className="w-6 h-6 rounded-lg bg-secondary flex items-center justify-center">
            <PhoneOff size={13} className="text-muted-foreground" />
          </div>
          <span className="font-mono text-sm font-bold text-foreground">{counter.noresp}</span>
        </div>
      </div>
      <div className="flex-1 h-2 bg-secondary rounded-full overflow-hidden">
        <div className={`h-full rounded-full bg-gradient-to-r ${barGradient} transition-all duration-700 ease-out`} style={{ width: `${pct}%` }} />
      </div>
      <div className="flex items-center gap-1.5 text-sm">
        <span className="font-mono font-bold text-foreground">{total}</span>
        <span className="text-muted-foreground text-xs">/{goal}</span>
        <span className={`text-xs font-semibold ml-1 px-1.5 py-0.5 rounded-md ${
          pct >= 80 ? 'bg-emerald-500/10 text-emerald-500' : pct >= 50 ? 'bg-amber-500/10 text-amber-500' : 'bg-secondary text-muted-foreground'
        }`}>{pct}%</span>
      </div>
    </div>
  );
}

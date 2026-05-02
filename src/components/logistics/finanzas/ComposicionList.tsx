import type { ElementType } from 'react';
import { formatCOP } from '@/lib/utils';

export interface ComposicionItem {
  label: string;
  value: number;
  color: string;       // hsl(var(--token)) o hex
  sublabel?: string;   // opcional: ej "$25.000 c/u" o "5 movimientos"
}

interface ComposicionListProps {
  title: string;
  total: number;
  items: ComposicionItem[];
  totalLabel?: string;
  totalTone?: 'success' | 'danger' | 'neutral';
  icon?: ElementType;
  isLoading?: boolean;
  emptyMessage?: string;
}

export default function ComposicionList({
  title, total, items,
  totalLabel = 'Total', totalTone = 'neutral',
  icon: Icon, isLoading = false,
  emptyMessage = 'Sin datos en este rango',
}: ComposicionListProps) {
  if (isLoading) {
    return <div className="rounded-xl border border-border bg-card animate-pulse h-[340px]" />;
  }

  // Filtramos los <=0 (ruido visual) y ordenamos desc por value.
  const sorted = items.filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
  const max = sorted[0]?.value ?? 1;

  const totalToneClass =
    totalTone === 'success' ? 'text-success' :
    totalTone === 'danger' ? 'text-danger' :
    'text-foreground';

  return (
    <div className="card-elevated p-5 flex flex-col">
      <div className="flex items-end justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          {Icon && (
            <div className="h-7 w-7 rounded-lg bg-muted/40 border border-border flex items-center justify-center">
              <Icon size={13} className="text-muted-foreground" aria-hidden="true" />
            </div>
          )}
          <h3 className="text-sm font-bold text-foreground tracking-tight uppercase tracking-[0.06em]">
            {title}
          </h3>
        </div>
        <div className="text-right">
          <div className={`text-base font-bold tabular-nums leading-none ${totalToneClass}`}>
            {formatCOP(total)}
          </div>
          <div className="text-[10px] uppercase tracking-[0.08em] font-semibold text-muted-foreground mt-1">
            {totalLabel}
          </div>
        </div>
      </div>

      {sorted.length === 0 ? (
        <div className="flex items-center justify-center h-[200px] text-xs text-muted-foreground">
          {emptyMessage}
        </div>
      ) : (
        <ul className="space-y-3">
          {sorted.map(({ label, value, color, sublabel }) => {
            const widthPct = Math.max(2, (value / max) * 100);
            const sharePct = total > 0 ? (value / total) * 100 : 0;
            return (
              <li key={label}>
                <div className="flex items-baseline justify-between gap-3 mb-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="h-2 w-2 rounded-full shrink-0" style={{ background: color }} />
                    <span className="text-xs font-medium text-foreground truncate">{label}</span>
                    {sublabel && (
                      <span className="text-[10px] text-muted-foreground truncate">· {sublabel}</span>
                    )}
                  </div>
                  <div className="flex items-baseline gap-2 shrink-0">
                    <span className="text-xs font-semibold tabular-nums text-foreground">
                      {formatCOP(value)}
                    </span>
                    <span className="text-[10px] tabular-nums text-muted-foreground w-10 text-right">
                      {sharePct.toFixed(1)}%
                    </span>
                  </div>
                </div>
                <div className="h-1.5 rounded-full bg-muted/40 overflow-hidden">
                  <div
                    className="h-full rounded-full transition-[width] duration-500"
                    style={{ width: `${widthPct}%`, background: color }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

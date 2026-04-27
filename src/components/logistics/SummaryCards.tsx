import { memo } from 'react';
import { Package, CheckCircle2, RotateCcw, TrendingUp } from 'lucide-react';
import { formatCOP } from '@/lib/utils';
import type { LogisticsSummary } from '@/lib/logistics.types';

interface Props {
  data: LogisticsSummary | null;
}

interface Card {
  label: string;
  value: string;
  hint?: string;
  icon: typeof Package;
  tone: 'neutral' | 'success' | 'danger' | 'accent';
}

const TONE: Record<Card['tone'], string> = {
  neutral: 'border-border bg-card',
  success: 'border-emerald-500/30 bg-emerald-500/5',
  danger:  'border-red-500/30 bg-red-500/5',
  accent:  'border-accent/30 bg-accent/5',
};

export default memo(function SummaryCards({ data }: Props) {
  if (!data) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[0,1,2,3].map(i => (
          <div key={i} className="h-24 rounded-xl border border-border bg-card animate-pulse" />
        ))}
      </div>
    );
  }

  const cards: Card[] = [
    {
      label: 'Total envíos',
      value: data.total_pedidos.toLocaleString('es-CO'),
      hint: 'Excluye cancelados',
      icon: Package,
      tone: 'neutral',
    },
    {
      label: 'Entregados',
      value: data.entregados.toLocaleString('es-CO'),
      hint: `${data.tasa_entrega.toFixed(1)}% de tasa`,
      icon: CheckCircle2,
      tone: 'success',
    },
    {
      label: 'Devueltos',
      value: data.devueltos.toLocaleString('es-CO'),
      hint: `${data.tasa_devolucion.toFixed(1)}% de tasa`,
      icon: RotateCcw,
      tone: 'danger',
    },
    {
      label: 'Valor entregado',
      value: formatCOP(data.valor_entregado),
      hint: `Perdido: ${formatCOP(data.valor_perdido)}`,
      icon: TrendingUp,
      tone: 'accent',
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" aria-label="Resumen logístico">
      {cards.map(c => {
        const Icon = c.icon;
        return (
          <div key={c.label} className={`rounded-xl border p-4 ${TONE[c.tone]}`}>
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
              <Icon size={13} aria-hidden="true" />
              <span>{c.label}</span>
            </div>
            <div className="text-2xl font-bold text-foreground tabular-nums">{c.value}</div>
            {c.hint && (
              <div className="text-[11px] text-muted-foreground mt-1">{c.hint}</div>
            )}
          </div>
        );
      })}
    </div>
  );
});

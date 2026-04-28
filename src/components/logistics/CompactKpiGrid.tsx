import { memo } from 'react';
import { Package, CheckCircle2, RotateCcw, DollarSign } from 'lucide-react';
import { formatCOP } from '@/lib/utils';
import type { LogisticsSummary } from '@/lib/logistics.types';

interface Props {
  data: LogisticsSummary | null;
}

export default memo(function CompactKpiGrid({ data }: Props) {
  if (!data) {
    return (
      <div className="grid grid-cols-2 gap-3 h-full">
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="rounded-xl border border-border bg-card skeleton-shimmer min-h-[120px]" />
        ))}
      </div>
    );
  }

  const tasaEntrega = data.tasa_entrega ?? 0;
  const tasaDevolucion = data.tasa_devolucion ?? 0;
  const valorTotal = (data.valor_entregado ?? 0) + (data.valor_perdido ?? 0);
  const pctValor = valorTotal > 0 ? ((data.valor_entregado ?? 0) / valorTotal) * 100 : 0;

  return (
    <div className="grid grid-cols-2 gap-3 h-full">
      <KpiCard
        label="Total envíos"
        value={data.total_pedidos.toLocaleString('es-CO')}
        icon={Package}
        tone="info"
        hint="Excluye cancelados"
      />
      <KpiCard
        label="Entregados"
        value={data.entregados.toLocaleString('es-CO')}
        icon={CheckCircle2}
        tone="success"
        hint={`${tasaEntrega.toFixed(1)}% de tasa`}
        trendPct={tasaEntrega}
      />
      <KpiCard
        label="Devueltos"
        value={data.devueltos.toLocaleString('es-CO')}
        icon={RotateCcw}
        tone="danger"
        hint={`${tasaDevolucion.toFixed(1)}% de tasa`}
        trendPct={tasaDevolucion}
        inverseTrend
      />
      <KpiCard
        label="Valor entregado"
        value={formatCOP(data.valor_entregado)}
        valueClass="text-lg"
        icon={DollarSign}
        tone="accent"
        hint={`Perdido: ${formatCOP(data.valor_perdido)}`}
        hintTone="danger"
        trendPct={pctValor}
      />
    </div>
  );
});

interface KpiCardProps {
  label: string;
  value: string;
  valueClass?: string;
  icon: typeof Package;
  tone: 'info' | 'success' | 'danger' | 'accent';
  hint: string;
  hintTone?: 'neutral' | 'danger';
  trendPct?: number;
  inverseTrend?: boolean;
}

function KpiCard({ label, value, valueClass, icon: Icon, tone, hint, hintTone, trendPct, inverseTrend }: KpiCardProps) {
  // Cada tono define icon container (rounded-full según referencia) +
  // trend pill color. Tokens semánticos del DS.
  const toneStyles = {
    info: {
      iconBg: 'bg-info/12',
      iconRing: 'ring-info/25',
      iconColor: 'text-info',
      trendBg: 'bg-info/12',
      trendText: 'text-info',
    },
    success: {
      iconBg: 'bg-success/12',
      iconRing: 'ring-success/25',
      iconColor: 'text-success',
      trendBg: 'bg-success/12',
      trendText: 'text-success',
    },
    danger: {
      iconBg: 'bg-danger/12',
      iconRing: 'ring-danger/25',
      iconColor: 'text-danger',
      trendBg: 'bg-danger/12',
      trendText: 'text-danger',
    },
    accent: {
      iconBg: 'bg-accent/12',
      iconRing: 'ring-accent/25',
      iconColor: 'text-accent',
      trendBg: 'bg-accent/12',
      trendText: 'text-accent',
    },
  }[tone];

  // Indicador visual: ↑ para métricas donde más es mejor (entrega,
  // valor entregado), ↓ para inversas (devoluciones).
  const showTrend = trendPct !== undefined;
  const trendUp = !inverseTrend;
  const arrow = trendUp ? '↑' : '↓';

  return (
    <article className="rounded-xl border border-border bg-card p-4 transition-colors hover:border-border-strong flex flex-col justify-between min-h-[120px]">
      <div className="flex items-start gap-3">
        {/* Icon container redondo (estilo referencia) */}
        <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${toneStyles.iconBg} ring-1 ${toneStyles.iconRing}`}>
          <Icon size={18} className={toneStyles.iconColor} aria-hidden="true" strokeWidth={2.25} />
        </div>

        {/* Label + número */}
        <div className="min-w-0 flex-1 space-y-1">
          <div className="text-[11px] uppercase tracking-[0.08em] font-semibold text-muted-foreground truncate">
            {label}
          </div>
          <div className={`font-mono font-bold text-foreground tabular-nums leading-none ${valueClass ?? 'text-2xl'}`}>
            {value}
          </div>
        </div>
      </div>

      {/* Trend + hint en la base */}
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className={`text-[11px] tabular-nums truncate ${hintTone === 'danger' ? 'text-danger' : 'text-muted-foreground'}`}>
          {hint}
        </span>
        {showTrend && (
          <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${toneStyles.trendBg} ${toneStyles.trendText} shrink-0`}>
            <span aria-hidden="true">{arrow}</span>
            {trendPct.toFixed(0)}%
          </span>
        )}
      </div>
    </article>
  );
}

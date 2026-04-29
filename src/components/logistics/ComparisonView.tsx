import { memo } from 'react';
import { TrendingUp, TrendingDown, Minus, GitCompare, Package, CheckCircle2, RotateCcw, Truck as TruckIcon } from 'lucide-react';
import { useLogisticsStats } from '@/hooks/useLogisticsStats';
import DateRangeFilter from '@/components/logistics/DateRangeFilter';
import { formatCOP } from '@/lib/utils';
import type { LogisticsFilters, LogisticsSummary } from '@/lib/logistics.types';

interface Props {
  periodA: LogisticsFilters;
  periodB: LogisticsFilters;
  onPeriodAChange: (range: LogisticsFilters) => void;
  onPeriodBChange: (range: LogisticsFilters) => void;
}

/**
 * Vista comparativa A vs B. Carga 2 summaries en paralelo y muestra los KPIs
 * principales lado a lado con delta (Δ%) entre períodos. Ideal para validar
 * "antes vs después" cuando el admin hace cambios operativos.
 */
export default memo(function ComparisonView({
  periodA, periodB,
  onPeriodAChange, onPeriodBChange,
}: Props) {
  const a = useLogisticsStats(periodA);
  const b = useLogisticsStats(periodB);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <PeriodHeader label="Período A" accent="info"   range={periodA} onChange={onPeriodAChange} />
        <PeriodHeader label="Período B" accent="accent" range={periodB} onChange={onPeriodBChange} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <PeriodColumn
          label="Período A"
          accent="info"
          summary={a.summary.data ?? null}
          isLoading={a.isLoading}
          compareTo={b.summary.data ?? null}
        />
        <PeriodColumn
          label="Período B"
          accent="accent"
          summary={b.summary.data ?? null}
          isLoading={b.isLoading}
          compareTo={a.summary.data ?? null}
        />
      </div>

      {a.summary.data && b.summary.data && (
        <DeltaSummary periodA={a.summary.data} periodB={b.summary.data} />
      )}
    </div>
  );
});

// ── Sub-componentes ─────────────────────────────────────────────

function PeriodHeader({
  label, accent, range, onChange,
}: {
  label: string;
  accent: 'info' | 'accent';
  range: LogisticsFilters;
  onChange: (range: LogisticsFilters) => void;
}) {
  const accentClass = accent === 'info'
    ? 'bg-info/12 text-info ring-info/30'
    : 'bg-accent/12 text-accent ring-accent/30';
  const days = Math.round(
    (new Date(range.toDate).getTime() - new Date(range.fromDate).getTime()) / (24 * 3600 * 1000),
  );
  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className={`pill text-[11px] font-bold ring-1 ${accentClass}`}>
          {label}
        </span>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {days} día{days !== 1 ? 's' : ''}
        </span>
      </div>
      <DateRangeFilter value={range} onChange={onChange} />
    </div>
  );
}

interface PeriodColumnProps {
  label: string;
  accent: 'info' | 'accent';
  summary: LogisticsSummary | null;
  isLoading: boolean;
  compareTo: LogisticsSummary | null;
}
function PeriodColumn({ label, accent, summary, isLoading, compareTo }: PeriodColumnProps) {
  const accentBorder = accent === 'info' ? 'border-info/40' : 'border-accent/40';

  if (isLoading || !summary) {
    return (
      <div className={`rounded-xl border-2 ${accentBorder} bg-card p-5 skeleton-shimmer min-h-[400px]`} />
    );
  }

  const total = summary.total_pedidos ?? 0;
  const entregados = summary.entregados ?? 0;
  const devueltos = summary.devueltos ?? 0;
  const enTransito = summary.en_transito ?? 0;
  const tasaEntrega = summary.tasa_entrega ?? 0;
  const tasaDevolucion = summary.tasa_devolucion ?? 0;
  const valorEntregado = summary.valor_entregado ?? 0;

  return (
    <div className={`rounded-xl border-2 ${accentBorder} bg-card overflow-hidden`}>
      <header className="px-5 py-3 border-b border-border/60 bg-muted/10">
        <h3 className="text-[11px] uppercase tracking-[0.08em] font-bold text-muted-foreground">
          {label}
        </h3>
      </header>
      <div className="p-5 space-y-3">
        <KpiLine icon={Package}      label="Total pedidos" value={total.toLocaleString('es-CO')}      rawValue={total}      rawCompare={compareTo?.total_pedidos ?? 0} format="absolute" />
        <KpiLine icon={CheckCircle2} label="Entregados"    value={entregados.toLocaleString('es-CO')} rawValue={entregados} rawCompare={compareTo?.entregados ?? 0}    format="absolute" tone="success" />
        <KpiLine icon={RotateCcw}    label="Devueltos"     value={devueltos.toLocaleString('es-CO')}  rawValue={devueltos}  rawCompare={compareTo?.devueltos ?? 0}     format="absolute" tone="danger" inverseDelta />
        <KpiLine icon={TruckIcon}    label="En tránsito"   value={enTransito.toLocaleString('es-CO')} rawValue={enTransito} rawCompare={compareTo?.en_transito ?? 0}   format="absolute" />

        <div className="pt-3 mt-3 border-t border-border/60 space-y-3">
          <KpiLine label="Tasa de entrega"     value={`${tasaEntrega.toFixed(1)}%`}    rawValue={tasaEntrega}     rawCompare={compareTo?.tasa_entrega ?? 0}    format="points"   tone="success" />
          <KpiLine label="Tasa de devolución"  value={`${tasaDevolucion.toFixed(1)}%`} rawValue={tasaDevolucion}  rawCompare={compareTo?.tasa_devolucion ?? 0} format="points"   tone="danger" inverseDelta />
          <KpiLine label="Valor entregado"     value={formatCOP(valorEntregado)}       rawValue={valorEntregado}  rawCompare={compareTo?.valor_entregado ?? 0} format="absolute" tone="success" />
        </div>
      </div>
    </div>
  );
}

interface KpiLineProps {
  icon?: typeof Package;
  label: string;
  value: string;
  rawValue: number;
  rawCompare: number;
  format: 'absolute' | 'points';
  tone?: 'success' | 'danger';
  inverseDelta?: boolean;
}
function KpiLine({ icon: Icon, label, value, rawValue, rawCompare, format, tone, inverseDelta }: KpiLineProps) {
  const valueClass = tone === 'success' ? 'text-success' : tone === 'danger' ? 'text-danger' : 'text-foreground';

  let delta: number | null = null;
  let deltaLabel = '';
  if (rawCompare > 0 || rawValue > 0) {
    if (format === 'absolute') {
      if (rawCompare > 0) {
        delta = ((rawValue - rawCompare) / rawCompare) * 100;
        deltaLabel = `${delta > 0 ? '+' : ''}${delta.toFixed(1)}%`;
      } else if (rawValue > 0) {
        delta = 100;
        deltaLabel = '+∞';
      }
    } else {
      delta = rawValue - rawCompare;
      deltaLabel = `${delta > 0 ? '+' : ''}${delta.toFixed(1)} pts`;
    }
  }

  let deltaTone: 'success' | 'danger' | 'neutral';
  if (delta === null || Math.abs(delta) < 0.05) {
    deltaTone = 'neutral';
  } else {
    const isUp = delta > 0;
    const isGood = inverseDelta ? !isUp : isUp;
    deltaTone = isGood ? 'success' : 'danger';
  }

  const deltaColorClass =
    deltaTone === 'success' ? 'text-success' :
    deltaTone === 'danger' ? 'text-danger' :
    'text-muted-foreground';

  const DeltaIcon = delta === null ? null
    : Math.abs(delta) < 0.05 ? Minus
    : delta > 0 ? TrendingUp : TrendingDown;

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 min-w-0">
        {Icon && <Icon size={13} className="text-muted-foreground shrink-0" aria-hidden="true" />}
        <span className="text-xs text-muted-foreground truncate">{label}</span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className={`font-mono font-bold tabular-nums text-sm ${valueClass}`}>{value}</span>
        {delta !== null && DeltaIcon && (
          <span className={`inline-flex items-center gap-0.5 text-[10px] font-bold tabular-nums ${deltaColorClass}`}>
            <DeltaIcon size={10} aria-hidden="true" />
            {deltaLabel}
          </span>
        )}
      </div>
    </div>
  );
}

function DeltaSummary({ periodA, periodB }: { periodA: LogisticsSummary; periodB: LogisticsSummary }) {
  const tasaA = periodA.tasa_entrega ?? 0;
  const tasaB = periodB.tasa_entrega ?? 0;
  const deltaTasa = tasaB - tasaA;

  const devA = periodA.tasa_devolucion ?? 0;
  const devB = periodB.tasa_devolucion ?? 0;
  const deltaDev = devB - devA;

  const isPositive = deltaTasa > 0 && deltaDev <= 0;
  const tone = Math.abs(deltaTasa) < 1 && Math.abs(deltaDev) < 1
    ? 'neutral'
    : isPositive ? 'success' : (deltaTasa < -3 || deltaDev > 3) ? 'danger' : 'warning';

  const headline = (() => {
    if (tone === 'neutral') return 'Sin cambios significativos entre los períodos.';
    if (tone === 'success') return 'Mejora operativa: la tasa de entrega subió y/o devoluciones bajaron.';
    if (tone === 'warning') return 'Cambios mixtos. Revisar detalle.';
    return 'Empeoramiento: tasa de entrega cayó y/o devoluciones subieron.';
  })();

  const toneStyles = {
    success: { bg: 'bg-success/8', border: 'border-success/30', text: 'text-success' },
    warning: { bg: 'bg-warning/8', border: 'border-warning/30', text: 'text-warning' },
    danger:  { bg: 'bg-danger/8',  border: 'border-danger/30',  text: 'text-danger' },
    neutral: { bg: 'bg-muted/20',  border: 'border-border',     text: 'text-muted-foreground' },
  }[tone];

  return (
    <div className={`rounded-xl border ${toneStyles.border} ${toneStyles.bg} p-4 flex items-start gap-3`}>
      <GitCompare size={16} className={`${toneStyles.text} shrink-0 mt-0.5`} aria-hidden="true" strokeWidth={2.25} />
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-bold ${toneStyles.text}`}>{headline}</p>
        <p className="text-xs text-muted-foreground mt-1 tabular-nums">
          Tasa de entrega: <span className="font-mono">{tasaA.toFixed(1)}% → {tasaB.toFixed(1)}%</span> ({deltaTasa > 0 ? '+' : ''}{deltaTasa.toFixed(1)} pts) ·
          {' '}Devolución: <span className="font-mono">{devA.toFixed(1)}% → {devB.toFixed(1)}%</span> ({deltaDev > 0 ? '+' : ''}{deltaDev.toFixed(1)} pts)
        </p>
      </div>
    </div>
  );
}

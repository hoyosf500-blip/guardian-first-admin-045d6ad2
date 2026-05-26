import { memo } from 'react';
import { Package, CheckCircle2, RotateCcw, DollarSign } from 'lucide-react';
import { formatCOP } from '@/lib/utils';
import type { LogisticsSummary } from '@/lib/logistics.types';
import { deriveDeliveryMaturity } from '@/lib/logisticsRates';

interface Props {
  data: LogisticsSummary | null;
}

export default memo(function CompactKpiGrid({ data }: Props) {
  if (!data) {
    return (
      <div className="grid grid-cols-2 gap-3 h-full">
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="rounded-2xl border-2 border-border bg-card skeleton-shimmer min-h-[140px]" />
        ))}
      </div>
    );
  }

  // Tasas MADURAS: sobre (entregados + devueltos), no sobre el total — así los
  // pedidos en tránsito no hunden la tasa de entrega en rangos recientes.
  // `% concluido` indica madurez; bajo el umbral la tasa es preliminar (gris).
  const m = deriveDeliveryMaturity(data.entregados, data.devueltos, data.total_pedidos);
  const entregaHint = m.tasaEntregaMadura == null
    ? 'Sin concluir aún'
    : `${m.tasaEntregaMadura}% entrega · ${m.pctConcluido}% concluido${m.inmaduro ? ' · prelim.' : ''}`;
  const devolHint = m.tasaDevolucionMadura == null
    ? 'Sin concluir aún'
    : `${m.tasaDevolucionMadura}% sobre concluidos${m.inmaduro ? ' · prelim.' : ''}`;

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
        hint={entregaHint}
        trendPct={m.tasaEntregaMadura ?? undefined}
        mutedTrend={m.inmaduro}
      />
      <KpiCard
        label="Devueltos"
        value={data.devueltos.toLocaleString('es-CO')}
        icon={RotateCcw}
        tone="danger"
        hint={devolHint}
        trendPct={m.tasaDevolucionMadura ?? undefined}
        inverseTrend
        mutedTrend={m.inmaduro}
      />
      <KpiCard
        label="Valor entregado"
        value={formatCOP(data.valor_entregado)}
        valueClass="text-base sm:text-lg"
        icon={DollarSign}
        tone="accent"
        hint={`Perdido: ${formatCOP(data.valor_perdido)}`}
        hintTone="danger"
      />
    </div>
  );
});

type Tone = 'info' | 'success' | 'danger' | 'accent';

interface KpiCardProps {
  label: string;
  value: string;
  valueClass?: string;
  icon: typeof Package;
  tone: Tone;
  hint: string;
  hintTone?: 'neutral' | 'danger';
  trendPct?: number;
  inverseTrend?: boolean;
  /** Cohorte inmaduro (% concluido bajo el umbral): el chip de tasa se muestra
   *  en gris para no leer como definitivo. */
  mutedTrend?: boolean;
}

const TONE_CARD: Record<Tone, string> = {
  info:    'border-info/30 bg-gradient-to-br from-info/8 via-info/3 to-transparent',
  success: 'border-success/30 bg-gradient-to-br from-success/8 via-success/3 to-transparent',
  danger:  'border-danger/30 bg-gradient-to-br from-danger/8 via-danger/3 to-transparent',
  accent:  'border-accent/30 bg-gradient-to-br from-accent/10 via-accent/3 to-transparent',
};

const TONE_ICON: Record<Tone, { bg: string; ring: string; color: string }> = {
  info:    { bg: 'bg-info/15',    ring: 'border-info/40',    color: 'text-info' },
  success: { bg: 'bg-success/15', ring: 'border-success/40', color: 'text-success' },
  danger:  { bg: 'bg-danger/15',  ring: 'border-danger/40',  color: 'text-danger' },
  accent:  { bg: 'bg-accent/15',  ring: 'border-accent/40',  color: 'text-accent' },
};

const TONE_VALUE: Record<Tone, string> = {
  info:    'text-info',
  success: 'text-success',
  danger:  'text-danger',
  accent:  'text-accent',
};

const TONE_TREND: Record<Tone, string> = {
  info:    'bg-info/12 text-info',
  success: 'bg-success/12 text-success',
  danger:  'bg-danger/12 text-danger',
  accent:  'bg-accent/12 text-accent',
};

function KpiCard({ label, value, valueClass, icon: Icon, tone, hint, hintTone, trendPct, inverseTrend, mutedTrend }: KpiCardProps) {
  const showTrend = trendPct !== undefined;
  const arrow = inverseTrend ? '↓' : '↑';

  return (
    <article className={`rounded-2xl border-2 p-4 transition-colors flex flex-col justify-between min-h-[140px] ${TONE_CARD[tone]}`}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-[10px] uppercase tracking-[0.12em] font-bold text-muted-foreground leading-tight">
          {label}
        </span>
        <div className={`h-9 w-9 shrink-0 rounded-lg border flex items-center justify-center ${TONE_ICON[tone].bg} ${TONE_ICON[tone].ring}`}>
          <Icon size={16} className={TONE_ICON[tone].color} aria-hidden="true" strokeWidth={2.25} />
        </div>
      </div>

      <div className={`mt-2 font-extrabold tabular-nums leading-none ${TONE_VALUE[tone]} ${valueClass ?? 'text-2xl sm:text-3xl'}`}>
        {value}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <span className={`text-[11px] tabular-nums truncate ${hintTone === 'danger' ? 'text-danger' : 'text-muted-foreground'}`}>
          {hint}
        </span>
        {showTrend && (
          <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold tabular-nums shrink-0 ${mutedTrend ? 'bg-muted/40 text-muted-foreground' : TONE_TREND[tone]}`}>
            <span aria-hidden="true">{arrow}</span>
            {trendPct.toFixed(0)}%
          </span>
        )}
      </div>
    </article>
  );
}

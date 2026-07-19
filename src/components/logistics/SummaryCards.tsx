import { memo } from 'react';
import { Package, CheckCircle2, RotateCcw, DollarSign } from 'lucide-react';
import { formatCOP } from '@/lib/utils';
import type { LogisticsSummary } from '@/lib/logistics.types';

interface Props {
  data: LogisticsSummary | null;
}

// Industry benchmark: 70% delivery rate es el target sano para COD
// en Colombia (datos Dropi promedio). Lo dibujamos como target line
// en el bullet chart para dar contexto inmediato — admin ve si está
// arriba o debajo del benchmark sin pensar.
const DELIVERY_TARGET_PCT = 70;
// Devolución sana: ≤15%. Por encima ya es señal de alerta.
const RETURN_TARGET_PCT = 15;

export default memo(function SummaryCards({ data }: Props) {
  if (!data) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="h-[132px] rounded-2xl border border-border bg-card/40 shadow-card3d hairline-top skeleton-shimmer" />
        ))}
      </div>
    );
  }

  const tasaEntrega = data.tasa_entrega ?? 0;
  const tasaDevolucion = data.tasa_devolucion ?? 0;
  const valorTotal = (data.valor_entregado ?? 0) + (data.valor_perdido ?? 0);
  const pctValor = valorTotal > 0 ? ((data.valor_entregado ?? 0) / valorTotal) * 100 : 0;

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" aria-label="Resumen logístico">
      <KpiCard
        label="Total envíos"
        icon={Package}
        value={data.total_pedidos.toLocaleString('es-CO')}
        hint="Excluye cancelados"
        tone="neutral"
      />

      <KpiCard
        label="Entregados"
        icon={CheckCircle2}
        value={data.entregados.toLocaleString('es-CO')}
        hint={`${tasaEntrega.toFixed(1)}% de tasa`}
        tone="success"
        bullet={{
          value: tasaEntrega,
          target: DELIVERY_TARGET_PCT,
          targetLabel: 'Meta 70%',
        }}
      />

      <KpiCard
        label="Devueltos"
        icon={RotateCcw}
        value={data.devueltos.toLocaleString('es-CO')}
        hint={`${tasaDevolucion.toFixed(1)}% de tasa`}
        tone="danger"
        bullet={{
          value: tasaDevolucion,
          target: RETURN_TARGET_PCT,
          targetLabel: 'Tope 15%',
          inverse: true,
        }}
      />

      <KpiCard
        label="Valor entregado"
        icon={DollarSign}
        value={formatCOP(data.valor_entregado)}
        valueClassName="text-xl"
        hint={`Perdido: ${formatCOP(data.valor_perdido)}`}
        hintTone="danger"
        tone="accent"
        bullet={{
          value: pctValor,
          target: 85,
          targetLabel: 'Meta 85%',
        }}
      />
    </div>
  );
});

interface KpiCardProps {
  label: string;
  icon: typeof Package;
  value: string;
  valueClassName?: string;
  hint: string;
  hintTone?: 'neutral' | 'danger';
  tone: 'neutral' | 'success' | 'danger' | 'accent';
  bullet?: {
    value: number;          // 0-100
    target: number;         // 0-100
    targetLabel: string;
    inverse?: boolean;      // true = lower is better (devoluciones)
  };
}

function KpiCard({ label, icon: Icon, value, valueClassName, hint, hintTone, tone, bullet }: KpiCardProps) {
  // Sin gradientes pesados — el diseño profesional usa borde tonal
  // sutil + indicador lateral estrecho (2px) para identificar el
  // tipo de métrica sin saturar.
  const toneStyles = {
    neutral: {
      border: 'border-border',
      indicator: 'bg-foreground/15',
      icon: 'text-muted-foreground',
      iconBg: 'bg-muted/40',
    },
    success: {
      border: 'border-[hsl(var(--success)/0.30)]',
      indicator: 'bg-[hsl(var(--success))]',
      icon: 'text-[hsl(var(--success))]',
      iconBg: 'bg-[hsl(var(--success)/0.12)]',
    },
    danger: {
      border: 'border-[hsl(var(--danger)/0.30)]',
      indicator: 'bg-[hsl(var(--danger))]',
      icon: 'text-[hsl(var(--danger))]',
      iconBg: 'bg-[hsl(var(--danger)/0.12)]',
    },
    accent: {
      border: 'border-[hsl(var(--accent)/0.30)]',
      indicator: 'bg-[hsl(var(--accent))]',
      icon: 'text-[hsl(var(--accent))]',
      iconBg: 'bg-[hsl(var(--accent)/0.12)]',
    },
  }[tone];

  // Color del fill del bullet — semáforo vs target. Para métricas
  // normales: success si ≥ target, warning si <. Para inversas
  // (devoluciones): success si ≤ target, danger si >.
  const bulletFillColor = bullet
    ? (() => {
        const meets = bullet.inverse
          ? bullet.value <= bullet.target
          : bullet.value >= bullet.target;
        if (meets) return 'hsl(var(--success))';
        if (bullet.inverse) return 'hsl(var(--danger))';
        return 'hsl(var(--warning))';
      })()
    : null;

  const targetPosition = bullet ? Math.min(100, Math.max(0, bullet.target)) : 0;
  const fillWidth = bullet ? Math.min(100, Math.max(0, bullet.value)) : 0;

  return (
    <article className={`relative overflow-hidden rounded-2xl border ${toneStyles.border} bg-card/40 shadow-card3d hairline-top transition-colors hover:border-border-strong`}>
      <div className={`absolute inset-y-0 left-0 w-[2px] ${toneStyles.indicator}`} aria-hidden="true" />

      <div className="p-4 pl-[18px]">
        <div className="flex items-center gap-2 mb-2.5">
          <div className={`flex h-7 w-7 items-center justify-center rounded-md ${toneStyles.iconBg}`}>
            <Icon size={13} className={toneStyles.icon} aria-hidden="true" strokeWidth={2.25} />
          </div>
          <span className="text-[11px] uppercase tracking-[0.08em] font-semibold text-muted-foreground">
            {label}
          </span>
        </div>

        <div className={`font-mono font-bold text-foreground tabular-nums leading-none ${valueClassName ?? 'text-3xl'}`}>
          {value}
        </div>

        {bullet && (
          <div className="mt-3.5">
            <div className="bullet" role="img" aria-label={`${bullet.value.toFixed(1)}% vs meta ${bullet.target}%`}>
              <div
                className="bullet-fill"
                style={{
                  width: `${fillWidth}%`,
                  background: bulletFillColor!,
                }}
                aria-hidden="true"
              />
              <div
                className="bullet-target"
                style={{ left: `${targetPosition}%` }}
                aria-hidden="true"
                title={bullet.targetLabel}
              />
            </div>
            <div className="flex items-center justify-between mt-1.5 text-[10px] tabular-nums">
              <span className={`${hintTone === 'danger' ? 'text-[hsl(var(--danger))]' : 'text-muted-foreground'} font-medium`}>
                {hint}
              </span>
              <span className="text-muted-foreground/70">{bullet.targetLabel}</span>
            </div>
          </div>
        )}

        {!bullet && (
          <div className={`mt-2 text-[11px] ${hintTone === 'danger' ? 'text-[hsl(var(--danger))]' : 'text-muted-foreground'} tabular-nums`}>
            {hint}
          </div>
        )}
      </div>
    </article>
  );
}

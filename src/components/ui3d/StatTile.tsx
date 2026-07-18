import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import TiltCard from './TiltCard';
import CountUp from './CountUp';
import Sparkline from './Sparkline';

export type StatTone = 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';

/** Clases por tono. Todo sale de tokens para que el light mode siga válido. */
const TONE: Record<StatTone, { chip: string; text: string; stroke: string; glow: string }> = {
  accent:  { chip: 'bg-accent/14 border-accent/30 text-accent',       text: 'text-accent',     stroke: 'hsl(var(--accent))',           glow: 'glow-accent' },
  success: { chip: 'bg-success/14 border-success/30 text-success',    text: 'text-success',    stroke: 'hsl(var(--success))',          glow: 'glow-success' },
  warning: { chip: 'bg-warning/14 border-warning/30 text-warning',    text: 'text-warning',    stroke: 'hsl(var(--warning))',          glow: 'glow-warning' },
  danger:  { chip: 'bg-danger/14 border-danger/30 text-danger',       text: 'text-danger',     stroke: 'hsl(var(--danger))',           glow: 'glow-danger' },
  info:    { chip: 'bg-info/14 border-info/30 text-info',             text: 'text-info',       stroke: 'hsl(var(--info))',             glow: 'glow-info' },
  neutral: { chip: 'bg-muted/60 border-border text-muted-foreground', text: 'text-foreground', stroke: 'hsl(var(--muted-foreground))', glow: '' },
};

interface StatTileProps {
  icon: LucideIcon;
  label: string;
  value: number;
  tone: StatTone;
  /** Serie para la línea de tendencia. Con menos de 2 puntos no se dibuja. */
  spark?: number[];
  /** Texto o badge bajo la cifra (ej. "12 pendientes" o un <TrendBadge/>). */
  extra?: ReactNode;
  /** Tooltip explicativo — conservar los que ya existen en las pantallas. */
  title?: string;
  /** Clases del contenedor externo (ej. col-span del grid). */
  wrapperClassName?: string;
  duration?: number;
}

/**
 * Tarjeta de KPI: chip con ícono, cifra grande contando, etiqueta HUD y
 * sparkline. Las capas van a distinta profundidad para el efecto 3D.
 *
 * Cuando el valor es 0 se atenúa, igual que hacía el Dashboard antes del
 * rediseño: un cero apagado se lee distinto de un dato real. Presentación pura.
 */
export default function StatTile({
  icon: Icon, label, value, tone, spark = [], extra, title,
  wrapperClassName = '', duration = 1100,
}: StatTileProps) {
  const t = TONE[tone];
  const isZero = value === 0;

  return (
    <TiltCard
      perspective={1200}
      wrapperClassName={wrapperClassName}
      className={[
        'rounded-2xl p-4 h-full flex flex-col justify-between shadow-card3d',
        'bg-card/40 border',
        isZero ? 'border-border/50 opacity-75' : 'border-border',
      ].join(' ')}
    >
      {/* Anatomía del handoff: chip + delta arriba · cifra · rótulo ·
          sparkline ancho abajo. Antes el sparkline iba arriba encajonado en
          80px y el delta al pie: la línea de tendencia quedaba ilegible y el
          delta perdía el lugar de lectura que le da el mockup. */}
      <div title={title}>
        <div className="flex items-start justify-between gap-2 tilt-layer-2">
          <span className={`w-9 h-9 rounded-xl border flex items-center justify-center flex-shrink-0 ${t.chip} ${t.glow}`}>
            <Icon size={17} aria-hidden="true" />
          </span>
          {extra && <div className="text-right min-w-0">{extra}</div>}
        </div>

        <div className={`text-[34px] font-bold leading-none mt-3 tilt-layer-3 ${isZero ? 'text-muted-foreground' : t.text}`}>
          <CountUp value={value} duration={duration} />
        </div>

        <div className="hud-label text-subtle mt-2 tilt-layer-1">{label}</div>

        {spark.length > 1 && (
          <div className="mt-2 tilt-layer-1">
            <Sparkline data={spark} color={t.stroke} height={26} />
          </div>
        )}
      </div>
    </TiltCard>
  );
}

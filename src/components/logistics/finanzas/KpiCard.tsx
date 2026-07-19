import type { ElementType } from 'react';
import { TiltCard } from '@/components/ui3d';

export type KpiTone = 'success' | 'danger' | 'info' | 'warning' | 'neutral' | 'accent';

/**
 * Mapa de tonos del lenguaje del Dashboard (copiado de ui3d/StatTile): chip
 * tintado /14 con borde /30 y texto pleno, más la clase de glow ya calibrada
 * por tema. Los alphas NO se improvisan: son los mismos de StatTile para que
 * un KPI de Finanzas y uno del Dashboard se lean como el mismo componente.
 */
const TONE: Record<KpiTone, { chip: string; text: string; glow: string }> = {
  success: { chip: 'bg-success/14 border-success/30 text-success',    text: 'text-success',    glow: 'glow-success' },
  danger:  { chip: 'bg-danger/14 border-danger/30 text-danger',       text: 'text-danger',     glow: 'glow-danger' },
  info:    { chip: 'bg-info/14 border-info/30 text-info',             text: 'text-info',       glow: 'glow-info' },
  warning: { chip: 'bg-warning/14 border-warning/30 text-warning',    text: 'text-warning',    glow: 'glow-warning' },
  accent:  { chip: 'bg-accent/14 border-accent/30 text-accent',       text: 'text-accent',     glow: 'glow-accent' },
  neutral: { chip: 'bg-muted/60 border-border text-muted-foreground', text: 'text-foreground', glow: '' },
};

export interface KpiCardProps {
  label: string;
  /** Valor YA formateado por quien llama (formatCOP, '38.5%', '—'). */
  value: string;
  icon: ElementType;
  tone: KpiTone;
  hint?: string;
  size?: 'sm' | 'md' | 'lg';
}

/**
 * Tarjeta KPI del módulo Logística/Finanzas, en el lenguaje visual del
 * Dashboard: TiltCard con inclinación 3D, chip de ícono de 36px con glow, la
 * cifra en mono+tabular y el rótulo DEBAJO en `hud-label`.
 *
 * Sigue siendo PRESENTACIÓN PURA y sigue recibiendo `value: string`. Esa es su
 * virtud y el motivo de no fusionarla con StatTile: toda la decisión de mostrar
 * '—' vive en los call-sites (MesActualResumen, FinanzasTab,
 * SimuladorUnitEconomics). Si el contrato forzara `value: number`, las decenas
 * de '—' del módulo se volverían ceros con color — un dato ausente disfrazado
 * de medición. Por el mismo motivo NO se anima con CountUp: la cifra llega como
 * texto ya formateado y animarla obligaría a reparsearla.
 *
 * Lo único que la tarjeta deduce por su cuenta es el caso sin-dato ('—'), y
 * solo para ATENUARSE — mismo criterio que StatTile con value===0: un hueco
 * apagado se lee distinto de una medición real. No cambia el valor ni el tono
 * que decidió quien llama.
 */
export default function KpiCard({
  label, value, icon: Icon, tone, hint, size = 'md',
}: KpiCardProps) {
  const t = TONE[tone];
  const sinDato = value === '—';

  const valueSize =
    size === 'lg' ? 'text-[30px] sm:text-[34px]' :
    size === 'sm' ? 'text-lg' :
    'text-2xl sm:text-[26px]';

  return (
    <TiltCard
      perspective={1200}
      className={[
        'rounded-2xl p-4 h-full flex flex-col shadow-card3d bg-card/40 border',
        'transition-colors duration-200 hover:border-border-strong',
        sinDato ? 'border-border/50 opacity-75' : 'border-border',
      ].join(' ')}
    >
      <div className="flex items-start justify-between gap-2 tilt-layer-2">
        <span
          className={`w-9 h-9 rounded-xl border flex items-center justify-center flex-shrink-0 ${t.chip} ${t.glow}`}
        >
          <Icon size={17} aria-hidden="true" />
        </span>
      </div>

      {/* La cifra manda y el rótulo va DEBAJO — regla del lenguaje del
          Dashboard. Antes el rótulo iba arriba y la cifra quedaba de pie de
          página de su propia tarjeta. */}
      <div
        className={`mt-3 font-mono tabular-nums font-bold leading-none tilt-layer-3 ${valueSize} ${
          sinDato ? 'text-muted-foreground' : t.text
        }`}
      >
        {value}
      </div>

      <div className="hud-label text-subtle mt-2 tilt-layer-1">{label}</div>

      {hint && (
        <div className="mt-2 text-[11px] text-muted-foreground leading-snug tilt-layer-1">{hint}</div>
      )}
    </TiltCard>
  );
}

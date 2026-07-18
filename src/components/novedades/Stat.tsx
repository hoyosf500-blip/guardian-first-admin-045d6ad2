import { ReactNode } from 'react';
import { TiltCard } from '@/components/ui3d';

export type StatTone = 'default' | 'danger' | 'success' | 'warning' | 'info';

/** KPI card compacta con barra lateral de color por tono. Compartida por los
 *  tableros de /novedades (Seguimiento y Puntos de mejora). */
export function Stat({
  icon, label, value, hint, tone = 'default',
}: {
  icon?: ReactNode; label: string; value: string | number; hint?: string; tone?: StatTone;
}) {
  const chip = {
    default: 'bg-muted/60 border-border text-muted-foreground',
    danger: 'bg-danger/14 border-danger/30 text-danger glow-danger',
    success: 'bg-success/14 border-success/30 text-success glow-success',
    warning: 'bg-warning/14 border-warning/30 text-warning glow-warning',
    info: 'bg-info/14 border-info/30 text-info glow-info',
  }[tone];
  const valColor = {
    default: 'text-foreground', danger: 'text-danger', success: 'text-success',
    warning: 'text-warning', info: 'text-info',
  }[tone];
  return (
    <TiltCard perspective={1200} className="bg-card/40 border border-border rounded-2xl p-4 h-full shadow-card3d">
      {icon && (
        <span className={`w-9 h-9 rounded-xl border flex items-center justify-center tilt-layer-2 ${chip}`} aria-hidden="true">
          {icon}
        </span>
      )}
      <div className={`font-mono text-[28px] font-bold leading-none tabular-nums mt-3 tilt-layer-3 ${valColor}`}>{value}</div>
      <div className="hud-label mt-2 tilt-layer-1">{label}</div>
      {hint && <div className="text-[10px] text-muted-foreground mt-1 tilt-layer-1">{hint}</div>}
    </TiltCard>
  );
}

import { ReactNode } from 'react';

export type StatTone = 'default' | 'danger' | 'success' | 'warning' | 'info';

/** KPI card compacta con barra lateral de color por tono. Compartida por los
 *  tableros de /novedades (Seguimiento y Puntos de mejora). */
export function Stat({
  icon, label, value, hint, tone = 'default',
}: {
  icon?: ReactNode; label: string; value: string | number; hint?: string; tone?: StatTone;
}) {
  const bar = {
    default: 'bg-muted-foreground/40', danger: 'bg-danger', success: 'bg-success',
    warning: 'bg-warning', info: 'bg-info',
  }[tone];
  const valColor = {
    default: 'text-foreground', danger: 'text-danger', success: 'text-success',
    warning: 'text-warning', info: 'text-info',
  }[tone];
  return (
    <div className="relative overflow-hidden bg-card rounded-xl border border-border p-4 shadow-ds-xs">
      <span className={`absolute left-0 top-0 bottom-0 w-[3px] ${bar}`} aria-hidden="true" />
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1.5">
        {icon} {label}
      </div>
      <div className={`font-mono text-2xl font-bold tabular-nums ${valColor}`}>{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground mt-0.5">{hint}</div>}
    </div>
  );
}

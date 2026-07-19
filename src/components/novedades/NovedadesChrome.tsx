// Piezas visuales compartidas por el área /novedades (tab, puntos de mejora,
// causa raíz). Mismo lenguaje que el Dashboard/Logística: card con hairline,
// barras con degradado + glow, leyenda de swatch cuadrado y pastillas de rango
// accesibles (role=group + aria-pressed).
//
// Presentación pura: nada de acá calcula ni transforma métricas. Cuando un
// valor puede no existir, el componente recibe `null` y NO dibuja barra — un
// "sin dato" no se puede aplastar a 0 para que el gráfico se vea lleno.

import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Info } from 'lucide-react';
import { ring, barGradient } from '@/components/novedades/chromeTokens';

/**
 * Shell de card del área. Sin TiltCard a propósito en las que llevan recharts:
 * TiltCard aplica overflow-hidden y recortaría los tooltips.
 */
export function NovCard({
  title, icon: Icon, iconClass = 'text-accent', note, right, children, className = '',
}: {
  title: string;
  icon: LucideIcon;
  iconClass?: string;
  /** Aclaración corta al lado del título (texto ya existente en pantalla). */
  note?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`hairline-top bg-card/40 border border-border rounded-2xl p-5 shadow-card3d transition-colors duration-200 hover:border-border-strong h-full flex flex-col ${className}`}
    >
      <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2 min-w-0">
          <Icon size={14} className={iconClass} aria-hidden="true" />
          <span className="truncate">{title}</span>
          {note && <span className="text-[10px] font-normal text-muted-foreground">{note}</span>}
        </h3>
        {right}
      </div>
      {children}
    </section>
  );
}

/** Leyenda manual: swatch cuadrado de 10px (nunca círculos) + rótulo. */
export function SwatchLegend({
  items, className = '',
}: {
  items: { color: string; label: string }[];
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-3 flex-wrap ${className}`}>
      {items.map(l => (
        <span key={l.label} className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: l.color }} aria-hidden="true" />
          {l.label}
        </span>
      ))}
    </div>
  );
}

/**
 * Fila de ranking con barra proporcional: punto con aro, nombre, cifra a la
 * derecha y barra con degradado + glow.
 *
 * `pct === null` = no hay proporción medida → se dibuja la pista vacía, nunca
 * una barra al 0% que se leería como "medimos y dio cero".
 */
export function MetricBar({
  label, right, pct, color, dotTitle, rank, labelClassName = 'text-foreground',
}: {
  label: string;
  right: ReactNode;
  /** 0-100, o null si no hay dato con qué llenar la barra. */
  pct: number | null;
  color: string;
  dotTitle?: string;
  rank?: number;
  /** Clases del rótulo — algunas listas distinguen filas sin dueño real. */
  labelClassName?: string;
}) {
  const width = pct == null ? null : Math.max(0, Math.min(100, pct));
  return (
    <li className="flex flex-col gap-1.5 px-3 py-2 rounded-xl border border-transparent transition-colors duration-200 hover:bg-card/60 hover:border-border">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="flex items-center gap-2 min-w-0">
          {rank != null && (
            <span className="font-mono tabular-nums text-[11px] text-muted-foreground w-4 shrink-0">{rank}</span>
          )}
          <span
            className="h-2.5 w-2.5 rounded-full shrink-0"
            style={{ background: color, boxShadow: `0 0 0 3px ${ring(color)}` }}
            title={dotTitle}
            aria-hidden={dotTitle ? undefined : 'true'}
          />
          <span className={`font-medium truncate ${labelClassName}`}>{label}</span>
        </span>
        <span className="shrink-0 ml-2 font-mono tabular-nums">{right}</span>
      </div>
      <div className="h-1.5 rounded-full bg-foreground/10 overflow-hidden">
        {width != null && (
          <div
            className="h-full rounded-full transition-[width] duration-700"
            style={{ width: `${width}%`, background: barGradient(color), boxShadow: `0 0 8px ${ring(color, 0.45)}` }}
          />
        )}
      </div>
    </li>
  );
}

/**
 * Pastillas de rango. Segmented control del Dashboard: `role="group"` +
 * `aria-pressed` en cada botón, para que un lector de pantalla anuncie cuál
 * está activo (antes eran cuatro botones idénticos) y para que el estado no
 * dependa solo del color — el activo suma un punto visible.
 */
export function RangePills<T extends string>({
  items, value, onChange, ariaLabel,
}: {
  items: { key: T; label: string }[];
  value: T;
  onChange: (k: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex flex-wrap gap-[2px] p-[3px] rounded-xl bg-card/40 border border-border"
    >
      {items.map(r => {
        const active = value === r.key;
        return (
          <button
            key={r.key}
            type="button"
            onClick={() => onChange(r.key)}
            aria-pressed={active}
            className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-[9px] text-sm transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ${
              active
                ? 'font-semibold bg-accent/16 border border-accent/40 text-accent shadow-glow3d'
                : 'font-medium border border-transparent text-muted-foreground hover:text-foreground hover:bg-muted'
            }`}
          >
            {active && <span className="w-1.5 h-1.5 rounded-full bg-current" aria-hidden="true" />}
            {r.label}
          </button>
        );
      })}
    </div>
  );
}

/** Card vacía / de estado, con el chip de ícono del DS. */
export function EmptyCard({ msg }: { msg: string }) {
  return (
    <div className="hairline-top bg-card/40 rounded-2xl border border-border p-10 shadow-card3d flex flex-col items-center justify-center gap-3 text-center">
      <span className="w-9 h-9 rounded-xl border border-border bg-muted/60 flex items-center justify-center text-muted-foreground" aria-hidden="true">
        <Info size={17} />
      </span>
      <p className="text-sm text-muted-foreground">{msg}</p>
    </div>
  );
}

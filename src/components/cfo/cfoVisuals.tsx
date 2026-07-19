import { Info } from 'lucide-react';
import { ringOf, splitCurrency } from './cfoChartTokens';

// ─────────────────────────────────────────────────────────────────
// Piezas visuales compartidas del módulo /cfo — mismo lenguaje que
// DashboardTab y LogisticaTab (degradado vertical en las barras, glow en
// el trazo, swatch cuadrado en las leyendas).
//
// Los colores y helpers viven en `cfoChartTokens.ts`; acá van sólo
// componentes. PRESENTACIÓN PURA: nada de esto calcula ni formatea un
// número de negocio — recibe lo ya calculado y decide cómo se dibuja.
// ─────────────────────────────────────────────────────────────────

/**
 * Degradado vertical para una barra (pleno arriba → apagado en la base).
 * Los ids de <defs> son GLOBALES al documento: si dos charts de la misma
 * pantalla usan el mismo id, el segundo pisa al primero. De ahí el `prefix`.
 */
export function BarGradientDefs({
  prefix, entries,
}: { prefix: string; entries: { key: string; color: string }[] }) {
  return (
    <defs>
      {entries.map(e => (
        <linearGradient key={e.key} id={`${prefix}-${e.key}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={e.color} stopOpacity={0.95} />
          <stop offset="100%" stopColor={e.color} stopOpacity={0.5} />
        </linearGradient>
      ))}
    </defs>
  );
}

/** Leyenda manual: swatch cuadrado de 10px (nunca círculos) + rótulo. */
export function SwatchLegend({
  items, className = '',
}: { items: { color: string; label: string }[]; className?: string }) {
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

/** Estado vacío de un gráfico — mismo molde que /logistica. */
export function EmptyChart({
  msg, height = 220,
}: { msg: string; height?: number }) {
  return (
    <div
      className="flex flex-col items-center justify-center text-muted-foreground gap-3"
      style={{ height }}
    >
      <span className="w-9 h-9 rounded-xl border border-border bg-muted/60 flex items-center justify-center" aria-hidden="true">
        <Info size={17} />
      </span>
      <p className="text-sm text-center px-4">{msg}</p>
    </div>
  );
}

/**
 * Cifra de plata: símbolo chico + número grande en mono tabular.
 * Recibe el string YA formateado — no toca el valor.
 */
export function MoneyFigure({
  text, className = '', symbolClassName = '',
}: { text: string; className?: string; symbolClassName?: string }) {
  const { symbol, rest } = splitCurrency(text);
  return (
    <span className={`font-mono tabular-nums ${className}`}>
      {symbol && (
        <span className={`text-[0.6em] font-semibold mr-1.5 align-baseline opacity-80 ${symbolClassName}`}>
          {symbol}
        </span>
      )}
      {rest}
    </span>
  );
}

/**
 * Barra proporcional con degradado + glow. Reemplaza a las barras planas
 * `bg-{tone}` que había repartidas por el módulo.
 *
 * `pct` ya viene calculado por quien llama (0-100); acá sólo se recorta al
 * rango pintable para que un valor fuera de rango no desborde la pista.
 */
export function GradientBar({
  pct, color, height = 6, glow = true, className = '', title,
}: {
  pct: number;
  color: string;
  height?: number;
  glow?: boolean;
  className?: string;
  title?: string;
}) {
  const w = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  return (
    <div
      className={`rounded-full bg-foreground/10 overflow-hidden ${className}`}
      style={{ height }}
      title={title}
    >
      <div
        className="h-full rounded-full transition-[width] duration-700"
        style={{
          width: `${w}%`,
          background: `linear-gradient(90deg, ${ringOf(color, 0.55)}, ${color})`,
          boxShadow: glow && w > 0 ? `0 0 10px -2px ${color}` : undefined,
        }}
      />
    </div>
  );
}

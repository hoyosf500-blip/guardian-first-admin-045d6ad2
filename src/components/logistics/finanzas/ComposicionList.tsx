import type { ElementType } from 'react';
import { formatCOP } from '@/lib/utils';
import { TiltCard } from '@/components/ui3d';

export interface ComposicionItem {
  label: string;
  value: number;
  color: string;       // hsl(var(--token)) o hex
  sublabel?: string;   // opcional: ej "$25.000 c/u" o "5 movimientos"
}

interface ComposicionListProps {
  title: string;
  total: number;
  items: ComposicionItem[];
  totalLabel?: string;
  totalTone?: 'success' | 'danger' | 'neutral';
  icon?: ElementType;
  isLoading?: boolean;
  emptyMessage?: string;
}

const TONE_TEXT: Record<NonNullable<ComposicionListProps['totalTone']>, string> = {
  success: 'text-success num-glow-success',
  danger:  'text-danger num-glow-danger',
  neutral: 'text-foreground',
};

const TONE_CHIP: Record<NonNullable<ComposicionListProps['totalTone']>, string> = {
  success: 'bg-success/14 border-success/30 text-success glow-success',
  danger:  'bg-danger/14 border-danger/30 text-danger glow-danger',
  neutral: 'bg-muted/60 border-border text-muted-foreground',
};

export default function ComposicionList({
  title, total, items,
  totalLabel = 'Total', totalTone = 'neutral',
  icon: Icon, isLoading = false,
  emptyMessage = 'Sin datos en este rango',
}: ComposicionListProps) {
  if (isLoading) {
    return <div className="rounded-2xl border border-border bg-card/40 shadow-card3d hairline-top animate-pulse h-[340px]" />;
  }

  // Filtramos los <=0 (ruido visual) y ordenamos desc por value.
  // OJO: por este filtro la suma de los ítems VISIBLES puede no dar el `total`
  // de arriba — un concepto en cero desaparece en vez de listarse como $0 (por
  // eso una tienda sin referidos no ve "Comisión referidos").
  const sorted = items.filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
  const max = sorted[0]?.value ?? 1;

  return (
    <TiltCard className="bg-card/40 border border-border rounded-2xl p-5 shadow-card3d h-full flex flex-col transition-colors duration-200 hover:border-border-strong">
      <div className="flex items-start justify-between gap-3 mb-4 tilt-layer-1">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2 min-w-0">
          {Icon && (
            <span className={`w-9 h-9 rounded-xl border flex items-center justify-center flex-shrink-0 ${TONE_CHIP[totalTone]}`}>
              <Icon size={17} aria-hidden="true" />
            </span>
          )}
          <span className="truncate">{title}</span>
        </h3>
        <div className="text-right shrink-0">
          <div className={`font-mono tabular-nums text-lg font-bold leading-none ${TONE_TEXT[totalTone]}`}>
            {formatCOP(total)}
          </div>
          <div className="hud-label text-subtle mt-1.5">
            {totalLabel}
          </div>
        </div>
      </div>

      {sorted.length === 0 ? (
        <div className="flex items-center justify-center h-[200px] text-xs text-muted-foreground">
          {emptyMessage}
        </div>
      ) : (
        <ul className="space-y-2 tilt-layer-2">
          {sorted.map(({ label, value, color, sublabel }) => {
            // El piso de 2% es visual: sin él un concepto minúsculo no dibujaría
            // barra. El ancho NO es fiel para ítems muy chicos — el % de al lado
            // sí lo es, y es el que hay que leer.
            const widthPct = Math.max(2, (value / max) * 100);
            const sharePct = total > 0 ? (value / total) * 100 : 0;
            return (
              <li
                key={label}
                className="-mx-2 px-2 py-1.5 rounded-lg hover:bg-card/60 transition-colors duration-200"
              >
                <div className="flex items-baseline justify-between gap-3 mb-1.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="h-2.5 w-2.5 rounded-[3px] shrink-0"
                      style={{ background: color }}
                      aria-hidden="true"
                    />
                    <span className="text-xs font-medium text-foreground truncate">{label}</span>
                    {sublabel && (
                      <span className="text-[10px] text-muted-foreground truncate">· {sublabel}</span>
                    )}
                  </div>
                  <div className="flex items-baseline gap-2 shrink-0">
                    <span className="font-mono tabular-nums text-xs font-semibold text-foreground">
                      {formatCOP(value)}
                    </span>
                    <span className="font-mono tabular-nums text-[10px] text-muted-foreground w-11 text-right">
                      {sharePct.toFixed(1)}%
                    </span>
                  </div>
                </div>
                {/* Antes: pista bg-muted/40 y relleno de color PLANO. Ahora la
                    pista es foreground/10 (la del lenguaje) y el relleno lleva
                    degradado + glow del propio color del concepto. */}
                <div className="h-1.5 rounded-full bg-foreground/10 overflow-hidden">
                  <div
                    className="h-full rounded-full transition-[width] duration-700"
                    style={{
                      width: `${widthPct}%`,
                      // Degradado del PROPIO color del concepto, no una cola
                      // cian igual para todos: la barra codifica DE QUÉ CONCEPTO
                      // se habla, y terminarlas todas en cian hacía que
                      // "Markup dropshipper" y "Comisión referidos" acabaran del
                      // mismo color, rompiendo la clave que da el swatch.
                      background: `linear-gradient(90deg, ${color} 0%, ${color} 60%, color-mix(in srgb, ${color} 55%, transparent) 100%)`,
                      filter: `drop-shadow(0 0 4px ${color})`,
                    }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </TiltCard>
  );
}

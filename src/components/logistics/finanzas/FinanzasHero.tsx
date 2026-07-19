import { TrendingUp, TrendingDown, DollarSign, Target } from 'lucide-react';
import { formatCOP } from '@/lib/utils';

interface FinanzasHeroProps {
  gananciaNeta: number;
  totalEntradas: number;
  totalSalidas: number;
  ingresosBrutos: number;
  totalEntregadas: number;
  /** null = margen indefinido (sin denominador). Se pinta '—' en tono neutro,
   *  nunca 0.0% en rojo — mismo criterio que `utilidad_neta` en CfoTab. */
  margenPct: number | null;
  /** true = el valor es el operativo por cohorte (real); false = caja del wallet
   *  por fecha de pago (mezcla meses). Cambia el subtítulo y la microcopy. */
  cohorte?: boolean;
  isLoading?: boolean;
}

export default function FinanzasHero({
  gananciaNeta, totalEntradas, totalSalidas,
  ingresosBrutos, totalEntregadas, margenPct,
  cohorte = false,
  isLoading = false,
}: FinanzasHeroProps) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="rounded-2xl border-2 border-border bg-card/40 shadow-card3d animate-pulse h-[148px]" />
        ))}
      </div>
    );
  }

  const isPositive = gananciaNeta >= 0;
  // Sin ingresos brutos no hay denominador: el margen es INDEFINIDO, no 0%.
  // Antes llegaba como 0 y se pintaba "0.0%" en ROJO junto a "Sano: ≥30%" — un
  // dato ausente disfrazado de mal resultado. Los umbrales NO cambian; lo único
  // que cambia es que solo se evalúan cuando hay valor de verdad.
  const margenValue =
    margenPct == null || !Number.isFinite(margenPct) || ingresosBrutos <= 0
      ? null
      : margenPct;
  const margenTone =
    margenValue == null ? 'neutral' :
    margenValue >= 30 ? 'success' :
    margenValue >= 15 ? 'warning' :
    'danger';

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
      {/* Hero principal — Ganancia Neta REAL */}
      <div
        className={`rounded-2xl border-2 p-5 shadow-card3d relative overflow-hidden ${
          isPositive
            ? 'border-success/40 bg-gradient-to-br from-success/8 via-success/3 to-transparent'
            : 'border-danger/40 bg-gradient-to-br from-danger/8 via-danger/3 to-transparent'
        }`}
      >
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] uppercase tracking-[0.12em] font-bold text-muted-foreground">
            Ganancia Neta Dropi {cohorte ? '(cohorte del mes)' : '(caja · fecha de pago)'}
          </span>
          <div className={`h-9 w-9 rounded-lg flex items-center justify-center border ${
            isPositive ? 'bg-success/15 border-success/40' : 'bg-danger/15 border-danger/40'
          }`}>
            {isPositive
              ? <TrendingUp size={16} className="text-success" />
              : <TrendingDown size={16} className="text-danger" />}
          </div>
        </div>
        <div className={`text-3xl sm:text-4xl font-extrabold tabular-nums tracking-tight leading-none ${
          isPositive ? 'text-success' : 'text-danger'
        }`}>
          {formatCOP(gananciaNeta)}
        </div>
        <div className="mt-3 flex items-center gap-3 text-[11px]">
          <span className="inline-flex items-center gap-1 text-success">
            <span className="h-1.5 w-1.5 rounded-full bg-success" />
            <span className="font-semibold tabular-nums">{formatCOP(totalEntradas)}</span>
            <span className="text-muted-foreground">in</span>
          </span>
          <span className="text-muted-foreground/60">·</span>
          <span className="inline-flex items-center gap-1 text-danger">
            <span className="h-1.5 w-1.5 rounded-full bg-danger" />
            <span className="font-semibold tabular-nums">{formatCOP(totalSalidas)}</span>
            <span className="text-muted-foreground">out</span>
          </span>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground leading-snug">
          {cohorte
            ? 'Operativo por cohorte (pedidos creados en el mes): '
            : 'Caja del wallet por fecha de pago (mezcla meses): '}
          entró {formatCOP(totalEntradas)} − te debitó {formatCOP(totalSalidas)}.
        </p>
      </div>

      {/* Ingresos Brutos */}
      <div className="rounded-2xl border-2 border-info/30 bg-gradient-to-br from-info/8 via-info/3 to-transparent p-5 shadow-card3d">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] uppercase tracking-[0.12em] font-bold text-muted-foreground">
            Ingresos Brutos
          </span>
          <div className="h-9 w-9 rounded-lg flex items-center justify-center border bg-info/15 border-info/40">
            <DollarSign size={16} className="text-info" />
          </div>
        </div>
        <div className="text-3xl sm:text-4xl font-extrabold tabular-nums tracking-tight leading-none text-info">
          {formatCOP(ingresosBrutos)}
        </div>
        <div className="mt-3 text-[11px] text-muted-foreground">
          <span className="font-semibold tabular-nums text-foreground">{totalEntregadas}</span> órdenes entregadas en el período
        </div>
      </div>

      {/* Margen Operativo */}
      <div className={`rounded-2xl border-2 p-5 shadow-card3d ${
        margenTone === 'neutral' ? 'border-border bg-card/40' :
        margenTone === 'success' ? 'border-success/30 bg-gradient-to-br from-success/8 via-success/3 to-transparent' :
        margenTone === 'warning' ? 'border-warning/30 bg-gradient-to-br from-warning/8 via-warning/3 to-transparent' :
        'border-danger/30 bg-gradient-to-br from-danger/8 via-danger/3 to-transparent'
      }`}>
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] uppercase tracking-[0.12em] font-bold text-muted-foreground">
            Margen Operativo (indicativo)
          </span>
          <div className={`h-9 w-9 rounded-lg flex items-center justify-center border ${
            margenTone === 'neutral' ? 'bg-muted/30 border-border' :
            margenTone === 'success' ? 'bg-success/15 border-success/40' :
            margenTone === 'warning' ? 'bg-warning/15 border-warning/40' :
            'bg-danger/15 border-danger/40'
          }`}>
            <Target size={16} className={
              margenTone === 'neutral' ? 'text-muted-foreground' :
              margenTone === 'success' ? 'text-success' :
              margenTone === 'warning' ? 'text-warning' :
              'text-danger'
            } />
          </div>
        </div>
        <div className={`text-3xl sm:text-4xl font-extrabold tabular-nums tracking-tight leading-none ${
          margenTone === 'neutral' ? 'text-muted-foreground' :
          margenTone === 'success' ? 'text-success' :
          margenTone === 'warning' ? 'text-warning' :
          'text-danger'
        }`}>
          {margenValue != null ? `${margenValue.toFixed(1)}%` : '—'}
        </div>
        <div className="mt-3 text-[11px] text-muted-foreground leading-snug">
          {margenValue != null ? (
            <>
              Ganancia neta sobre ingresos brutos. <span className="text-foreground/80">Sano: ≥30%</span>
              {/* El calificador que ya llevan las otras dos cards. El numerador y el
                  denominador NO son la misma cohorte, así que el % no es comparable
                  mes a mes con precisión contable — se dice en vez de callarlo. */}
              <span className="block mt-1">
                Cruza cohortes: arriba va {cohorte ? 'por fecha de pedido' : 'por fecha de pago'} y
                los ingresos por entregados del período.
              </span>
            </>
          ) : (
            <>Sin datos: no hay ingresos brutos en el período, así que el margen no se puede calcular.</>
          )}
        </div>
      </div>
    </div>
  );
}

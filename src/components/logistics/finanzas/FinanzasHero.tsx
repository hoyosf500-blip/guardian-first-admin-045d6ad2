import { TrendingUp, TrendingDown, DollarSign, Target } from 'lucide-react';
import { formatCOP } from '@/lib/utils';

interface FinanzasHeroProps {
  gananciaNeta: number;
  totalEntradas: number;
  totalSalidas: number;
  ingresosBrutos: number;
  totalEntregadas: number;
  margenPct: number;
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
          <div key={i} className="rounded-xl border border-border bg-card animate-pulse h-[148px]" />
        ))}
      </div>
    );
  }

  const isPositive = gananciaNeta >= 0;
  const margenTone =
    margenPct >= 30 ? 'success' :
    margenPct >= 15 ? 'warning' :
    'danger';

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
      {/* Hero principal — Ganancia Neta REAL */}
      <div
        className={`rounded-2xl border-2 p-5 relative overflow-hidden ${
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
      <div className="rounded-2xl border-2 border-info/30 bg-gradient-to-br from-info/8 via-info/3 to-transparent p-5">
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
      <div className={`rounded-2xl border-2 p-5 ${
        margenTone === 'success' ? 'border-success/30 bg-gradient-to-br from-success/8 via-success/3 to-transparent' :
        margenTone === 'warning' ? 'border-warning/30 bg-gradient-to-br from-warning/8 via-warning/3 to-transparent' :
        'border-danger/30 bg-gradient-to-br from-danger/8 via-danger/3 to-transparent'
      }`}>
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] uppercase tracking-[0.12em] font-bold text-muted-foreground">
            Margen Operativo
          </span>
          <div className={`h-9 w-9 rounded-lg flex items-center justify-center border ${
            margenTone === 'success' ? 'bg-success/15 border-success/40' :
            margenTone === 'warning' ? 'bg-warning/15 border-warning/40' :
            'bg-danger/15 border-danger/40'
          }`}>
            <Target size={16} className={
              margenTone === 'success' ? 'text-success' :
              margenTone === 'warning' ? 'text-warning' :
              'text-danger'
            } />
          </div>
        </div>
        <div className={`text-3xl sm:text-4xl font-extrabold tabular-nums tracking-tight leading-none ${
          margenTone === 'success' ? 'text-success' :
          margenTone === 'warning' ? 'text-warning' :
          'text-danger'
        }`}>
          {margenPct.toFixed(1)}%
        </div>
        <div className="mt-3 text-[11px] text-muted-foreground leading-snug">
          Ganancia neta sobre ingresos brutos. <span className="text-foreground/80">Sano: ≥30%</span>
        </div>
      </div>
    </div>
  );
}

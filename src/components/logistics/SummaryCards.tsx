import { memo } from 'react';
import { Package, CheckCircle2, RotateCcw, TrendingUp, AlertTriangle } from 'lucide-react';
import { formatCOP } from '@/lib/utils';
import type { LogisticsSummary } from '@/lib/logistics.types';

interface Props {
  data: LogisticsSummary | null;
}

export default memo(function SummaryCards({ data }: Props) {
  if (!data) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="h-32 rounded-xl border border-border bg-card animate-pulse" />
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
      {/* Total envíos — neutral, foco en el número */}
      <article className="relative overflow-hidden rounded-xl border border-border bg-gradient-to-br from-card to-card/50 p-4 transition-colors hover:border-border-strong">
        <div className="flex items-center gap-2 mb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/10 ring-1 ring-blue-500/20">
            <Package size={14} className="text-blue-400" aria-hidden="true" />
          </div>
          <span className="text-xs font-medium text-muted-foreground">Total envíos</span>
        </div>
        <div className="text-3xl font-bold text-foreground tabular-nums leading-none">
          {data.total_pedidos.toLocaleString('es-CO')}
        </div>
        <div className="text-[11px] text-muted-foreground mt-2">Excluye cancelados</div>
      </article>

      {/* Entregados — gradiente esmeralda + barra de progreso */}
      <article className="relative overflow-hidden rounded-xl border border-emerald-500/25 bg-gradient-to-br from-emerald-500/[0.07] via-card to-card p-4 transition-all hover:border-emerald-500/40 hover:shadow-lg hover:shadow-emerald-500/5">
        <div className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-emerald-400 to-emerald-600" />
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/15 ring-1 ring-emerald-500/30">
              <CheckCircle2 size={14} className="text-emerald-400" aria-hidden="true" />
            </div>
            <span className="text-xs font-medium text-muted-foreground">Entregados</span>
          </div>
          <span className="rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold text-emerald-400 tabular-nums">
            {tasaEntrega.toFixed(1)}%
          </span>
        </div>
        <div className="text-3xl font-bold text-foreground tabular-nums leading-none">
          {data.entregados.toLocaleString('es-CO')}
        </div>
        <div className="mt-3 h-1.5 w-full rounded-full bg-emerald-500/10 overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400 transition-all duration-700"
            style={{ width: `${Math.min(100, tasaEntrega)}%` }}
            aria-hidden="true"
          />
        </div>
        <div className="text-[11px] text-muted-foreground mt-1.5">
          de {data.total_pedidos.toLocaleString('es-CO')} envíos
        </div>
      </article>

      {/* Devueltos — gradiente rojo + barra */}
      <article className="relative overflow-hidden rounded-xl border border-rose-500/25 bg-gradient-to-br from-rose-500/[0.07] via-card to-card p-4 transition-all hover:border-rose-500/40 hover:shadow-lg hover:shadow-rose-500/5">
        <div className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-rose-400 to-rose-600" />
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-rose-500/15 ring-1 ring-rose-500/30">
              <RotateCcw size={14} className="text-rose-400" aria-hidden="true" />
            </div>
            <span className="text-xs font-medium text-muted-foreground">Devueltos</span>
          </div>
          <span className="rounded-md bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-bold text-rose-400 tabular-nums">
            {tasaDevolucion.toFixed(1)}%
          </span>
        </div>
        <div className="text-3xl font-bold text-foreground tabular-nums leading-none">
          {data.devueltos.toLocaleString('es-CO')}
        </div>
        <div className="mt-3 h-1.5 w-full rounded-full bg-rose-500/10 overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-rose-500 to-rose-400 transition-all duration-700"
            style={{ width: `${Math.min(100, tasaDevolucion)}%` }}
            aria-hidden="true"
          />
        </div>
        <div className="text-[11px] text-muted-foreground mt-1.5">
          de {data.total_pedidos.toLocaleString('es-CO')} envíos
        </div>
      </article>

      {/* Valor entregado — accent (amarillo brand) + valor perdido en alerta */}
      <article className="relative overflow-hidden rounded-xl border border-accent/30 bg-gradient-to-br from-accent/[0.08] via-card to-card p-4 transition-all hover:border-accent/50 hover:shadow-lg hover:shadow-accent/5">
        <div className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-accent/80 to-accent" />
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/15 ring-1 ring-accent/30">
              <TrendingUp size={14} className="text-accent" aria-hidden="true" />
            </div>
            <span className="text-xs font-medium text-muted-foreground">Valor entregado</span>
          </div>
          <span className="rounded-md bg-accent/15 px-1.5 py-0.5 text-[10px] font-bold text-accent tabular-nums">
            {pctValor.toFixed(1)}%
          </span>
        </div>
        <div className="text-2xl font-bold text-foreground tabular-nums leading-none">
          {formatCOP(data.valor_entregado)}
        </div>
        <div className="mt-3 h-1.5 w-full rounded-full bg-accent/10 overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-accent/80 to-accent transition-all duration-700"
            style={{ width: `${Math.min(100, pctValor)}%` }}
            aria-hidden="true"
          />
        </div>
        <div className="text-[11px] text-rose-400 mt-1.5 inline-flex items-center gap-1">
          <AlertTriangle size={10} aria-hidden="true" />
          Perdido: <span className="font-semibold tabular-nums">{formatCOP(data.valor_perdido)}</span>
        </div>
      </article>
    </div>
  );
});

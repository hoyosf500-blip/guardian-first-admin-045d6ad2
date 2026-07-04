import { useMemo, useState } from 'react';
import {
  TrendingUp, AlertCircle, Loader2, Package as PackageIcon,
  ArrowUpDown, DollarSign, CheckCircle2,
} from 'lucide-react';
import {
  useProductProfitability,
  marginTone,
  aggregateProductTotals,
  type ProductProfitabilityRow,
  type ProfitTone,
} from '@/hooks/useProductProfitability';
import { formatCOP } from '@/lib/utils';
import { deriveDeliveryMaturity } from '@/lib/logisticsRates';
import type { LogisticsFilters } from '@/lib/logistics.types';

// ─────────────────────────────────────────────────────────────────
// /logistica → "Rentabilidad por producto"
//
// Tabla con cuánta plata gana o pierde por producto en el rango.
// Muestra el desglose: ingresos entregados − costo prod − flete −
// costo devolución = utilidad real. Y proyecta lo que va a quedar
// extrapolando los pedidos en tránsito.
//
// Tono por fila según margen %:
//   ≥ 25%  → success (verde) — rentable
//   10-25% → warning (naranja) — apretado
//   < 10%  → danger (rojo) — pierde plata
//   sin entregas → muted (sin info)
// ─────────────────────────────────────────────────────────────────

interface Props {
  filters: LogisticsFilters;
}

const TONE_BG: Record<ProfitTone, string> = {
  success: 'bg-green/5 hover:bg-green/10',
  warning: 'bg-orange/5 hover:bg-orange/10',
  danger:  'bg-red/5 hover:bg-red/10',
  muted:   'hover:bg-muted/20',
};

const TONE_TEXT: Record<ProfitTone, string> = {
  success: 'text-green',
  warning: 'text-orange',
  danger:  'text-red',
  muted:   'text-muted-foreground',
};

type SortBy = 'utilidad' | 'pedidos' | 'margen' | 'ticket';

const SORT_LABELS: Record<SortBy, string> = {
  utilidad: 'Utilidad real',
  pedidos: 'Pedidos',
  margen: 'Margen %',
  ticket: 'Ticket prom.',
};

function applySort(rows: ProductProfitabilityRow[], sortBy: SortBy): ProductProfitabilityRow[] {
  const sorted = [...rows];
  switch (sortBy) {
    case 'utilidad': sorted.sort((a, b) => b.utilidad_real - a.utilidad_real); break;
    case 'pedidos':  sorted.sort((a, b) => b.total_pedidos - a.total_pedidos); break;
    case 'margen':   sorted.sort((a, b) => b.margen_pct - a.margen_pct); break;
    case 'ticket':   sorted.sort((a, b) => b.ticket_promedio - a.ticket_promedio); break;
  }
  return sorted;
}

export default function ProductProfitabilityTable({ filters }: Props) {
  const { data: rows, isLoading, isError, error } = useProductProfitability({
    fromDate: filters.fromDate,
    toDate: filters.toDate,
    limit: 100,
  });

  const [sortBy, setSortBy] = useState<SortBy>('utilidad');
  const sortedRows = useMemo(() => applySort(rows ?? [], sortBy), [rows, sortBy]);
  const totals = useMemo(() => aggregateProductTotals(rows ?? []), [rows]);
  // El RPC devuelve las 100 de MAYOR utilidad (ORDER BY utilidad DESC LIMIT 100).
  // Si llegaron exactamente 100, probablemente hay más productos y los KPIs/total
  // de abajo (sumados sobre estas 100) SUBESTIMAN la pérdida real — avisamos.
  const truncated = (rows?.length ?? 0) >= 100;

  if (isLoading) {
    return (
      <section className="rounded-xl border border-border bg-card p-8 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 size={14} className="animate-spin" />
        Calculando rentabilidad por producto…
      </section>
    );
  }

  if (isError) {
    return (
      <section className="rounded-xl border border-red/40 bg-red/5 p-4 flex items-start gap-2 text-sm text-red">
        <AlertCircle size={14} className="shrink-0 mt-0.5" />
        <div>
          <span className="font-semibold">No pude calcular rentabilidad.</span>{' '}
          <span className="text-foreground/80">
            {error instanceof Error ? error.message : 'Error desconocido'}.
            Probablemente la migration <code className="text-xs bg-card px-1 rounded">product_profitability</code> no se aplicó. Corré el SQL en Supabase.
          </span>
        </div>
      </section>
    );
  }

  if (!rows || rows.length === 0) {
    return (
      <section className="rounded-xl border border-border bg-card p-8 text-center">
        <PackageIcon size={24} className="mx-auto text-muted-foreground mb-2" />
        <p className="text-sm text-muted-foreground">Sin productos en el rango seleccionado</p>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      {truncated && (
        <div className="rounded-lg border border-warning/30 bg-warning/8 px-4 py-2.5 text-[11px] text-warning">
          Mostrando los <strong>100 productos de mayor utilidad</strong>. Si tenés más productos, los KPIs y el total de abajo pueden <strong>subestimar la pérdida real</strong> (los mayores perdedores quedan fuera del corte). Afiná el rango para ver menos productos.
        </div>
      )}
      {/* KPI agregados */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard
          label="Utilidad real"
          value={formatCOP(totals.utilidad_real)}
          tone={totals.utilidad_real > 0 ? 'success' : totals.utilidad_real < 0 ? 'danger' : 'muted'}
          icon={<DollarSign size={14} />}
        />
        <KpiCard
          label="Utilidad proyectada"
          subtitle="incluye tránsito"
          value={formatCOP(totals.utilidad_proyectada)}
          tone={totals.utilidad_proyectada > totals.utilidad_real ? 'success' : 'warning'}
          icon={<TrendingUp size={14} />}
        />
        <KpiCard
          label="Productos activos"
          value={String(rows.length)}
          tone="muted"
          icon={<PackageIcon size={14} />}
        />
        <KpiCard
          label="Entregados / Devueltos"
          value={`${totals.entregados} / ${totals.devueltos}`}
          subtitle={`${totals.cancelados} cancelados, ${totals.en_transito} en tránsito`}
          tone={totals.devueltos > totals.entregados ? 'danger' : 'success'}
          icon={<CheckCircle2 size={14} />}
        />
      </div>

      {/* Tabla */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <header className="px-4 py-3 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <PackageIcon size={14} className="text-accent" />
            <h3 className="text-sm font-semibold text-foreground">Rentabilidad por producto</h3>
          </div>
          <div className="flex items-center gap-1.5 text-xs">
            <ArrowUpDown size={11} className="text-muted-foreground" />
            <span className="text-muted-foreground">Ordenar:</span>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortBy)}
              className="bg-card border border-border rounded px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-accent"
            >
              {(Object.keys(SORT_LABELS) as SortBy[]).map((k) => (
                <option key={k} value={k}>{SORT_LABELS[k]}</option>
              ))}
            </select>
          </div>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/30 text-muted-foreground text-[10px] uppercase tracking-wider">
              <tr>
                <th className="px-3 py-2 text-left font-semibold sticky left-0 bg-muted/30">Producto</th>
                <th className="px-3 py-2 text-right font-semibold">Total</th>
                <th className="px-3 py-2 text-right font-semibold text-green">Entreg.</th>
                <th className="px-3 py-2 text-right font-semibold text-info">Tránsito</th>
                <th className="px-3 py-2 text-right font-semibold text-red">Devuelt.</th>
                <th className="px-3 py-2 text-right font-semibold text-muted-foreground">Cancel.</th>
                <th className="px-3 py-2 text-right font-semibold">Tasa entr.</th>
                <th className="px-3 py-2 text-right font-semibold">Ticket prom.</th>
                <th className="px-3 py-2 text-right font-semibold">Ingresos</th>
                <th className="px-3 py-2 text-right font-semibold">Costos</th>
                <th className="px-3 py-2 text-right font-semibold">Utilidad real</th>
                <th className="px-3 py-2 text-right font-semibold">Proyectada</th>
                <th className="px-3 py-2 text-right font-semibold">Margen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sortedRows.map((row) => {
                const tone = marginTone(row);
                const totalCostos = row.costo_prod_entregados + row.flete_inicial_entregados + row.costo_devolucion_total;
                // Tasa de entrega MADURA (÷ entregados+devueltos), consistente con
                // el resto de logística. El margen/utilidad ya van sobre entregados.
                const tasaEntregaMadura = deriveDeliveryMaturity(row.entregados, row.devueltos, row.total_pedidos).tasaEntregaMadura;
                return (
                  <tr key={row.producto} className={TONE_BG[tone]}>
                    <td className="px-3 py-2 text-xs text-foreground font-medium sticky left-0 bg-card max-w-[280px] truncate" title={row.producto}>
                      {row.producto}
                    </td>
                    <td className="px-3 py-2 text-right text-xs tabular-nums text-foreground font-bold">{row.total_pedidos}</td>
                    <td className="px-3 py-2 text-right text-xs tabular-nums text-green">{row.entregados}</td>
                    <td className="px-3 py-2 text-right text-xs tabular-nums text-info">{row.en_transito}</td>
                    <td className="px-3 py-2 text-right text-xs tabular-nums text-red">{row.devueltos}</td>
                    <td className="px-3 py-2 text-right text-xs tabular-nums text-muted-foreground">{row.cancelados}</td>
                    <td className="px-3 py-2 text-right text-xs tabular-nums text-foreground">{tasaEntregaMadura == null ? '—' : `${tasaEntregaMadura}%`}</td>
                    <td className="px-3 py-2 text-right text-xs tabular-nums font-mono text-muted-foreground">
                      {row.ticket_promedio > 0 ? formatCOP(row.ticket_promedio) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right text-xs tabular-nums font-mono text-foreground">{formatCOP(row.ingresos_entregados)}</td>
                    <td className="px-3 py-2 text-right text-xs tabular-nums font-mono text-red">-{formatCOP(totalCostos)}</td>
                    <td className={`px-3 py-2 text-right text-xs tabular-nums font-mono font-bold ${TONE_TEXT[tone]}`}>
                      {row.utilidad_real >= 0 ? '+' : ''}{formatCOP(row.utilidad_real)}
                    </td>
                    <td className={`px-3 py-2 text-right text-xs tabular-nums font-mono ${row.utilidad_proyectada > row.utilidad_real ? 'text-green' : 'text-foreground'}`}>
                      {row.utilidad_proyectada >= 0 ? '+' : ''}{formatCOP(row.utilidad_proyectada)}
                    </td>
                    <td className={`px-3 py-2 text-right text-xs tabular-nums font-bold ${TONE_TEXT[tone]}`}>
                      {row.entregados > 0 ? `${row.margen_pct.toFixed(0)}%` : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="bg-muted/40 text-foreground border-t-2 border-border font-bold">
              <tr>
                <td className="px-3 py-2 text-xs sticky left-0 bg-muted/40">TOTAL</td>
                <td className="px-3 py-2 text-right text-xs tabular-nums">{totals.total_pedidos}</td>
                <td className="px-3 py-2 text-right text-xs tabular-nums text-green">{totals.entregados}</td>
                <td className="px-3 py-2 text-right text-xs tabular-nums text-info">{totals.en_transito}</td>
                <td className="px-3 py-2 text-right text-xs tabular-nums text-red">{totals.devueltos}</td>
                <td className="px-3 py-2 text-right text-xs tabular-nums text-muted-foreground">{totals.cancelados}</td>
                <td className="px-3 py-2"></td>
                <td className="px-3 py-2"></td>
                <td className="px-3 py-2 text-right text-xs tabular-nums font-mono">{formatCOP(totals.ingresos_entregados)}</td>
                <td className="px-3 py-2"></td>
                <td className={`px-3 py-2 text-right text-xs tabular-nums font-mono ${totals.utilidad_real > 0 ? 'text-green' : 'text-red'}`}>
                  {totals.utilidad_real >= 0 ? '+' : ''}{formatCOP(totals.utilidad_real)}
                </td>
                <td className={`px-3 py-2 text-right text-xs tabular-nums font-mono ${totals.utilidad_proyectada > 0 ? 'text-green' : 'text-red'}`}>
                  {totals.utilidad_proyectada >= 0 ? '+' : ''}{formatCOP(totals.utilidad_proyectada)}
                </td>
                <td className="px-3 py-2"></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Leyenda */}
      <div className="rounded-xl border border-border bg-card/50 p-3">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1.5">Leyenda</div>
        <div className="flex flex-wrap gap-3 text-[11px]">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-green" /> <span className="text-foreground">Margen ≥25%</span> rentable
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-orange" /> <span className="text-foreground">Margen 10-25%</span> apretado
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-red" /> <span className="text-foreground">Margen &lt;10% o pérdida</span> pierde plata
          </span>
        </div>
        <p className="text-[10px] text-muted-foreground mt-2 leading-relaxed">
          <strong>Utilidad real</strong>: ingresos entregados − costo producto − flete inicial − costo devoluciones (lo que ya tenés).{' '}
          <strong>Proyectada</strong>: utilidad real + estimación de los pedidos en tránsito (extrapola usando tasa de entrega del producto).
        </p>
      </div>
    </section>
  );
}

interface KpiCardProps {
  label: string;
  value: string;
  subtitle?: string;
  tone: ProfitTone;
  icon: React.ReactNode;
}

function KpiCard({ label, value, subtitle, tone, icon }: KpiCardProps) {
  const TONE_CARD: Record<ProfitTone, string> = {
    success: 'border-green/40 bg-green/5',
    warning: 'border-orange/40 bg-orange/5',
    danger:  'border-red/40 bg-red/5',
    muted:   'border-border bg-card',
  };
  return (
    <div className={`rounded-xl border ${TONE_CARD[tone]} p-3 space-y-1`}>
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
        <span className={TONE_TEXT[tone]}>{icon}</span>
        {label}
      </div>
      <div className={`text-xl font-bold tabular-nums ${TONE_TEXT[tone]}`}>{value}</div>
      {subtitle && <div className="text-[10px] text-muted-foreground">{subtitle}</div>}
    </div>
  );
}

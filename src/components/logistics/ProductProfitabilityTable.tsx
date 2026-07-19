import { useMemo, useState } from 'react';
import {
  TrendingUp, AlertCircle, Loader2, Package as PackageIcon,
  ArrowUpDown, DollarSign, CheckCircle2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { motion } from 'framer-motion';
import { TiltCard } from '@/components/ui3d';
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

/** Entrada escalonada de bloques — misma cascada que el Dashboard. */
const fadeUp = (delay = 0) => ({
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35, delay, ease: 'easeOut' as const },
});

// Tokens semánticos del DS (success/warning/danger) en vez de los alias
// legacy green/orange/red: este archivo era el que más se salía del sistema.
const TONE_BG: Record<ProfitTone, string> = {
  success: 'bg-success/5 hover:bg-success/10',
  warning: 'bg-warning/5 hover:bg-warning/10',
  danger:  'bg-danger/5 hover:bg-danger/10',
  muted:   'hover:bg-muted/20',
};

const TONE_TEXT: Record<ProfitTone, string> = {
  success: 'text-success',
  warning: 'text-warning',
  danger:  'text-danger',
  muted:   'text-muted-foreground',
};

/** Chip de ícono + glow por tono — la firma visual del KPI del Dashboard. */
const TONE_CHIP: Record<ProfitTone, string> = {
  success: 'bg-success/14 border-success/30 text-success glow-success',
  warning: 'bg-warning/14 border-warning/30 text-warning glow-warning',
  danger:  'bg-danger/14 border-danger/30 text-danger glow-danger',
  muted:   'bg-muted/60 border-border text-muted-foreground',
};

/** Color del valor de la tarjeta: el tono neutro va en foreground para no
 *  leerse como "dato apagado" cuando es un conteo real. */
const TONE_VALUE: Record<ProfitTone, string> = {
  success: 'text-success',
  warning: 'text-warning',
  danger:  'text-danger',
  muted:   'text-foreground',
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

/** Mini-barra de la tasa de entrega: SIN veredicto de color propio (el
 *  umbral de "buena tasa de entrega" no se decide acá) — solo magnitud,
 *  con el degradado de acento y la pista redondeada del Dashboard.
 *  Si no hay tasa no se dibuja barra: un 0% de ancho mentiría. */
function TasaEntregaCell({ pct }: { pct: number | null }) {
  if (pct == null) {
    return (
      <span className="font-mono text-muted-foreground" title="Sin pedidos concluidos aún">—</span>
    );
  }
  const width = Math.max(0, Math.min(100, pct));
  return (
    <div className="inline-flex w-full min-w-[3.5rem] max-w-[5rem] flex-col items-end gap-1.5 align-middle">
      <span className="font-mono tabular-nums text-foreground leading-none">{pct}%</span>
      <div
        className="h-1 w-full rounded-full bg-foreground/10"
        role="progressbar"
        aria-valuenow={width}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full rounded-full bg-accent-gradient transition-[width] duration-700 ease-out"
          style={{ width: `${width}%` }}
          aria-hidden="true"
        />
      </div>
    </div>
  );
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
      <section className="rounded-2xl border border-border bg-card/40 p-8 shadow-card3d hairline-top flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 size={14} className="animate-spin" />
        Calculando rentabilidad por producto…
      </section>
    );
  }

  if (isError) {
    return (
      <div className="relative flex flex-col sm:flex-row sm:items-center gap-3 rounded-2xl border border-danger/30 bg-danger/10 px-4 pl-5 py-3 shadow-card3d">
        <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-danger" aria-hidden="true" />
        <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 bg-danger/20 glow-danger">
          <AlertCircle size={17} className="text-danger" aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0 text-sm">
          <span className="font-semibold text-danger">No pude calcular rentabilidad.</span>{' '}
          <span className="text-foreground/80 text-[11px] leading-relaxed">
            {error instanceof Error ? error.message : 'Error desconocido'}.
            Probablemente la migration <code className="text-xs bg-card px-1 rounded">product_profitability</code> no se aplicó. Corré el SQL en Supabase.
          </span>
        </div>
      </div>
    );
  }

  if (!rows || rows.length === 0) {
    return (
      <section className="rounded-2xl border border-border bg-card/40 p-8 shadow-card3d hairline-top text-center">
        <div className="mx-auto mb-3 flex h-9 w-9 items-center justify-center rounded-xl border bg-muted/60 border-border">
          <PackageIcon size={17} className="text-muted-foreground" aria-hidden="true" />
        </div>
        <p className="text-sm text-muted-foreground">Sin productos en el rango seleccionado</p>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      {truncated && (
        <motion.div
          {...fadeUp(0)}
          className="relative flex flex-col sm:flex-row sm:items-center gap-3 rounded-2xl border border-warning/30 bg-warning/10 px-4 pl-5 py-3 shadow-card3d"
        >
          <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-warning" aria-hidden="true" />
          <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 bg-warning/20 glow-warning">
            <AlertCircle size={17} className="text-warning" aria-hidden="true" />
          </div>
          <p className="flex-1 min-w-0 text-[11px] leading-relaxed text-warning">
            Mostrando los <strong>100 productos de mayor utilidad</strong>. Si tenés más productos, los KPIs y el total de abajo pueden <strong>subestimar la pérdida real</strong> (los mayores perdedores quedan fuera del corte). Afiná el rango para ver menos productos.
          </p>
        </motion.div>
      )}

      {/* KPI agregados */}
      <motion.div {...fadeUp(0.05)} className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard
          label="Utilidad real"
          value={formatCOP(totals.utilidad_real)}
          tone={totals.utilidad_real > 0 ? 'success' : totals.utilidad_real < 0 ? 'danger' : 'muted'}
          icon={DollarSign}
        />
        <KpiCard
          label="Utilidad proyectada"
          subtitle="incluye tránsito"
          value={formatCOP(totals.utilidad_proyectada)}
          tone={totals.utilidad_proyectada > totals.utilidad_real ? 'success' : 'warning'}
          icon={TrendingUp}
        />
        <KpiCard
          label="Productos activos"
          value={String(rows.length)}
          tone="muted"
          icon={PackageIcon}
        />
        <KpiCard
          label="Entregados / Devueltos"
          value={`${totals.entregados} / ${totals.devueltos}`}
          subtitle={`${totals.cancelados} cancelados, ${totals.en_transito} en tránsito`}
          tone={totals.devueltos > totals.entregados ? 'danger' : 'success'}
          icon={CheckCircle2}
        />
      </motion.div>

      {/* Tabla */}
      <motion.div
        {...fadeUp(0.14)}
        className="rounded-2xl border border-border bg-card/40 overflow-hidden shadow-card3d hairline-top transition-colors duration-200 hover:border-border-strong"
      >
        <header className="px-5 py-3.5 border-b border-border flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            <PackageIcon size={14} className="text-accent" aria-hidden="true" />
            <h3 className="text-sm font-semibold text-foreground">Rentabilidad por producto</h3>
          </div>
          <div className="flex items-center gap-1.5 text-xs">
            <ArrowUpDown size={13} className="text-muted-foreground" aria-hidden="true" />
            <span className="text-muted-foreground">Ordenar:</span>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortBy)}
              className="bg-card/40 border border-border rounded-xl px-3 py-1.5 text-xs text-foreground cursor-pointer transition-colors duration-200 hover:border-border-strong focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
            >
              {(Object.keys(SORT_LABELS) as SortBy[]).map((k) => (
                <option key={k} value={k}>{SORT_LABELS[k]}</option>
              ))}
            </select>
          </div>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-card/95 [&_th]:backdrop-blur-sm">
              <tr className="border-b border-border">
                <th className="px-5 py-2.5 text-left hud-label font-normal sticky left-0 bg-card/95 backdrop-blur-sm">Producto</th>
                <th className="px-3 py-2.5 text-right hud-label font-normal">Total</th>
                <th className="px-3 py-2.5 text-right hud-label font-normal text-success">Entreg.</th>
                <th className="px-3 py-2.5 text-right hud-label font-normal text-info">Tránsito</th>
                <th className="px-3 py-2.5 text-right hud-label font-normal text-danger">Devuelt.</th>
                <th className="px-3 py-2.5 text-right hud-label font-normal">Cancel.</th>
                <th className="px-3 py-2.5 text-right hud-label font-normal">Tasa entr.</th>
                <th className="px-3 py-2.5 text-right hud-label font-normal">Ticket prom.</th>
                <th className="px-3 py-2.5 text-right hud-label font-normal">Ingresos</th>
                <th className="px-3 py-2.5 text-right hud-label font-normal">Costos</th>
                <th className="px-3 py-2.5 text-right hud-label font-normal">Utilidad real</th>
                <th className="px-3 py-2.5 text-right hud-label font-normal">Proyectada</th>
                <th className="px-3 py-2.5 text-right hud-label font-normal">Margen</th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row) => {
                const tone = marginTone(row);
                const totalCostos = row.costo_prod_entregados + row.flete_inicial_entregados + row.costo_devolucion_total;
                // Tasa de entrega MADURA (÷ entregados+devueltos), consistente con
                // el resto de logística. El margen/utilidad ya van sobre entregados.
                const tasaEntregaMadura = deriveDeliveryMaturity(row.entregados, row.devueltos, row.total_pedidos).tasaEntregaMadura;
                return (
                  <tr key={row.producto} className={`border-b border-border/50 last:border-0 transition-colors duration-200 ${TONE_BG[tone]}`}>
                    <td className="px-5 py-2.5 text-foreground font-medium sticky left-0 bg-card max-w-[280px] truncate" title={row.producto}>
                      {row.producto}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-foreground font-bold">{row.total_pedidos}</td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-success">{row.entregados}</td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-info">{row.en_transito}</td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-danger">{row.devueltos}</td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-muted-foreground">{row.cancelados}</td>
                    <td className="px-3 py-2.5 text-right"><TasaEntregaCell pct={tasaEntregaMadura} /></td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-muted-foreground">
                      {row.ticket_promedio > 0 ? formatCOP(row.ticket_promedio) : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-foreground">{formatCOP(row.ingresos_entregados)}</td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-danger">-{formatCOP(totalCostos)}</td>
                    <td className={`px-3 py-2.5 text-right font-mono tabular-nums font-bold ${TONE_TEXT[tone]}`}>
                      {row.utilidad_real >= 0 ? '+' : ''}{formatCOP(row.utilidad_real)}
                    </td>
                    <td className={`px-3 py-2.5 text-right font-mono tabular-nums ${row.utilidad_proyectada > row.utilidad_real ? 'text-success' : 'text-foreground'}`}>
                      {row.utilidad_proyectada >= 0 ? '+' : ''}{formatCOP(row.utilidad_proyectada)}
                    </td>
                    <td className={`px-3 py-2.5 text-right font-mono tabular-nums font-bold ${TONE_TEXT[tone]}`}>
                      {row.entregados > 0 ? `${row.margen_pct.toFixed(0)}%` : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="bg-muted/40 text-foreground border-t-2 border-border font-bold">
              <tr>
                <td className="px-5 py-2.5 hud-label sticky left-0 bg-muted/40">TOTAL</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums">{totals.total_pedidos}</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums text-success">{totals.entregados}</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums text-info">{totals.en_transito}</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums text-danger">{totals.devueltos}</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums text-muted-foreground">{totals.cancelados}</td>
                <td className="px-3 py-2.5"></td>
                <td className="px-3 py-2.5"></td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums">{formatCOP(totals.ingresos_entregados)}</td>
                <td className="px-3 py-2.5"></td>
                <td className={`px-3 py-2.5 text-right font-mono tabular-nums ${totals.utilidad_real > 0 ? 'text-success' : 'text-danger'}`}>
                  {totals.utilidad_real >= 0 ? '+' : ''}{formatCOP(totals.utilidad_real)}
                </td>
                <td className={`px-3 py-2.5 text-right font-mono tabular-nums ${totals.utilidad_proyectada > 0 ? 'text-success' : 'text-danger'}`}>
                  {totals.utilidad_proyectada >= 0 ? '+' : ''}{formatCOP(totals.utilidad_proyectada)}
                </td>
                <td className="px-3 py-2.5"></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </motion.div>

      {/* Leyenda */}
      <motion.div {...fadeUp(0.24)} className="rounded-2xl border border-border bg-card/40 p-5 shadow-card3d hairline-top">
        <div className="hud-label mb-3">Leyenda</div>
        <div className="flex flex-wrap gap-3 text-[11px]">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-[3px] bg-success" aria-hidden="true" /> <span className="text-foreground">Margen ≥25%</span> <span className="text-muted-foreground">rentable</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-[3px] bg-warning" aria-hidden="true" /> <span className="text-foreground">Margen 10-25%</span> <span className="text-muted-foreground">apretado</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-[3px] bg-danger" aria-hidden="true" /> <span className="text-foreground">Margen &lt;10% o pérdida</span> <span className="text-muted-foreground">pierde plata</span>
          </span>
        </div>
        <p className="text-[10px] text-muted-foreground mt-3 leading-relaxed">
          <strong>Utilidad real</strong>: ingresos entregados − costo producto − flete inicial − costo devoluciones (lo que ya tenés).{' '}
          <strong>Proyectada</strong>: utilidad real + estimación de los pedidos en tránsito (extrapola usando tasa de entrega del producto).
        </p>
      </motion.div>
    </section>
  );
}

interface KpiCardProps {
  label: string;
  value: string;
  subtitle?: string;
  tone: ProfitTone;
  icon: LucideIcon;
}

/**
 * Tarjeta KPI con la anatomía canónica del Dashboard: chip de ícono de 36px
 * con glow arriba, la cifra grande en mono+tabular, y el rótulo HUD DEBAJO
 * de la cifra (antes iba encima, que es justo al revés del lenguaje).
 *
 * No usa <StatTile/> porque su `value` es `number` y acá la cifra es plata ya
 * formateada con formatCOP — pasarla por CountUp obligaría a re-formatear el
 * dinero a mano en cada frame.
 */
function KpiCard({ label, value, subtitle, tone, icon: Icon }: KpiCardProps) {
  return (
    <TiltCard
      perspective={1200}
      className="rounded-2xl p-4 h-full flex flex-col justify-between bg-card/40 border border-border shadow-card3d"
    >
      <div>
        <div className="flex items-start justify-between gap-2 tilt-layer-2">
          <span className={`w-9 h-9 rounded-xl border flex items-center justify-center flex-shrink-0 ${TONE_CHIP[tone]}`}>
            <Icon size={17} aria-hidden="true" />
          </span>
        </div>
        <div className={`font-mono tabular-nums text-xl sm:text-2xl font-bold leading-none mt-3 tilt-layer-3 ${TONE_VALUE[tone]}`}>
          {value}
        </div>
        <div className="hud-label text-subtle mt-2 tilt-layer-1">{label}</div>
        {subtitle && (
          <div className="text-[10px] text-muted-foreground mt-1.5 leading-snug tilt-layer-1">{subtitle}</div>
        )}
      </div>
    </TiltCard>
  );
}

import { memo, useMemo } from 'react';
import { Lightbulb, Copy, ArrowRightLeft, CheckCircle2, Info } from 'lucide-react';
import { useCityCarrierMatrix } from '@/hooks/useCityCarrierMatrix';
import { deriveCarrierRecommendations } from '@/lib/carrierRecommendations';
import { copyToClipboard } from '@/lib/clipboard';
import type { LogisticsFilters, CarrierRecommendation } from '@/lib/logistics.types';

interface Props {
  filters: LogisticsFilters;
  /** Pedidos mínimos para considerar la ciudad. Default: 20. */
  minOrders?: number;
}

/**
 * Tabla de recomendaciones de transportadora por ciudad. Para cada ciudad
 * con ≥minOrders pedidos, muestra mejor/peor carrier por tasa de entrega
 * y recomendación accionable + botón copiar mensaje WhatsApp.
 */
export default memo(function CarrierRecommendations({
  filters,
  minOrders = 20,
}: Props) {
  // Derivado de la matriz city-carrier (scopeada por tienda) con tasa MADURA.
  // topCities alto para cubrir prácticamente todas las ciudades relevantes
  // (el ranking viejo no estaba limitado a top N).
  const matrix = useCityCarrierMatrix({ filters, minOrders, topCities: 50 });
  const rows = useMemo(
    () => deriveCarrierRecommendations(matrix.data ?? [], minOrders),
    [matrix.data, minOrders],
  );

  if (matrix.isLoading) {
    return (
      <div className="rounded-xl border border-border bg-card p-5 skeleton-shimmer min-h-[300px]" />
    );
  }

  if (matrix.isError) {
    return (
      <div className="rounded-xl border border-border bg-card p-5 text-sm text-danger">
        Error cargando recomendaciones: {matrix.error?.message}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-5 text-center">
        <Info size={28} className="mx-auto text-muted-foreground mb-2" aria-hidden="true" />
        <p className="text-sm font-semibold text-foreground">Sin recomendaciones disponibles</p>
        <p className="text-xs text-muted-foreground mt-1">
          No hay ciudades con ≥{minOrders} pedidos en este rango.
        </p>
      </div>
    );
  }

  // Counts para el stats banner: cuántas ciudades en cada bucket de acción.
  const urgentCount = rows.filter(r => (r.delta_puntos ?? 0) >= 20 && r.mejor_transportadora !== r.carrier_actual_top).length;
  const cambioCount = rows.filter(r => (r.delta_puntos ?? 0) >= 10 && (r.delta_puntos ?? 0) < 20 && r.mejor_transportadora !== r.carrier_actual_top).length;
  const mantenerCount = rows.filter(r => r.mejor_transportadora === r.carrier_actual_top).length;

  return (
    <div className="space-y-3">
      {/* Stats banner — resumen accionable arriba de la tabla */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatsBanner tone="danger"  icon={ArrowRightLeft} label="Cambiar urgente"     value={urgentCount}   hint="Δ ≥ 20 puntos mejor vs peor" />
        <StatsBanner tone="warning" icon={ArrowRightLeft} label="Considerar cambio"   value={cambioCount}   hint="Δ entre 10 y 20 puntos" />
        <StatsBanner tone="success" icon={CheckCircle2}   label="Ya están óptimas"    value={mantenerCount} hint="El mejor carrier ya es el más usado" />
      </div>

      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <header className="px-5 py-4 border-b border-border/60">
          <div className="flex items-center gap-2">
            <Lightbulb size={14} className="text-warning" aria-hidden="true" strokeWidth={2.25} />
            <h2 className="text-sm font-bold text-foreground uppercase tracking-[0.08em]">
              Recomendaciones de transportadora por ciudad
            </h2>
          </div>
          <p className="text-[11px] text-muted-foreground mt-1">
            {rows.length} ciudad{rows.length !== 1 ? 'es' : ''} analizada{rows.length !== 1 ? 's' : ''} ·
            {' '}Click en "Copiar" para mandar el dato al encargado de logística por WhatsApp
          </p>
        </header>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/60 bg-muted/20">
              <th className="text-left px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Ciudad</th>
              <th className="text-right px-3 py-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Vol.</th>
              <th className="text-left px-3 py-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Mejor carrier</th>
              <th className="text-left px-3 py-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Peor carrier</th>
              <th className="text-center px-3 py-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Δ pts</th>
              <th className="text-left px-3 py-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Acción</th>
              <th className="text-right px-3 py-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <RecommendationRow key={`${row.ciudad}|${row.departamento}`} row={row} filters={filters} />
            ))}
          </tbody>
        </table>
      </div>
      </div>
    </div>
  );
});

interface StatsBannerProps {
  tone: 'success' | 'warning' | 'danger';
  icon: typeof CheckCircle2;
  label: string;
  value: number;
  hint: string;
}
function StatsBanner({ tone, icon: Icon, label, value, hint }: StatsBannerProps) {
  const styles = {
    success: { card: 'border-success/30 bg-gradient-to-br from-success/8 via-success/3 to-transparent',
               text: 'text-success', iconBg: 'bg-success/15 border-success/40' },
    warning: { card: 'border-warning/30 bg-gradient-to-br from-warning/8 via-warning/3 to-transparent',
               text: 'text-warning', iconBg: 'bg-warning/15 border-warning/40' },
    danger:  { card: 'border-danger/30 bg-gradient-to-br from-danger/8 via-danger/3 to-transparent',
               text: 'text-danger', iconBg: 'bg-danger/15 border-danger/40' },
  }[tone];
  return (
    <article className={`rounded-2xl border-2 ${styles.card} p-4 flex items-center gap-3`}>
      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border ${styles.iconBg}`}>
        <Icon size={16} className={styles.text} aria-hidden="true" strokeWidth={2.25} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] uppercase tracking-[0.12em] font-bold text-muted-foreground leading-tight">
          {label}
        </div>
        <div className={`font-extrabold text-2xl tabular-nums leading-none mt-0.5 ${styles.text}`}>
          {value}
        </div>
        <div className="text-[10px] text-muted-foreground mt-1 truncate">
          {hint}
        </div>
      </div>
    </article>
  );
}

interface RowProps {
  row: CarrierRecommendation;
  filters: LogisticsFilters;
}
function RecommendationRow({ row, filters }: RowProps) {
  const isMantener = row.mejor_transportadora === row.carrier_actual_top;
  const delta = row.delta_puntos ?? 0;

  let badgeTone: 'success' | 'warning' | 'danger';
  let badgeLabel: string;
  if (isMantener) {
    badgeTone = 'success';
    badgeLabel = 'Mantener';
  } else if (delta >= 20) {
    badgeTone = 'danger';
    badgeLabel = 'Cambiar urgente';
  } else if (delta >= 10) {
    badgeTone = 'warning';
    badgeLabel = 'Considerar cambio';
  } else {
    badgeTone = 'warning';
    badgeLabel = 'Cambiar';
  }

  const handleCopy = async () => {
    const msg = buildWhatsAppMessage(row, filters);
    await copyToClipboard(msg, 'Mensaje copiado');
  };

  return (
    <tr className="border-b border-border/40 hover:bg-muted/10 transition-colors">
      <td className="px-4 py-2.5">
        <div className="font-semibold text-foreground truncate max-w-[160px]" title={row.ciudad}>
          {row.ciudad}
        </div>
        {row.departamento && (
          <div className="text-[10px] text-muted-foreground truncate max-w-[160px]">
            {row.departamento}
          </div>
        )}
      </td>
      <td className="px-3 py-2.5 text-right font-mono tabular-nums text-muted-foreground text-xs">
        {row.ciudad_total.toLocaleString('es-CO')}
      </td>
      <td className="px-3 py-2.5">
        <div className="font-semibold text-foreground text-xs truncate max-w-[140px]" title={row.mejor_transportadora}>
          {row.mejor_transportadora}
        </div>
        <div className="font-mono tabular-nums text-success text-[11px]" title={`${row.mejor_resueltos} pedidos concluidos de ${row.mejor_pedidos} totales`}>
          {row.mejor_tasa_entrega.toFixed(1)}% · {row.mejor_resueltos}r/{row.mejor_pedidos}p
        </div>
      </td>
      <td className="px-3 py-2.5">
        <div className="font-semibold text-foreground text-xs truncate max-w-[140px]" title={row.peor_transportadora}>
          {row.peor_transportadora}
        </div>
        <div className="font-mono tabular-nums text-danger text-[11px]" title={`${row.peor_resueltos} pedidos concluidos de ${row.peor_pedidos} totales`}>
          {row.peor_tasa_entrega.toFixed(1)}% · {row.peor_resueltos}r/{row.peor_pedidos}p
        </div>
      </td>
      <td className="px-3 py-2.5 text-center">
        <span className={`inline-flex items-center gap-0.5 font-mono font-bold tabular-nums text-sm ${
          delta >= 20 ? 'text-danger' :
          delta >= 10 ? 'text-warning' :
          delta >= 5 ? 'text-foreground' :
          'text-muted-foreground'
        }`}>
          {delta >= 10 && <span aria-hidden="true">↑</span>}
          {delta.toFixed(0)}
        </span>
      </td>
      <td className="px-3 py-2.5">
        <span className={`pill pill-${badgeTone} text-[11px] font-semibold inline-flex items-center gap-1`}>
          {isMantener ? (
            <CheckCircle2 size={11} aria-hidden="true" />
          ) : (
            <ArrowRightLeft size={11} aria-hidden="true" />
          )}
          {badgeLabel}
          {!isMantener && (
            <span className="ml-1 font-normal opacity-90">
              → {row.mejor_transportadora}
            </span>
          )}
        </span>
      </td>
      <td className="px-3 py-2.5 text-right">
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1.5 h-7 rounded-md border border-border bg-card px-2.5 text-[11px] font-medium text-foreground hover:bg-muted/40 hover:border-border-strong transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          aria-label={`Copiar mensaje WhatsApp para ${row.ciudad}`}
          title="Copiar mensaje para WhatsApp"
        >
          <Copy size={11} aria-hidden="true" />
          Copiar
        </button>
      </td>
    </tr>
  );
}

function buildWhatsAppMessage(row: CarrierRecommendation, filters: LogisticsFilters): string {
  const isMantener = row.mejor_transportadora === row.carrier_actual_top;
  const action = isMantener
    ? `Mantener ${row.mejor_transportadora}`
    : `Cambiar de ${row.carrier_actual_top || 'actual'} a ${row.mejor_transportadora}`;

  return [
    `📦 Recomendación de transportadora — ${row.ciudad}${row.departamento ? `, ${row.departamento}` : ''}`,
    ``,
    `🟢 Mejor: ${row.mejor_transportadora} (${row.mejor_tasa_entrega.toFixed(1)}% entrega sobre ${row.mejor_resueltos} concluidos · ${row.mejor_pedidos} pedidos totales)`,
    `🔴 Peor: ${row.peor_transportadora} (${row.peor_tasa_entrega.toFixed(1)}% entrega sobre ${row.peor_resueltos} concluidos · ${row.peor_pedidos} pedidos totales)`,
    `Δ: ${row.delta_puntos.toFixed(1)} puntos de diferencia`,
    ``,
    `✅ Acción: ${action}`,
    ``,
    `Periodo: ${filters.fromDate} → ${filters.toDate}`,
    `Volumen analizado: ${row.ciudad_total.toLocaleString('es-CO')} pedidos`,
  ].join('\n');
}

import { memo } from 'react';
import { Lightbulb, Copy, ArrowRightLeft, CheckCircle2, Info } from 'lucide-react';
import { useCarrierRecommendations } from '@/hooks/useCarrierRecommendations';
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
  const recs = useCarrierRecommendations({ filters, minOrders });

  if (recs.isLoading) {
    return (
      <div className="rounded-xl border border-border bg-card p-5 skeleton-shimmer min-h-[300px]" />
    );
  }

  if (recs.isError) {
    return (
      <div className="rounded-xl border border-border bg-card p-5 text-sm text-danger">
        Error cargando recomendaciones: {recs.error?.message}
      </div>
    );
  }

  const rows = recs.data ?? [];

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

  return (
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
  );
});

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
        <div className="font-mono tabular-nums text-success text-[11px]">
          {row.mejor_tasa_entrega.toFixed(1)}% · {row.mejor_pedidos}p
        </div>
      </td>
      <td className="px-3 py-2.5">
        <div className="font-semibold text-foreground text-xs truncate max-w-[140px]" title={row.peor_transportadora}>
          {row.peor_transportadora}
        </div>
        <div className="font-mono tabular-nums text-danger text-[11px]">
          {row.peor_tasa_entrega.toFixed(1)}% · {row.peor_pedidos}p
        </div>
      </td>
      <td className="px-3 py-2.5 text-center">
        <span className="font-mono font-bold tabular-nums text-foreground text-sm">
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
    `🟢 Mejor: ${row.mejor_transportadora} (${row.mejor_tasa_entrega.toFixed(1)}% entrega · ${row.mejor_pedidos} pedidos)`,
    `🔴 Peor: ${row.peor_transportadora} (${row.peor_tasa_entrega.toFixed(1)}% entrega · ${row.peor_pedidos} pedidos)`,
    `Δ: ${row.delta_puntos.toFixed(1)} puntos de diferencia`,
    ``,
    `✅ Acción: ${action}`,
    ``,
    `Periodo: ${filters.fromDate} → ${filters.toDate}`,
    `Volumen analizado: ${row.ciudad_total.toLocaleString('es-CO')} pedidos`,
  ].join('\n');
}

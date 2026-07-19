import { memo, useMemo } from 'react';
import { motion } from 'framer-motion';
import { Lightbulb, Copy, ArrowRightLeft, CheckCircle2, Info } from 'lucide-react';
import { useCityCarrierMatrix } from '@/hooks/useCityCarrierMatrix';
import { deriveCarrierRecommendations } from '@/lib/carrierRecommendations';
import { copyToClipboard } from '@/lib/clipboard';
import { StatTile } from '@/components/ui3d';
import type { LogisticsFilters, CarrierRecommendation } from '@/lib/logistics.types';

interface Props {
  filters: LogisticsFilters;
  /** Pedidos mínimos para considerar la ciudad. Default: 20. */
  minOrders?: number;
}

// Entrada escalonada — misma cascada de delays que el Dashboard.
// Cascada INTERNA del bloque. Solo opacidad, sin `y`: LogisticaTab ya envuelve
// a este componente en su propio motion.div con fadeUp, así que si acá también
// se desplazara, los dos translateY se SUMAN (14px + 14px) y el hijo arranca
// antes que el padre, deshaciendo el escalonado que el padre intenta armar.
// El deslizamiento lo pone el padre; acá solo el ritmo interno.
const fadeUp = (delay = 0) => ({
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  transition: { duration: 0.35, delay, ease: 'easeOut' as const },
});

/** Todo color sale de tokens del DS — nunca un valor raw. */
const hsl = (v: string, a?: number) => (a == null ? `hsl(var(${v}))` : `hsl(var(${v}) / ${a})`);

/**
 * Barra fina de magnitud: dibuja como LARGO un número que ya se muestra como
 * texto al lado. No agrega métrica — solo le da forma al mismo dato.
 */
function MiniMeter({ value, varName, max = 100 }: { value: number; varName: string; max?: number }) {
  // Sin dato NO se dibuja la pista: una barra vacía se lee como "cero medido",
  // y acá el cero no está medido (mismo criterio que la celda sin tasa del
  // heatmap). El número real se sigue imprimiendo al lado sin coerción.
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return null;
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="h-1 rounded-full bg-foreground/10 mt-1" aria-hidden="true">
      <div
        className="h-full rounded-full transition-[width] duration-700"
        style={{
          width: `${pct}%`,
          background: `linear-gradient(90deg, ${hsl(varName, 0.55)}, ${hsl(varName)})`,
          boxShadow: `0 0 6px -1px ${hsl(varName, 0.7)}`,
        }}
      />
    </div>
  );
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

  // Dominio real del spread para la mini-barra del Δ. Es solo escala de dibujo:
  // no se imprime en ningún lado y no cambia ningún número de la tabla.
  const maxDelta = useMemo(
    () => rows.reduce((mx, r) => Math.max(mx, r.delta_puntos ?? 0), 0),
    [rows],
  );

  if (matrix.isLoading) {
    return (
      <div className="rounded-2xl border border-border bg-card/40 shadow-card3d p-5 skeleton-shimmer min-h-[300px]" />
    );
  }

  if (matrix.isError) {
    return (
      <div className="rounded-2xl border border-border bg-card/40 shadow-card3d p-5 text-sm text-danger">
        Error cargando recomendaciones: {matrix.error?.message}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-border bg-card/40 shadow-card3d p-5 text-center">
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
    <div className="space-y-5">
      {/* Stats banner — resumen accionable arriba de la tabla */}
      <motion.div {...fadeUp(0)} className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatsBanner tone="danger"  icon={ArrowRightLeft} label="Cambiar urgente"     value={urgentCount}   hint="Spread ≥ 20 pts entre el mejor y el peor carrier de la ciudad" />
        <StatsBanner tone="warning" icon={ArrowRightLeft} label="Considerar cambio"   value={cambioCount}   hint="Δ entre 10 y 20 puntos" />
        <StatsBanner tone="success" icon={CheckCircle2}   label="Ya están óptimas"    value={mantenerCount} hint="El mejor carrier ya es el más usado" />
      </motion.div>

      <motion.div {...fadeUp(0.14)} className="rounded-2xl border border-border bg-card/40 shadow-card3d hairline-top overflow-hidden">
        <header className="px-5 py-3.5 border-b border-border/60">
          <div className="flex items-center gap-2">
            <span className="w-9 h-9 rounded-xl border bg-warning/14 border-warning/30 text-warning glow-warning flex items-center justify-center flex-shrink-0" aria-hidden="true">
              <Lightbulb size={17} strokeWidth={2.25} />
            </span>
            <h2 className="text-sm font-semibold text-foreground">
              Recomendaciones de transportadora por ciudad
            </h2>
          </div>
          <p className="text-[11px] text-muted-foreground mt-1">
            {rows.length} ciudad{rows.length !== 1 ? 'es' : ''} analizada{rows.length !== 1 ? 's' : ''} ·
            {' '}Click en "Copiar" para mandar el dato al encargado de logística por WhatsApp
          </p>
        </header>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-card/95 [&_th]:backdrop-blur-sm">
            <tr className="border-b border-border">
              <th className="text-left px-5 py-2.5 hud-label font-normal">Ciudad</th>
              <th className="text-right px-3 py-2.5 hud-label font-normal">Vol.</th>
              <th className="text-left px-3 py-2.5 hud-label font-normal">Mejor carrier</th>
              <th className="text-left px-3 py-2.5 hud-label font-normal">Peor carrier</th>
              <th className="text-center px-3 py-2.5 hud-label font-normal" title="Diferencia de puntos entre el MEJOR y el PEOR carrier de la ciudad (el spread), no la ganancia exacta de cambiar desde tu carrier actual.">Δ pts</th>
              <th className="text-left px-3 py-2.5 hud-label font-normal">Acción</th>
              <th className="text-right px-3 py-2.5 hud-label font-normal"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <RecommendationRow key={`${row.ciudad}|${row.departamento}`} row={row} filters={filters} maxDelta={maxDelta} />
            ))}
          </tbody>
        </table>
      </div>
      </motion.div>
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
  return (
    <StatTile
      icon={Icon}
      label={label}
      value={value}
      tone={tone}
      title={hint}
      extra={<span className="text-[10px] text-muted-foreground block truncate">{hint}</span>}
    />
  );
}

// Tono semántico de la fila → barra lateral y badge de veredicto.
const ROW_BAR: Record<'success' | 'warning' | 'danger', string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger:  'bg-danger',
};
const ROW_BADGE: Record<'success' | 'warning' | 'danger', string> = {
  success: 'bg-success/14 border-success/30 text-success',
  warning: 'bg-warning/14 border-warning/30 text-warning',
  danger:  'bg-danger/14 border-danger/30 text-danger',
};

interface RowProps {
  row: CarrierRecommendation;
  filters: LogisticsFilters;
  /** Δ más grande de la tabla — domina la escala de la mini-barra del spread. */
  maxDelta: number;
}
function RecommendationRow({ row, filters, maxDelta }: RowProps) {
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

  // Mismos cortes que el color del texto del Δ — el token solo le da forma
  // (largo + degradado) al número que ya se imprime al lado.
  const deltaVar = delta >= 20 ? '--danger'
    : delta >= 10 ? '--warning'
    : delta >= 5 ? '--foreground'
    : '--muted-foreground';

  const handleCopy = async () => {
    const msg = buildWhatsAppMessage(row, filters);
    await copyToClipboard(msg, 'Mensaje copiado');
  };

  return (
    <tr className="border-b border-border/50 last:border-0 hover:bg-card/60 transition-colors duration-200">
      {/* Barra semántica lateral: el veredicto de la fila se lee antes del texto. */}
      <td className="relative px-5 py-2.5">
        <span className={`absolute left-0 top-2 bottom-2 w-1 rounded-full ${ROW_BAR[badgeTone]}`} aria-hidden="true" />
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
        <MiniMeter value={row.mejor_tasa_entrega} varName="--success" />
      </td>
      <td className="px-3 py-2.5">
        <div className="font-semibold text-foreground text-xs truncate max-w-[140px]" title={row.peor_transportadora}>
          {row.peor_transportadora}
        </div>
        <div className="font-mono tabular-nums text-danger text-[11px]" title={`${row.peor_resueltos} pedidos concluidos de ${row.peor_pedidos} totales`}>
          {row.peor_tasa_entrega.toFixed(1)}% · {row.peor_resueltos}r/{row.peor_pedidos}p
        </div>
        <MiniMeter value={row.peor_tasa_entrega} varName="--danger" />
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
        {/* El Δ viene en PUNTOS (rango real ~0-40), no en %. Dibujarlo contra
            un fondo de 0-100 dejaba la barra casi invisible justo en las filas
            críticas. Se escala contra el Δ MÁS GRANDE DE ESTA TABLA — un
            dominio medido, no un tope inventado. */}
        <div className="mx-auto w-12">
          <MiniMeter value={delta} varName={deltaVar} max={maxDelta} />
        </div>
      </td>
      <td className="px-3 py-2.5">
        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold border ${ROW_BADGE[badgeTone]}`}>
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
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-card/40 border border-border text-muted-foreground text-[11px] font-medium hover:text-foreground hover:border-border-strong transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          aria-label={`Copiar mensaje WhatsApp para ${row.ciudad}`}
          title="Copiar mensaje para WhatsApp"
        >
          <Copy size={13} aria-hidden="true" />
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

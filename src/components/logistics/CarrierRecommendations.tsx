import { memo, useMemo } from 'react';
import { motion } from 'framer-motion';
import { Lightbulb, Copy, ArrowRightLeft, CheckCircle2, Info } from 'lucide-react';
import { useCityCarrierMatrix } from '@/hooks/useCityCarrierMatrix';
import { deriveCarrierRecommendations, MIN_RESUELTOS_RANK } from '@/lib/carrierRecommendations';
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

  // Ciudades DISTINTAS que sí devolvió el server. Sirven para distinguir POR QUÉ
  // la tabla quedó vacía: 0 filas crudas = ninguna ciudad pasó la compuerta del
  // server (≥minOrders despachados); filas crudas sin recomendaciones = las
  // ciudades llegaron pero murieron en la compuerta client-side de concluidos
  // (MIN_RESUELTOS_RANK). Sin esta distinción el estado vacío mentía la causa.
  const nCiudadesCrudas = useMemo(
    () => new Set((matrix.data ?? []).map(r => `${r.ciudad}|${r.departamento ?? ''}`)).size,
    [matrix.data],
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

  // Propósito permanente de la pestaña — se ve con datos y sin datos, para que
  // "Decisiones" no sea un nombre mudo.
  const proposito = (
    <motion.header {...fadeUp(0)}>
      <h2 className="text-base font-semibold text-foreground">Decisiones de transportadora</h2>
      <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
        Compará qué transportadora entrega mejor en cada ciudad — y cambiá la que te está fallando.
      </p>
    </motion.header>
  );

  if (rows.length === 0) {
    const sinFilasCrudas = (matrix.data ?? []).length === 0;
    return (
      <div className="space-y-5">
        {proposito}
        <div className="rounded-2xl border border-border bg-card/40 shadow-card3d p-5 text-center">
          <Info size={28} className="mx-auto text-muted-foreground mb-2" aria-hidden="true" />
          {sinFilasCrudas ? (
            <>
              <p className="text-sm font-semibold text-foreground">Todavía no hay ciudades para comparar</p>
              <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto leading-relaxed">
                Esta pestaña compara qué transportadora te entrega mejor en cada ciudad. Todavía no hay
                ninguna ciudad con {minOrders} envíos despachados en este rango (los cancelados y
                pendientes no cuentan). Probá un rango más largo (90d).
              </p>
            </>
          ) : (
            <>
              <p className="text-sm font-semibold text-foreground">El rango es muy corto para comparar</p>
              <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto leading-relaxed">
                Hay {nCiudadesCrudas} {nCiudadesCrudas === 1 ? 'ciudad' : 'ciudades'} con envíos, pero
                ninguna transportadora junta todavía {MIN_RESUELTOS_RANK} pedidos concluidos en una misma
                ciudad — el rango es muy corto para comparar. Probá 90d o Histórico.
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  // Counts para el stats banner: los 4 buckets CUBREN todas las filas de la
  // tabla (invariante: suman rows.length). Antes las "Cambiar" con Δ<10 no
  // entraban en ningún tile ("0+0+8" sobre 12 filas) y las ciudades con una
  // sola transportadora medida inflaban "Ya están óptimas".
  const sinAltCount = rows.filter(r => r.recomendacion === 'Sin alternativa medida').length;
  const urgentCount = rows.filter(r =>
    r.recomendacion !== 'Sin alternativa medida'
    && r.mejor_transportadora !== r.carrier_actual_top
    && (r.delta_puntos ?? 0) >= 20
    && !r.mejor_prelim, // un mejor prelim nunca es "urgente" — su tasa puede moverse
  ).length;
  const cambioCount = rows.filter(r =>
    r.recomendacion !== 'Sin alternativa medida'
    && r.mejor_transportadora !== r.carrier_actual_top,
  ).length - urgentCount;
  const mantenerCount = rows.filter(r =>
    r.recomendacion !== 'Sin alternativa medida'
    && r.mejor_transportadora === r.carrier_actual_top,
  ).length;

  return (
    <div className="space-y-5">
      {proposito}

      {/* Stats banner — resumen accionable arriba de la tabla */}
      <motion.div {...fadeUp(0.05)} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatsBanner tone="danger"  icon={ArrowRightLeft} label="Cambiar urgente"     value={urgentCount}   hint="Spread ≥ 20 pts entre el mejor y el peor carrier de la ciudad" />
        <StatsBanner tone="warning" icon={ArrowRightLeft} label="Considerar cambio"   value={cambioCount}   hint="El mejor no es el más usado (Δ < 20 pts o tasa preliminar)" />
        <StatsBanner tone="success" icon={CheckCircle2}   label="Ya están óptimas"    value={mantenerCount} hint="El mejor carrier ya es el más usado" />
        <StatsBanner tone="neutral" icon={CheckCircle2}   label="Sin alternativa"     value={sinAltCount}   hint="Una sola transportadora con datos — no hay con qué comparar" />
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
  tone: 'success' | 'warning' | 'danger' | 'neutral';
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
      // duration 0: el dueño pidió números quietos — sin count-up al entrar.
      duration={0}
      extra={<span className="text-[10px] text-muted-foreground block truncate">{hint}</span>}
    />
  );
}

// Tono semántico de la fila → barra lateral y badge de veredicto.
const ROW_BAR: Record<'success' | 'warning' | 'danger' | 'neutral', string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger:  'bg-danger',
  neutral: 'bg-muted-foreground/50',
};
const ROW_BADGE: Record<'success' | 'warning' | 'danger' | 'neutral', string> = {
  success: 'bg-success/14 border-success/30 text-success',
  warning: 'bg-warning/14 border-warning/30 text-warning',
  danger:  'bg-danger/14 border-danger/30 text-danger',
  neutral: 'bg-muted/40 border-border text-muted-foreground',
};

interface RowProps {
  row: CarrierRecommendation;
  filters: LogisticsFilters;
  /** Δ más grande de la tabla — domina la escala de la mini-barra del spread. */
  maxDelta: number;
}
function RecommendationRow({ row, filters, maxDelta }: RowProps) {
  const sinAlternativa = row.recomendacion === 'Sin alternativa medida';
  const isMantener = !sinAlternativa && row.mejor_transportadora === row.carrier_actual_top;
  const delta = row.delta_puntos ?? 0;

  let badgeTone: 'success' | 'warning' | 'danger' | 'neutral';
  let badgeLabel: string;
  let badgeTitle: string | undefined;
  if (sinAlternativa) {
    // Una sola transportadora medida: mejor==peor, Δ=0. Antes salía "Cambiar"
    // (abandonar un carrier de desempeño desconocido hacia el único con datos).
    badgeTone = 'neutral';
    badgeLabel = 'Sin alternativa medida';
    badgeTitle = 'Solo una transportadora tiene pedidos concluidos en esta ciudad — no hay con qué compararla';
  } else if (isMantener) {
    badgeTone = 'success';
    badgeLabel = 'Mantener';
  } else if (delta >= 20 && !row.mejor_prelim) {
    badgeTone = 'danger';
    badgeLabel = 'Cambiar urgente';
  } else if (delta >= 20 && row.mejor_prelim) {
    // El heatmap de esta misma pestaña pinta gris "prelim." la celda del mejor
    // (cohorte inmaduro): un veredicto ROJO sobre esa misma tasa lo contradecía.
    badgeTone = 'warning';
    badgeLabel = 'Considerar cambio';
    badgeTitle = 'El mejor carrier todavía tiene la mayoría de sus pedidos en curso (tasa preliminar) — verificar antes de mover volumen';
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
        <div
          className={`font-mono tabular-nums text-[11px] ${row.mejor_prelim ? 'text-muted-foreground' : 'text-success'}`}
          title={`${row.mejor_resueltos} pedidos concluidos de ${row.mejor_pedidos} totales${row.mejor_prelim ? ' — cohorte inmaduro: la tasa todavía puede moverse' : ''}`}
        >
          {row.mejor_tasa_entrega.toFixed(1)}%{row.mejor_prelim ? ' ·prelim.' : ''} · {row.mejor_resueltos}r/{row.mejor_pedidos}p
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
        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold border ${ROW_BADGE[badgeTone]}`} title={badgeTitle}>
          {isMantener || sinAlternativa ? (
            <CheckCircle2 size={11} aria-hidden="true" />
          ) : (
            <ArrowRightLeft size={11} aria-hidden="true" />
          )}
          {badgeLabel}
          {!isMantener && !sinAlternativa && (
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

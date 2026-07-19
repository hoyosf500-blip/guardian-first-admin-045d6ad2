import { memo, useMemo, type CSSProperties } from 'react';
import { motion } from 'framer-motion';
import { Grid3x3, Info } from 'lucide-react';
import { useCityCarrierMatrix } from '@/hooks/useCityCarrierMatrix';
import {
  deriveDeliveryMaturity,
  isRatePreliminary,
  MIN_RESUELTOS_CONFIABLE,
  DELIVERY_MATURITY_THRESHOLD,
} from '@/lib/logisticsRates';
import type { LogisticsFilters } from '@/lib/logistics.types';

interface Props {
  filters: LogisticsFilters;
  /** Tope de ciudades. Default: 20 (top por volumen). */
  topCities?: number;
  /** Pedidos mínimos por ciudad para ser incluida. Default: 20. */
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
 * Heatmap transportadora × ciudad. Filas: ciudades (top N por volumen).
 * Columnas: transportadoras. Celdas: % de entrega coloreado.
 *
 * Verde (≥80%) → mejor / Amarillo (60-80%) → ok / Rojo (<60%) → malo /
 * Vacío gris → carrier no opera en esa ciudad.
 */
export default memo(function CarrierCityMatrix({
  filters,
  topCities = 20,
  minOrders = 20,
}: Props) {
  const matrix = useCityCarrierMatrix({ filters, minOrders, topCities });

  const { rows, carriers } = useMemo(() => {
    const data = matrix.data ?? [];
    const carrierSet = new Set<string>();
    const cityMap = new Map<string, {
      ciudad: string;
      departamento: string;
      total: number;
      byCarrier: Record<string, {
        /** null = todavía no hay NINGÚN desenlace (ni entregado ni devuelto). */
        tasa: number | null;
        total: number;
        entregados: number;
        resueltos: number;
        /** (entregados+devueltos+rechazados) ÷ total. Para decir POR QUÉ es prelim. */
        pctConcluido: number;
        /** muestra chica o cohorte sin concluir → no pintar verde/rojo. */
        prelim: boolean;
      }>;
    }>();

    for (const r of data) {
      carrierSet.add(r.transportadora);
      const key = r.ciudad;
      // Celdas con la tasa MADURA (÷ entregados+devueltos, sin rechazos ni
      // tránsito) — la misma que usa la tabla de recomendaciones de arriba.
      // Antes acá iba r.tasa_entrega cruda del RPC (÷ COUNT con tránsito) y el
      // heatmap pintaba rojo a carriers que la tabla declaraba óptimos.
      // `tasaEntregaMadura` es null A PROPÓSITO cuando no hay resueltos. Antes se
      // aplastaba con `?? 0` y una celda 100% en tránsito se pintaba "0% rojo",
      // igual que una transportadora que efectivamente falló todo. Se propaga el
      // null y el render lo muestra como "—" neutro.
      const m = deriveDeliveryMaturity(r.entregados, r.devueltos, r.total_pedidos, r.rechazados ?? 0);
      const cell = {
        tasa: m.tasaEntregaMadura,
        total: r.total_pedidos,
        entregados: r.entregados,
        resueltos: m.resueltos,
        pctConcluido: m.pctConcluido,
        // Mismo criterio que la tabla de transportadoras y el piso de muestra del
        // ranking de recomendaciones (MIN_RESUELTOS_RANK = MIN_RESUELTOS_CONFIABLE).
        prelim: isRatePreliminary(m),
      };
      const existing = cityMap.get(key);
      if (existing) {
        existing.byCarrier[r.transportadora] = cell;
      } else {
        cityMap.set(key, {
          ciudad: r.ciudad,
          departamento: r.departamento,
          total: r.ciudad_total,
          byCarrier: { [r.transportadora]: cell },
        });
      }
    }

    return {
      rows: Array.from(cityMap.values()).sort((a, b) => b.total - a.total),
      carriers: Array.from(carrierSet).sort(),
    };
  }, [matrix.data]);

  if (matrix.isLoading) {
    return (
      <div className="rounded-2xl border border-border bg-card/40 shadow-card3d p-5 skeleton-shimmer min-h-[300px]" />
    );
  }

  if (matrix.isError) {
    return (
      <div className="rounded-2xl border border-border bg-card/40 shadow-card3d p-5 text-sm text-danger">
        Error cargando matriz: {matrix.error?.message}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-border bg-card/40 shadow-card3d p-5 text-center">
        <Info size={28} className="mx-auto text-muted-foreground mb-2" aria-hidden="true" />
        <p className="text-sm font-semibold text-foreground">Sin datos para el heatmap</p>
        <p className="text-xs text-muted-foreground mt-1">
          No hay ciudades con ≥{minOrders} pedidos en este rango.
        </p>
      </div>
    );
  }

  return (
    <motion.div {...fadeUp(0.18)} className="rounded-2xl border border-border bg-card/40 shadow-card3d hairline-top overflow-hidden">
      <header className="px-5 py-3.5 border-b border-border/60">
        <div className="flex items-center gap-2">
          <span className="w-9 h-9 rounded-xl border bg-info/14 border-info/30 text-info glow-info flex items-center justify-center flex-shrink-0" aria-hidden="true">
            <Grid3x3 size={17} strokeWidth={2.25} />
          </span>
          <h2 className="text-sm font-semibold text-foreground">
            Matriz de desempeño: Transportadora × Ciudad
          </h2>
        </div>
        <p className="text-[11px] text-muted-foreground mt-1">
          % de entrega · Top {rows.length} ciudades por volumen · Solo carriers con ≥5 pedidos por ciudad
        </p>

        <div className="flex items-center gap-3 flex-wrap mt-3">
          <LegendSwatch varName="--success" label="≥80%" />
          <LegendSwatch varName="--warning" label="60–80%" />
          <LegendSwatch varName="--danger"  label="<60%" />
          <LegendSwatch neutral label="Sin datos" />
        </div>
        <p className="text-[10px] text-muted-foreground mt-1.5">
          Gris con “—” = todavía sin entregas ni devoluciones que midan a la transportadora
          (los rechazos del cliente no cuentan): no hay tasa, no es 0%.
          Gris con “prelim.” = menos de {MIN_RESUELTOS_CONFIABLE} pedidos concluidos
          o menos del {DELIVERY_MATURITY_THRESHOLD}% del cohorte concluido: la tasa aún no es confiable.
        </p>
      </header>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-card/95 [&_th]:backdrop-blur-sm">
            <tr className="border-b border-border">
              <th className="text-left px-5 py-2.5 hud-label font-normal sticky left-0 bg-card z-10 min-w-[160px]">
                Ciudad
              </th>
              <th className="text-right px-3 py-2.5 hud-label font-normal">
                Vol.
              </th>
              {carriers.map(c => (
                <th
                  key={c}
                  // hud-label-cased, NO hud-label: el contenido es el nombre de
                  // la transportadora TAL COMO LO MANDA DROPI. .hud-label
                  // mayusculiza y eso reescribe un dato que no es nuestro.
                  className="text-center px-3 py-2.5 hud-label-cased font-normal min-w-[86px]"
                  title={c}
                >
                  <span className="truncate inline-block max-w-[90px]">{c}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.ciudad} className="border-b border-border/50 last:border-0 hover:bg-card/60 transition-colors duration-200">
                <td className="px-5 py-2 sticky left-0 bg-card z-10">
                  <div className="font-semibold text-foreground truncate max-w-[150px]" title={row.ciudad}>
                    {row.ciudad}
                  </div>
                  {row.departamento && (
                    <div className="text-[10px] text-muted-foreground truncate max-w-[150px]">
                      {row.departamento}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                  {row.total.toLocaleString('es-CO')}
                </td>
                {carriers.map(c => {
                  const cell = row.byCarrier[c];
                  if (!cell) {
                    return (
                      <td key={c} className="px-1.5 py-1.5 text-center">
                        <span className="text-muted-foreground/50 text-[11px]">—</span>
                      </td>
                    );
                  }
                  // Sin desenlaces todavía: nada entregado NI devuelto. No hay tasa
                  // que mostrar — neutro, nunca rojo (no sabemos si va bien o mal).
                  // Tampoco lleva barra de magnitud: no hay magnitud que dibujar.
                  if (cell.tasa == null) {
                    return (
                      <td
                        key={c}
                        className="px-1.5 py-1.5 text-center"
                        title={`${c} en ${row.ciudad}: todavía sin entregas ni devoluciones que midan a la transportadora sobre ${cell.total} despachados. No hay tasa que mostrar (no es 0%).`}
                      >
                        <div className="rounded-xl px-2 py-1.5" style={neutralTile()}>
                          <div className="font-mono font-bold tabular-nums text-xs text-muted-foreground">
                            —
                          </div>
                          <div className="text-[9px] text-muted-foreground tabular-nums mt-0.5">
                            {cell.total}
                          </div>
                        </div>
                      </td>
                    );
                  }
                  // Prelim = tercer estado: hay número pero no concluye. Se dibuja
                  // en neutro (nunca verde/rojo) — sería un veredicto sobre ruido.
                  const tone = cell.prelim ? NEUTRAL_TONE : cellTone(cell.tasa);
                  const baseTitle = `${c} en ${row.ciudad}: ${cell.entregados}/${cell.total} entregados (${cell.tasa.toFixed(1)}%)`;
                  // El % NO es entregados÷total: es la tasa MADURA (÷ concluidos, sin
                  // tránsito ni rechazos). Sin esta aclaración el tooltip se lee
                  // "6/12 entregados (100.0%)" y la fracción no produce el número.
                  const denomNote = ` · el % es sobre ${cell.resueltos} concluido${cell.resueltos === 1 ? '' : 's'} (entregados+devueltos), no sobre ${cell.total}`;
                  // Motivo REAL del "prelim.": muestra chica, cohorte sin concluir, o ambos.
                  const prelimReasons = [
                    cell.resueltos < MIN_RESUELTOS_CONFIABLE
                      ? `solo ${cell.resueltos} concluido${cell.resueltos === 1 ? '' : 's'} (mínimo ${MIN_RESUELTOS_CONFIABLE})`
                      : null,
                    cell.pctConcluido < DELIVERY_MATURITY_THRESHOLD
                      ? `el cohorte concluyó ${cell.pctConcluido}% (mínimo ${DELIVERY_MATURITY_THRESHOLD}%)`
                      : null,
                  ].filter(Boolean).join(' y ');
                  const fill = Math.max(0, Math.min(100, cell.tasa));
                  return (
                    <td
                      key={c}
                      className="px-1.5 py-1.5 text-center"
                      title={
                        cell.prelim
                          ? `${baseTitle}${denomNote} · Preliminar: ${prelimReasons}, la tasa todavía no es confiable`
                          : `${baseTitle}${denomNote}`
                      }
                    >
                      <div
                        className="rounded-xl px-2 py-1.5"
                        style={cell.prelim ? neutralTile() : tile(tone.varName)}
                      >
                        <div className={`font-mono font-bold tabular-nums text-xs ${tone.text}`}>
                          {cell.tasa.toFixed(0)}%
                          {cell.prelim && <span className="font-normal text-[9px]"> prelim.</span>}
                        </div>
                        {/* Barra de magnitud: el mismo % dibujado como largo. */}
                        <div className="h-1 rounded-full bg-foreground/10 overflow-hidden mt-1" aria-hidden="true">
                          <div
                            className="h-full rounded-full transition-[width] duration-700"
                            style={{
                              width: `${fill}%`,
                              background: `linear-gradient(90deg, ${hsl(tone.varName, 0.5)}, ${hsl(tone.varName)})`,
                            }}
                          />
                        </div>
                        <div className="text-[9px] text-muted-foreground tabular-nums mt-0.5">
                          {cell.total}
                        </div>
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </motion.div>
  );
});

/** Tono por banda de la tasa. Cortes 80/60 — sin cambios. */
const CELL_TONES = {
  success: { varName: '--success', text: 'text-success' },
  warning: { varName: '--warning', text: 'text-warning' },
  danger:  { varName: '--danger',  text: 'text-danger' },
} as const;

/** Celda con tasa calculada pero NO confiable (muestra chica o cohorte en
 *  tránsito): se muestra el número, en tono neutro y marcado "prelim." — pintarla
 *  verde/roja sería un veredicto sobre ruido estadístico. Mismo criterio que la
 *  tabla de transportadoras. */
const NEUTRAL_TONE = { varName: '--muted-foreground', text: 'text-muted-foreground' } as const;

function cellTone(tasa: number): { varName: string; text: string } {
  if (tasa >= 80) return CELL_TONES.success;
  if (tasa >= 60) return CELL_TONES.warning;
  return CELL_TONES.danger;
}

/**
 * Fondo de la celda. El borde (hairline) y el glow van en UNA sola declaración
 * de box-shadow — mezclarlo con `ring-1` de Tailwind los pisaría entre sí
 * (es una única propiedad CSS), que fue exactamente el bug de las tarjetas planas.
 */
function tile(varName: string): CSSProperties {
  return {
    background: `linear-gradient(135deg, ${hsl(varName, 0.24)}, ${hsl(varName, 0.07)})`,
    boxShadow: `inset 0 0 0 1px ${hsl(varName, 0.32)}, 0 0 14px -8px ${hsl(varName, 0.8)}`,
  };
}

function neutralTile(): CSSProperties {
  return {
    background: hsl('--muted', 0.2),
    boxShadow: `inset 0 0 0 1px ${hsl('--border')}`,
  };
}

/**
 * El swatch usa EXACTAMENTE la misma receta que la celda que representa
 * (`tile()` / `neutralTile()`). Antes la leyenda iba al doble de saturación y
 * el swatch de "Sin datos" se pintaba con --muted-foreground mientras la celda
 * real usa --muted: eran dos colores distintos para la misma cosa, y una
 * leyenda que no se parece a la tabla no sirve de leyenda.
 */
function LegendSwatch({ varName, label, neutral }: { varName?: string; label: string; neutral?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground">
      <span
        className="w-2.5 h-2.5 rounded-[3px]"
        style={neutral ? neutralTile() : tile(varName!)}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}

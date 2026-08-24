import { memo, useMemo, useState } from 'react';
import { Download, Package, AlertOctagon } from 'lucide-react';
import { motion } from 'framer-motion';
import { formatCOP } from '@/lib/utils';
import { rowsToCsv, downloadCsv } from '@/lib/csvExport';
import { SortableHeader, type SortDir } from './SortableHeader';
import { deriveDeliveryMaturity, isRatePreliminary, MIN_RESUELTOS_CONFIABLE } from '@/lib/logisticsRates';
import type { ProductFailure } from '@/lib/logistics.types';

interface Props { rows: ProductFailure[]; }

// Fila enriquecida con los pedidos concluidos, para que el render decida
// entre pintar la barra o decir "—" (mismo criterio que CarrierStatsTable
// y CityReturnsTable, que ya tenían el guard).
//
// Las dos tasas son `number | null` A PROPÓSITO: sin desenlaces NO hay tasa.
// Aplastarlas a 0 hacía que la celda dijera "—" mientras el ORDEN y el CSV
// seguían valiendo 0 — o sea la tabla "Productos con menor tasa de entrega"
// encabezaba con productos que no tienen un solo pedido concluido, y el CSV
// exportaba 0 donde la pantalla dice "—". Un solo valor, una sola verdad.
//
// Los derivados nuevos siguen la misma regla: sin denominador → null, nunca 0.
type ProductRow = Omit<ProductFailure, 'tasa_entrega' | 'tasa_devolucion'> & {
  tasa_entrega: number | null;
  tasa_devolucion: number | null;
  /** valor_entregado ÷ entregados. null sin entregados o si la RPC vieja no manda valor. */
  ticket_prom: number | null;
  /** total_pedidos ÷ Σ total del rango, 0-100 (1 decimal). null si Σ es 0. */
  pct_volumen: number | null;
  /** Pedidos todavía sin desenlace: total − entregados − devueltos. */
  en_curso: number;
  _prelim: boolean;
  _resueltos: number;
};

type Key = keyof ProductRow;

/** Entrada escalonada de bloques — misma cascada que el Dashboard. */
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

// Mínimo de pedidos CONCLUIDOS (entregados+devueltos) para marcar "Crítico".
// Con la tasa madura, un producto con todo en tránsito daría 0% de entrega sin
// estar realmente fallando — este guard evita falsos críticos por inmadurez.
const CRITICO_MIN_RESUELTOS = 5;
function esCritico(r: Pick<ProductFailure, 'total_pedidos' | 'entregados' | 'devueltos'> & { tasa_entrega: number | null }): boolean {
  // Sin tasa medida no se puede declarar crítico. En la práctica no cambia
  // ningún veredicto (el guard de CRITICO_MIN_RESUELTOS ya exigía 5
  // concluidos, y con 5 concluidos la tasa nunca es null), pero deja el
  // contrato explícito ahora que la tasa puede venir vacía.
  if (r.tasa_entrega == null) return false;
  return r.total_pedidos >= 10
    && (r.entregados + r.devueltos) >= CRITICO_MIN_RESUELTOS
    && r.tasa_entrega < 30;
}

/** Relleno de barra por tono: degradado del MISMO token (claro→pleno) +
 *  halo. Un solo token por tono, nada de colores nuevos. */
const BAR_TONE = {
  success: { fill: 'linear-gradient(90deg, hsl(var(--success) / 0.45), hsl(var(--success)))', glow: 'hsl(var(--success) / 0.55)', text: 'text-success' },
  warning: { fill: 'linear-gradient(90deg, hsl(var(--warning) / 0.45), hsl(var(--warning)))', glow: 'hsl(var(--warning) / 0.55)', text: 'text-warning' },
  danger:  { fill: 'linear-gradient(90deg, hsl(var(--danger) / 0.45), hsl(var(--danger)))',   glow: 'hsl(var(--danger) / 0.55)',  text: 'text-danger' },
  neutral: { fill: 'linear-gradient(90deg, hsl(var(--foreground) / 0.18), hsl(var(--foreground) / 0.45))', glow: 'hsl(var(--foreground) / 0.25)', text: 'text-foreground' },
} as const;

/** Barra de tasa de entrega en el lenguaje del Dashboard: cifra en
 *  mono+tabular arriba y pista redondeada con relleno en degradado + glow
 *  abajo. Tono inverso al de devoluciones: <30% danger (producto crítico),
 *  30-60% warning, ≥60% success.
 *
 *  Si la tasa es PRELIMINAR (muestra chica / cohorte inmaduro) se pinta gris
 *  + sufijo, para no gritar rojo ni verde sobre 1-4 pedidos concluidos —
 *  mismo trato que ReturnRateBar en CityReturnsTable. */
function DeliveryRateBar({ value, prelim }: { value: number; prelim?: boolean }) {
  const pct = Math.max(0, Math.min(100, value));
  const t = BAR_TONE[prelim ? 'neutral' : pct < 30 ? 'danger' : pct < 60 ? 'warning' : 'success'];
  return (
    <div
      className="inline-flex w-full min-w-[5.5rem] max-w-[7.5rem] flex-col items-end gap-1.5 align-middle"
      title={prelim ? `Preliminar: menos de ${MIN_RESUELTOS_CONFIABLE} pedidos concluidos o cohorte inmaduro — la tasa aún no es confiable` : undefined}
    >
      <span className={`font-mono tabular-nums text-xs font-bold leading-none ${prelim ? 'text-muted-foreground' : t.text}`}>
        {/* Sin decimal: la tasa madura llega como ENTERO (floor) — "99.0%"
            aparentaba una precisión que el número no tiene. */}
        {Math.round(value)}%{prelim ? ' ·prelim.' : ''}
      </span>
      <div
        className="h-1.5 w-full rounded-full bg-foreground/10"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full rounded-full transition-[width] duration-700 ease-out"
          style={{ width: `${pct}%`, background: t.fill, boxShadow: `0 0 8px -1px ${t.glow}`, opacity: prelim ? 0.55 : 1 }}
          aria-hidden="true"
        />
      </div>
    </div>
  );
}

/** Severity badge — productos crónicamente fallidos (entrega <30%
 *  + ≥10 envíos) → invita a discontinuar del catálogo. */
function SeverityBadge({ row }: { row: ProductFailure }) {
  if (esCritico(row)) {
    return (
      <span className="pill pill-danger">
        <AlertOctagon size={9} aria-hidden="true" /> Crítico
      </span>
    );
  }
  return null;
}

export default memo(function ProductFailuresTable({ rows }: Props) {
  // Volumen primero (pedido del dueño): los productos que más mueven encabezan.
  // El orden viejo (tasa asc) ponía arriba productos con 1 concluido (0%/100%).
  const [sortKey, setSortKey] = useState<Key>('total_pedidos');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // tasa_entrega/tasa_devolucion → maduras (÷ entregados+devueltos). Conteos
  // crudos intactos. Sort/bars/CSV/"Crítico" usan la tasa madura.
  // Los derivados se redondean ACÁ (no en el render) para que el CSV diga
  // exactamente lo mismo que la pantalla.
  const matureRows = useMemo<ProductRow[]>(() => {
    const totalEnvios = rows.reduce((s, r) => s + (r.total_pedidos || 0), 0);
    return rows.map(r => {
      const m = deriveDeliveryMaturity(r.entregados, r.devueltos, r.total_pedidos, r.rechazados ?? 0);
      return {
        ...r,
        tasa_entrega: m.tasaEntregaMadura,
        tasa_devolucion: m.tasaDevolucionMadura,
        // Guard runtime `!= null` aunque el tipo diga number: con la RPC vieja
        // desplegada (Lovable no auto-aplica migraciones) valor_entregado llega
        // undefined y el ticket saldría $0 — un cero inventado.
        ticket_prom: r.valor_entregado != null && r.entregados > 0
          ? Math.round((r.valor_entregado / r.entregados) * 100) / 100
          : null,
        pct_volumen: totalEnvios > 0
          ? Math.round((r.total_pedidos / totalEnvios) * 1000) / 10
          : null,
        en_curso: Math.max(0, r.total_pedidos - r.entregados - r.devueltos),
        _prelim: isRatePreliminary(m),
        _resueltos: m.resueltos,
      };
    });
  }, [rows]);

  const sorted = useMemo(() => {
    const out = [...matureRows];
    out.sort((a, b) => {
      // En sorts por TASA, lo preliminar (muestra chica / cohorte inmaduro /
      // sin tasa) va DESPUÉS de lo confiable: un 0% sobre 2 concluidos no es
      // "el peor producto", es una tasa que todavía no existe.
      if (sortKey === 'tasa_entrega' || sortKey === 'tasa_devolucion') {
        if (a._prelim !== b._prelim) return a._prelim ? 1 : -1;
      }
      const av = a[sortKey];
      const bv = b[sortKey];
      // Lo NO MEDIDO va al final en CUALQUIER dirección. Un producto sin
      // pedidos concluidos no es "el peor" ni "el mejor": no tiene tasa.
      // Antes valía 0 y encabezaba la tabla de peores con el orden por defecto.
      const aNull = av == null;
      const bNull = bv == null;
      if (aNull || bNull) return aNull && bNull ? 0 : aNull ? 1 : -1;
      if (typeof av === 'number' && typeof bv === 'number') {
        return sortDir === 'asc' ? av - bv : bv - av;
      }
      return sortDir === 'asc'
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
    return out;
  }, [matureRows, sortKey, sortDir]);

  const criticalCount = useMemo(
    () => sorted.filter(esCritico).length,
    [sorted],
  );

  const totals = useMemo(() => sorted.reduce(
    (acc, r) => {
      acc.envios += r.total_pedidos;
      acc.entregados += r.entregados;
      acc.devueltos += r.devueltos;
      acc.enCurso += r.en_curso;
      if (r.valor_entregado != null) {
        acc.valorEntregado += r.valor_entregado;
        acc.tieneValorEntregado = true;
      }
      acc.valorPerdido += r.valor_perdido ?? 0;
      return acc;
    },
    { envios: 0, entregados: 0, devueltos: 0, enCurso: 0, valorEntregado: 0, valorPerdido: 0, tieneValorEntregado: false },
  ), [sorted]);
  const totalLost = totals.valorPerdido;

  const onSort = (k: Key) => {
    if (k === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(k); setSortDir(k === 'tasa_entrega' ? 'asc' : 'desc'); }
  };

  const exportCsv = () => {
    // Tipado sobre ProductRow (tasas nullable): `escapeCell` ya emite celda
    // VACÍA ante null, así que el CSV dice lo mismo que la pantalla — antes
    // exportaba 0 donde la tabla mostraba "—".
    const csv = rowsToCsv<ProductRow>(
      ['producto', 'total_pedidos', 'pct_volumen', 'entregados', 'devueltos',
       'en_curso', 'tasa_entrega', 'tasa_devolucion', 'ticket_prom',
       'valor_entregado', 'valor_perdido'],
      sorted,
    );
    downloadCsv(`logistica-productos-${new Date().toISOString().split('T')[0]}.csv`, csv);
  };

  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-card/40 p-10 text-center shadow-card3d hairline-top">
        <div className="mx-auto mb-3 flex h-9 w-9 items-center justify-center rounded-xl border bg-muted/60 border-border">
          <Package size={17} className="text-muted-foreground" aria-hidden="true" />
        </div>
        <p className="text-sm font-semibold text-foreground mb-1">Sin datos de productos</p>
        <p className="text-xs text-muted-foreground max-w-sm mx-auto">
          No hay productos con suficientes pedidos en este rango. Probá con un rango más amplio.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* KPI de arriba. Cards ESTÁTICAS a pedido del dueño ("quitá la animación
          del mouse"): sin TiltCard/sheen/CountUp — el dato quieto se lee mejor. */}
      <motion.div {...fadeUp(0)} className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {criticalCount > 0 && (
          <div className="bg-card/40 border border-border rounded-2xl p-4 shadow-card3d h-full flex flex-col justify-between">
            <div>
              <div className="flex items-start justify-between gap-2">
                <span className="w-9 h-9 rounded-xl border flex items-center justify-center flex-shrink-0 bg-danger/14 border-danger/30 text-danger glow-danger">
                  <AlertOctagon size={17} aria-hidden="true" strokeWidth={2.25} />
                </span>
              </div>
              <div className="text-[34px] font-bold leading-none mt-3 text-danger">
                {criticalCount}
                <span className="text-sm font-medium text-muted-foreground ml-1.5">
                  {criticalCount === 1 ? 'producto' : 'productos'}
                </span>
              </div>
              <div className="hud-label text-subtle mt-2">Productos críticos</div>
              <div className="text-[11px] font-medium text-danger mt-1.5 leading-snug">
                Tasa de entrega &lt;30% — considerar discontinuar
              </div>
            </div>
          </div>
        )}
        {totalLost > 0 && (
          <div className="bg-card/40 border border-border rounded-3xl p-6 shadow-card3d-lg h-full flex flex-col">
            <div className="flex items-center gap-3">
              <span className="w-9 h-9 rounded-xl border flex items-center justify-center flex-shrink-0 bg-warning/14 border-warning/30 text-warning glow-warning">
                <Package size={17} aria-hidden="true" strokeWidth={2.25} />
              </span>
              <span className="hud-label">Venta perdida por devoluciones</span>
            </div>
            <div className="mt-4 font-mono tabular-nums text-[34px] font-bold leading-none text-warning">
              {formatCOP(totalLost)}
            </div>
            <div className="text-[11px] font-medium text-muted-foreground mt-2 leading-snug">
              de los {sorted.length} productos listados · incluye rechazos
            </div>
          </div>
        )}
      </motion.div>

      <motion.section
        {...fadeUp(0.06)}
        className="bg-card/40 border border-border rounded-2xl p-5 shadow-card3d hairline-top transition-colors duration-200 hover:border-border-strong"
      >
        <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
          <div className="flex items-center gap-2 min-w-0">
            <Package size={14} className="text-warning" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-foreground">
              Productos: volumen y entrega
            </h2>
            <span className="pill pill-neutral">{sorted.length}</span>
          </div>
          <button
            type="button"
            onClick={exportCsv}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-card/40 border border-border text-muted-foreground text-xs font-medium hover:text-foreground hover:border-border-strong transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          >
            <Download size={13} aria-hidden="true" /> CSV
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-card/95 [&_th]:backdrop-blur-sm">
              <tr className="border-b border-border">
                <th className="px-3 py-2.5 text-left hud-label font-normal w-10">#</th>
                <th className="px-3 py-2.5 text-left"><SortableHeader<Key> label="Producto" sortKey="producto" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right"><SortableHeader<Key> label="Envíos" sortKey="total_pedidos" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right"><SortableHeader<Key> label="% del vol." sortKey="pct_volumen" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right"><SortableHeader<Key> label="Entregados" sortKey="entregados" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right"><SortableHeader<Key> label="Devueltos" sortKey="devueltos" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right"><SortableHeader<Key> label="En curso" sortKey="en_curso" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right"><SortableHeader<Key> label="Entrega %" sortKey="tasa_entrega" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right"><SortableHeader<Key> label="Devol %" sortKey="tasa_devolucion" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right"><SortableHeader<Key> label="Ticket prom." sortKey="ticket_prom" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right"><SortableHeader<Key> label="Valor entregado" sortKey="valor_entregado" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right"><SortableHeader<Key> label="Valor perdido" sortKey="valor_perdido" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, idx) => (
                <tr
                  key={r.producto}
                  className="border-b border-border/50 last:border-0 hover:bg-card/60 transition-colors duration-200"
                >
                  <td className="px-3 py-2.5">
                    <span className="font-mono text-[11px] font-bold tabular-nums text-muted-foreground">
                      {String(idx + 1).padStart(2, '0')}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 max-w-md">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-semibold text-foreground truncate" title={r.producto}>{r.producto}</span>
                      <SeverityBadge row={r} />
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-foreground">{r.total_pedidos.toLocaleString('es-CO')}</td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-muted-foreground">
                    {r.pct_volumen == null ? '—' : `${r.pct_volumen.toFixed(1)}%`}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums font-bold text-success">{r.entregados.toLocaleString('es-CO')}</td>
                  {/* `devueltos` INCLUYE los rechazos del cliente, pero la tasa
                      madura los EXCLUYE (decisión dueño 2026-06-24: un rechazo no
                      mide a la transportadora). Sin esta nota, "Devueltos: 1" al
                      lado de "100%" parecía un bug — era un rechazo. */}
                  <td
                    className="px-3 py-2.5 text-right font-mono tabular-nums font-bold text-danger"
                    title={(r.rechazados ?? 0) > 0 ? `Incluye ${r.rechazados} rechazo(s) del cliente, que no bajan la tasa de entrega` : undefined}
                  >
                    {r.devueltos.toLocaleString('es-CO')}
                    {(r.rechazados ?? 0) > 0 && (
                      <span className="ml-1 text-[10px] font-normal text-muted-foreground">({r.rechazados}R)</span>
                    )}
                  </td>
                  <td
                    className="px-3 py-2.5 text-right font-mono tabular-nums text-muted-foreground"
                    title="Pedidos aún sin desenlace: en tránsito, novedad o pendiente"
                  >
                    {r.en_curso.toLocaleString('es-CO')}
                  </td>
                  {/* Sin desenlaces (0 entregados+devueltos) la tasa NO es 0% — no
                      hay dato. Mostrar 0.0% en rojo hacía ver "pésimo" a un producto
                      cuyos pedidos siguen todos en tránsito. Mismo guard que
                      CarrierStatsTable y CityReturnsTable. */}
                  {r.tasa_entrega == null ? (
                    <td className="px-3 py-2.5 text-right font-mono text-muted-foreground" title="Sin pedidos concluidos aún">—</td>
                  ) : (
                    <td className="px-3 py-2.5 text-right"><DeliveryRateBar value={r.tasa_entrega} prelim={r._prelim} /></td>
                  )}
                  {r.tasa_devolucion == null ? (
                    <td className="px-3 py-2.5 text-right font-mono text-muted-foreground" title="Sin pedidos concluidos aún">—</td>
                  ) : (
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-muted-foreground">
                      {r.tasa_devolucion.toFixed(1)}%{r._prelim ? ' ·prelim.' : ''}
                    </td>
                  )}
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-foreground" title="Valor entregado ÷ entregados">
                    {r.ticket_prom == null ? '—' : formatCOP(r.ticket_prom)}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-success">
                    {r.valor_entregado == null ? '—' : formatCOP(r.valor_entregado)}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-danger">{formatCOP(r.valor_perdido)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              {/* Totales del rango listado. Las tasas y el ticket NO se suman
                  (serían promedios de promedios); van en "—". */}
              <tr className="border-t border-border">
                <td className="px-3 py-2.5" />
                <td className="px-3 py-2.5 hud-label text-subtle">Totales</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums font-bold text-foreground">{totals.envios.toLocaleString('es-CO')}</td>
                <td className="px-3 py-2.5 text-right font-mono text-muted-foreground">—</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums font-bold text-success">{totals.entregados.toLocaleString('es-CO')}</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums font-bold text-danger">{totals.devueltos.toLocaleString('es-CO')}</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums text-muted-foreground">{totals.enCurso.toLocaleString('es-CO')}</td>
                <td className="px-3 py-2.5 text-right font-mono text-muted-foreground">—</td>
                <td className="px-3 py-2.5 text-right font-mono text-muted-foreground">—</td>
                <td className="px-3 py-2.5 text-right font-mono text-muted-foreground">—</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums font-bold text-success">
                  {totals.tieneValorEntregado ? formatCOP(totals.valorEntregado) : '—'}
                </td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums font-bold text-danger">{formatCOP(totals.valorPerdido)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </motion.section>
    </div>
  );
});

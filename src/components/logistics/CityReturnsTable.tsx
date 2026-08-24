import { memo, useMemo, useState } from 'react';
import { Download, MapPin, AlertTriangle } from 'lucide-react';
import { motion } from 'framer-motion';
import { formatCOP } from '@/lib/utils';
import { rowsToCsv, downloadCsv } from '@/lib/csvExport';
import { SortableHeader, type SortDir } from './SortableHeader';
import { deriveDeliveryMaturity, isRatePreliminary, MIN_RESUELTOS_CONFIABLE } from '@/lib/logisticsRates';
import type { CityReturns } from '@/lib/logistics.types';

interface Props { rows: CityReturns[]; }

// Fila enriquecida con la madurez para que el render decida atenuar/marcar prelim.
// Tasas nullable a propósito (mismo criterio que ProductFailuresTable): sin
// desenlaces NO hay tasa. Aplastarlas a 0 dejaba la celda diciendo "—" mientras
// el ORDEN y el CSV seguían valiendo 0.
type CityRow = Omit<CityReturns, 'tasa_entrega' | 'tasa_devolucion'> & {
  tasa_entrega: number | null;
  tasa_devolucion: number | null;
  /** total − entregados − devueltos: lo que todavía viaja. */
  en_camino: number;
  /** valor_perdido ÷ devueltos. null (nunca 0) si no hay devoluciones. */
  valor_por_devolucion: number | null;
  /** total_pedidos ÷ Σ total_pedidos de las filas LISTADAS (no del país). */
  pct_volumen: number | null;
  _prelim: boolean;
  _resueltos: number;
};

type Key = keyof CityRow;

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

/** Relleno de barra por tono: degradado del MISMO token (claro→pleno) +
 *  halo. Un solo token por tono, nada de colores nuevos. */
const BAR_TONE = {
  danger:  { fill: 'linear-gradient(90deg, hsl(var(--danger) / 0.45), hsl(var(--danger)))',   glow: 'hsl(var(--danger) / 0.55)',  text: 'text-danger' },
  warning: { fill: 'linear-gradient(90deg, hsl(var(--warning) / 0.45), hsl(var(--warning)))', glow: 'hsl(var(--warning) / 0.55)', text: 'text-warning' },
  neutral: { fill: 'linear-gradient(90deg, hsl(var(--foreground) / 0.18), hsl(var(--foreground) / 0.45))', glow: 'hsl(var(--foreground) / 0.25)', text: 'text-foreground' },
} as const;

/** Barra de tasa de devolución en el lenguaje del Dashboard: cifra en
 *  mono+tabular arriba y pista redondeada con relleno en degradado + glow
 *  abajo (misma receta que la barra de meta del Dashboard, con el tono
 *  semántico de la severidad en vez del acento).
 *
 *  El tono escala según severidad: <15% neutral, 15-30% warning, ≥30%
 *  danger. Si la tasa es PRELIMINAR (muestra chica / cohorte inmaduro) se
 *  pinta gris + sufijo, para no gritar rojo sobre 1-4 pedidos concluidos. */
function ReturnRateBar({ value, prelim }: { value: number; prelim?: boolean }) {
  const pct = Math.max(0, Math.min(100, value));
  const tone = prelim ? 'neutral' : pct >= 30 ? 'danger' : pct >= 15 ? 'warning' : 'neutral';
  const t = BAR_TONE[tone];
  return (
    <div
      className="inline-flex w-full min-w-[5.5rem] max-w-[7.5rem] flex-col items-end gap-1.5 align-middle"
      title={prelim ? `Preliminar: menos de ${MIN_RESUELTOS_CONFIABLE} pedidos concluidos — la tasa aún no es confiable` : undefined}
    >
      <span className={`font-mono tabular-nums text-xs font-bold leading-none ${prelim ? 'text-muted-foreground' : t.text}`}>
        {value.toFixed(1)}%{prelim ? ' ·prelim.' : ''}
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
          style={{
            width: `${pct}%`,
            background: t.fill,
            boxShadow: `0 0 8px -1px ${t.glow}`,
            opacity: prelim ? 0.55 : 1,
          }}
          aria-hidden="true"
        />
      </div>
    </div>
  );
}

export default memo(function CityReturnsTable({ rows }: Props) {
  // Volumen primero (pedido del dueño: "1 envío no es data"): abrir ordenado
  // por tasa ponía PRIMERA a una ciudad con 1 envío devuelto (100% prelim.),
  // como si fuera la peor plaza. Por Envíos, lo primero que se ve es donde
  // de verdad hay operación.
  const [sortKey, setSortKey] = useState<Key>('total_pedidos');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // tasa_entrega/tasa_devolucion → maduras (÷ entregados+devueltos). Conteos
  // crudos intactos. Sort/bars/CSV usan la tasa madura automáticamente.
  // `_prelim` marca las tasas de muestra chica / cohorte inmaduro para atenuarlas.
  const matureRows = useMemo<CityRow[]>(() => {
    const totalEnvios = rows.reduce((s, r) => s + (r.total_pedidos ?? 0), 0);
    return rows.map(r => {
      const m = deriveDeliveryMaturity(r.entregados, r.devueltos, r.total_pedidos, r.rechazados ?? 0);
      return {
        ...r,
        tasa_entrega: m.tasaEntregaMadura,
        tasa_devolucion: m.tasaDevolucionMadura,
        en_camino: r.total_pedidos - r.entregados - r.devueltos,
        valor_por_devolucion: r.devueltos > 0 ? r.valor_perdido / r.devueltos : null,
        pct_volumen: totalEnvios > 0 ? (r.total_pedidos / totalEnvios) * 100 : null,
        _prelim: isRatePreliminary(m),
        _resueltos: m.resueltos,
      };
    });
  }, [rows]);

  const sorted = useMemo(() => {
    const out = [...matureRows];
    // Al ordenar por TASA, lo preliminar (o sin tasa) va SIEMPRE después de lo
    // confiable — "1 envío no es data": una ciudad con 1 devuelto (100%
    // prelim.) no puede salir por encima de una con 40 concluidos. Dentro de
    // cada grupo sí manda la dirección elegida.
    const ordenPorTasa = sortKey === 'tasa_entrega' || sortKey === 'tasa_devolucion';
    out.sort((a, b) => {
      if (ordenPorTasa) {
        const aDebil = a._prelim || a[sortKey] == null;
        const bDebil = b._prelim || b[sortKey] == null;
        if (aDebil !== bDebil) return aDebil ? 1 : -1;
      }
      const av = a[sortKey];
      const bv = b[sortKey];
      // Lo NO MEDIDO va al final en cualquier dirección: una ciudad sin
      // pedidos concluidos no es "la que más devuelve", no tiene tasa.
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

  const totales = useMemo(() => matureRows.reduce(
    (t, r) => ({
      envios: t.envios + (r.total_pedidos ?? 0),
      entregados: t.entregados + (r.entregados ?? 0),
      enCamino: t.enCamino + r.en_camino,
      devueltos: t.devueltos + (r.devueltos ?? 0),
      valorPerdido: t.valorPerdido + (r.valor_perdido ?? 0),
    }),
    { envios: 0, entregados: 0, enCamino: 0, devueltos: 0, valorPerdido: 0 },
  ), [matureRows]);

  const onSort = (k: Key) => {
    if (k === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(k); setSortDir('desc'); }
  };

  const exportCsv = () => {
    // Tipado sobre CityRow (tasas nullable): `escapeCell` emite celda VACÍA
    // ante null, así el CSV dice lo mismo que la pantalla. Los derivados van
    // redondeados solo para el archivo (los floats crudos de la división
    // ensucian el Excel del dueño).
    const filas = sorted.map(r => ({
      ...r,
      valor_por_devolucion: r.valor_por_devolucion == null ? null : Math.round(r.valor_por_devolucion * 100) / 100,
      pct_volumen: r.pct_volumen == null ? null : Math.round(r.pct_volumen * 10) / 10,
    }));
    const csv = rowsToCsv<CityRow>(
      ['ciudad', 'departamento', 'total_pedidos', 'entregados', 'en_camino', 'devueltos',
       'tasa_entrega', 'tasa_devolucion', 'valor_perdido', 'valor_por_devolucion', 'pct_volumen'],
      filas,
    );
    downloadCsv(`logistica-ciudades-${new Date().toISOString().split('T')[0]}.csv`, csv);
  };

  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-card/40 p-10 text-center shadow-card3d hairline-top">
        <div className="mx-auto mb-3 flex h-9 w-9 items-center justify-center rounded-xl border bg-muted/60 border-border">
          <MapPin size={17} className="text-muted-foreground" aria-hidden="true" />
        </div>
        <p className="text-sm font-semibold text-foreground mb-1">Sin datos de ciudades</p>
        {/* La población de esta tabla son los envíos DESPACHADOS con ciudad,
            no "ciudades con devoluciones": decir lo segundo hacía leer un
            rango sin despachos como "no se me devolvió nada". */}
        <p className="text-xs text-muted-foreground max-w-sm mx-auto">
          No hay envíos despachados con ciudad en este rango. Probá con un rango más amplio o quitá el filtro de ciudad.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Card hero de la pestaña Ciudades: la plata perdida. El rótulo dice
          EXACTAMENTE qué suma: el server corta este listado por VOLUMEN de
          devoluciones (no por tasa) y la cifra es solo sobre las filas
          listadas — llamarlo "mayor tasa" o dejarlo sin universo hacía leer
          la cifra como el total del rango. */}
      {totales.valorPerdido > 0 && (
        <motion.div {...fadeUp(0)}>
          <div className="hairline-top bg-card/40 border border-border rounded-3xl p-6 shadow-card3d-lg flex flex-col transition-colors duration-200 hover:border-border-strong">
            <div className="flex items-center gap-3">
              <span className="w-9 h-9 rounded-xl border flex items-center justify-center flex-shrink-0 bg-danger/14 border-danger/30 text-danger glow-danger">
                <AlertTriangle size={17} aria-hidden="true" strokeWidth={2.25} />
              </span>
              <span className="hud-label">Venta perdida por devoluciones</span>
            </div>
            <div className="mt-4 font-mono tabular-nums text-[34px] font-bold leading-none text-danger num-glow-danger">
              {formatCOP(totales.valorPerdido)}
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground leading-snug">
              en las {sorted.length} ciudades listadas (las de más devoluciones del rango) · incluye rechazos del cliente
            </p>
          </div>
        </motion.div>
      )}

      <motion.section
        {...fadeUp(0.06)}
        className="bg-card/40 border border-border rounded-2xl p-5 shadow-card3d hairline-top transition-colors duration-200 hover:border-border-strong"
      >
        <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
          <div className="flex items-center gap-2 min-w-0">
            <MapPin size={14} className="text-danger" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-foreground">
              Ciudades con más devoluciones
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
                <th className="px-3 py-2.5 text-left"><SortableHeader<Key> label="Ciudad" sortKey="ciudad" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-left"><SortableHeader<Key> label="Depto" sortKey="departamento" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right"><SortableHeader<Key> label="Envíos" sortKey="total_pedidos" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right"><SortableHeader<Key> label="Entregados" sortKey="entregados" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right"><SortableHeader<Key> label="En camino" sortKey="en_camino" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right"><SortableHeader<Key> label="Devueltos" sortKey="devueltos" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right"><SortableHeader<Key> label="Devol %" sortKey="tasa_devolucion" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right"><SortableHeader<Key> label="Valor perdido" sortKey="valor_perdido" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right"><SortableHeader<Key> label="$ x devol." sortKey="valor_por_devolucion" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right"><SortableHeader<Key> label="% del vol." sortKey="pct_volumen" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, idx) => (
                <tr
                  key={`${r.ciudad}|${r.departamento}`}
                  className="border-b border-border/50 last:border-0 hover:bg-card/60 transition-colors duration-200"
                >
                  <td className="px-3 py-2.5">
                    <span className="font-mono text-[11px] font-bold tabular-nums text-muted-foreground">
                      {String(idx + 1).padStart(2, '0')}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 font-semibold text-foreground">{r.ciudad}</td>
                  <td className="px-3 py-2.5 text-muted-foreground">{r.departamento || '—'}</td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-foreground">{r.total_pedidos.toLocaleString('es-CO')}</td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-success">{r.entregados.toLocaleString('es-CO')}</td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-info">{r.en_camino.toLocaleString('es-CO')}</td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums font-bold text-danger">{r.devueltos.toLocaleString('es-CO')}</td>
                  {/* Sin desenlaces no hay tasa: "0.0%" hacía ver perfecta a una
                      ciudad donde simplemente no concluyó ningún pedido todavía.
                      Con muestra chica se marca prelim. (gris) en vez de rojo. */}
                  <td className="px-3 py-2.5 text-right">
                    {r.tasa_devolucion == null
                      ? <span className="font-mono text-muted-foreground" title="Sin pedidos concluidos aún">—</span>
                      : <ReturnRateBar value={r.tasa_devolucion} prelim={r._prelim} />}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-danger">{formatCOP(r.valor_perdido)}</td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-muted-foreground">
                    {r.valor_por_devolucion == null
                      ? <span title="Sin devoluciones — no hay qué promediar">—</span>
                      : formatCOP(r.valor_por_devolucion)}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-muted-foreground">
                    {r.pct_volumen == null ? '—' : `${r.pct_volumen.toFixed(1)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border bg-card/60">
                <td colSpan={3} className="px-3 py-2.5 hud-label">Totales</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums font-bold text-foreground">{totales.envios.toLocaleString('es-CO')}</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums font-bold text-success">{totales.entregados.toLocaleString('es-CO')}</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums font-bold text-info">{totales.enCamino.toLocaleString('es-CO')}</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums font-bold text-danger">{totales.devueltos.toLocaleString('es-CO')}</td>
                {/* Las tasas por ciudad no se suman ni se promedian a ojo. */}
                <td className="px-3 py-2.5 text-right font-mono text-muted-foreground">—</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums font-bold text-danger">{formatCOP(totales.valorPerdido)}</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums text-muted-foreground">
                  {totales.devueltos > 0 ? formatCOP(totales.valorPerdido / totales.devueltos) : '—'}
                </td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums text-muted-foreground">
                  {totales.envios > 0 ? '100%' : '—'}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </motion.section>
    </div>
  );
});

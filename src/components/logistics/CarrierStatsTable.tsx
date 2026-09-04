import { memo, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Download, Truck, Trophy, Layers } from 'lucide-react';
import { formatCOP } from '@/lib/utils';
import { rowsToCsv, downloadCsv } from '@/lib/csvExport';
import { SortableHeader, type SortDir } from './SortableHeader';
import { deriveDeliveryMaturity, isRatePreliminary, MIN_RESUELTOS_CONFIABLE } from '@/lib/logisticsRates';
import type { CarrierStats } from '@/lib/logistics.types';
import type { FleteCarrierAgg } from '@/lib/fleteByCarrier';

interface Props {
  rows: CarrierStats[];
  /** Flete promedio por carrier (client-side, opcional) — sin él la columna va en '—'. */
  fletePorCarrier?: Map<string, FleteCarrierAgg>;
  /** true si la muestra de flete se cortó en el tope de páginas (rangos 365d/
   *  Histórico con +10.000 pedidos): el promedio va rotulado "· parcial" en vez
   *  de presentarse como completo. */
  fleteParcial?: boolean;
}

// Fila enriquecida con la madurez de la tasa (para atenuar/marcar prelim.).
// Tasas nullable a propósito (mismo criterio que CityReturnsTable y
// ProductFailuresTable): sin desenlaces NO hay tasa. Aplastarlas a 0 dejaba la
// celda diciendo "— sin concluidos" mientras el ORDEN y el CSV valían 0.
// Los _derivados (ticket, pérdida por devolución, % del volumen) salen de
// campos que el RPC YA trae — pedido del dueño 23-ago-2026: "en transportadora
// deben estar los datos más desglosados de toda la operación".
type CarrierRow = Omit<CarrierStats, 'tasa_entrega' | 'tasa_devolucion'> & {
  tasa_entrega: number | null;
  tasa_devolucion: number | null;
  _prelim: boolean;
  _resueltos: number;
  /** valor_entregado ÷ entregados — null sin entregados (no un $0 falso). */
  _ticketProm: number | null;
  /** valor_perdido ÷ devueltos — null sin devueltos. */
  _perdidaPorDevol: number | null;
  /** % del volumen total del período que va con esta transportadora. */
  _sharePct: number;
  /** Flete promedio por pedido ENTREGADO (orders.flete, client-side) — null sin muestra. */
  _fleteProm: number | null;
  /** Flete QUEMADO en devoluciones (suma) — null sin devoluciones con flete. */
  _fleteDevol: number | null;
};

type Key = keyof CarrierRow;

// Sin umbral-juicio: acá vivía DELIVERY_TARGET=70 ("benchmark COD Colombia")
// que pintaba verde/amarillo/rojo a TODA tienda — incluida la de Ecuador.
// Es la misma clase de juicio con umbral colombiano por la que el dueño
// eliminó el Semáforo de salud financiera (23-ago-2026). La barra muestra el
// número; el juicio lo pone el dueño.

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

// ──────────────────────────────────────────────────────────────
// Sub-components — pequeños, sin estado, solo presentación.
// ──────────────────────────────────────────────────────────────

/** Token semántico por tono. El tono PRELIMINAR (muestra chica / cohorte
 *  inmaduro) es un tercer estado real, no un gris decorativo: significa
 *  "hay número pero todavía no concluye". */
const TONE_VAR: Record<'success' | 'danger' | 'warning' | 'info' | 'neutral', string> = {
  success: '--success',
  danger:  '--danger',
  warning: '--warning',
  info:    '--info',
  neutral: '--muted-foreground',
};

/** Barra de tasa de la tabla detalle. Pista redondeada + relleno con el
 *  degradado del tono y glow, y el valor en mono al lado (antes el número iba
 *  encajonado DENTRO de la barra). Si la tasa es PRELIMINAR se atenúa a gris +
 *  sufijo, para no pintar 100% verde sobre 1 pedido concluido. */
function DataBar({ value, tone, prelim }: { value: number; tone: 'success' | 'danger' | 'warning' | 'info' | 'neutral'; prelim?: boolean }) {
  const pct = Math.max(0, Math.min(100, value));
  const t = prelim ? 'neutral' : tone;
  const v = TONE_VAR[t];
  return (
    <div
      className="flex items-center justify-end gap-2 min-w-[112px]"
      style={prelim ? { opacity: 0.55 } : undefined}
      title={prelim ? `Preliminar: menos de ${MIN_RESUELTOS_CONFIABLE} pedidos concluidos o cohorte aún inmaduro — la tasa aún no es confiable` : undefined}
    >
      {/* Sin overflow-hidden a propósito: el relleno YA es rounded-full, así que
          no hace falta recortarlo — y recortarlo mataba el glow (una sombra
          hacia AFUERA dentro de un ancestro con overflow:hidden se recorta a
          cero y el efecto simplemente no existe en pantalla). */}
      <div className="h-1.5 flex-1 rounded-full bg-foreground/10">
        <div
          className="h-full rounded-full transition-[width] duration-700"
          style={{
            width: `${pct}%`,
            background: `linear-gradient(90deg, ${hsl(v, 0.55)}, ${hsl(v)})`,
            boxShadow: `0 0 6px -1px ${hsl(v, 0.7)}`,
          }}
          aria-hidden="true"
        />
      </div>
      <span className="font-mono tabular-nums text-xs font-bold whitespace-nowrap" style={{ color: hsl(v) }}>
        {value}%{prelim ? ' ·prelim.' : ''}
      </span>
    </div>
  );
}

/** Los 4 segmentos de la composición, en orden de lectura. El protagonista
 *  (entregados) es el único con glow — misma regla que la pila del Dashboard. */
const COMPOSITION_SEGMENTS = [
  { key: 'entregados', varName: '--success', glow: true },
  { key: 'enTransito', varName: '--info',    glow: false },
  { key: 'novedades',  varName: '--warning', glow: false },
  { key: 'devueltos',  varName: '--danger',  glow: false },
] as const;

/** Stack bar con composición: entregados + tránsito + novedades +
 *  devueltos. Width relativa al carrier con más volumen (patrón
 *  leaderboard usado por Stripe/Linear/Vercel). Los segmentos van
 *  redondeados en las puntas y con degradado + glow, como las barras
 *  apiladas del Dashboard. SVG-free, accesible. */
function CompositionBar({ row, maxVolume }: { row: CarrierRow; maxVolume: number }) {
  const total = row.total_pedidos || 0;
  const entregados = row.entregados || 0;
  const enTransito = row.en_transito || 0;
  const novedades = row.novedades || 0;
  const devueltos = row.devueltos || 0;

  // Ancho relativo al líder — la barra más larga = top volumen.
  const widthPct = maxVolume > 0 ? Math.min(100, (total / maxVolume) * 100) : 0;

  // Fracciones internas (% del total de ESTA fila)
  const fracs: Record<string, number> = {
    entregados: total > 0 ? (entregados / total) * 100 : 0,
    enTransito: total > 0 ? (enTransito / total) * 100 : 0,
    novedades:  total > 0 ? (novedades / total) * 100 : 0,
    devueltos:  total > 0 ? (devueltos / total) * 100 : 0,
  };

  const titles: Record<string, string> = {
    // Sin tasa medida el title dice el conteo y nada más — no "(0.0%)".
    entregados: `Entregados: ${entregados.toLocaleString('es-CO')}${row.tasa_entrega == null ? '' : ` (${row.tasa_entrega}%)`}`,
    enTransito: `En tránsito: ${enTransito.toLocaleString('es-CO')}`,
    novedades:  `Novedades: ${novedades.toLocaleString('es-CO')}`,
    devueltos:  `Devueltos: ${devueltos.toLocaleString('es-CO')}${row.tasa_devolucion == null ? '' : ` (${row.tasa_devolucion}%)`}`,
  };

  return (
    <div
      className="relative h-3 w-full rounded-full bg-foreground/10"
      role="img"
      aria-label={`${row.transportadora}: ${total} envíos. ${entregados} entregados, ${enTransito} en tránsito, ${novedades} novedades, ${devueltos} devueltos`}
    >
      {/* Tampoco recorta: cada segmento ya se auto-redondea en las puntas
          (first:/last:) y el drop-shadow del protagonista tiene que poder
          salirse del contenedor para verse. */}
      <div
        className="absolute inset-y-0 left-0 flex rounded-full transition-[width] duration-700 ease-out"
        style={{ width: `${widthPct}%` }}
      >
        {COMPOSITION_SEGMENTS.map(seg => fracs[seg.key] > 0 && (
          <div
            key={seg.key}
            className="h-full first:rounded-l-full last:rounded-r-full"
            style={{
              width: `${fracs[seg.key]}%`,
              background: `linear-gradient(180deg, ${hsl(seg.varName)}, ${hsl(seg.varName, 0.62)})`,
              filter: seg.glow ? `drop-shadow(0 0 6px ${hsl(seg.varName, 0.65)})` : undefined,
            }}
            title={titles[seg.key]}
          />
        ))}
      </div>
    </div>
  );
}

/** Barra de tasa de entrega del leaderboard. UN solo tono (info) sin línea de
 *  meta ni colores por umbral — ver el comentario donde vivía DELIVERY_TARGET.
 *  Prelim → gris atenuado + doble motivo en el tooltip. */
function DeliveryBullet({ rate, prelim }: { rate: number; prelim?: boolean }) {
  const fill = Math.max(0, Math.min(100, rate));
  const toneVar = prelim ? TONE_VAR.neutral : TONE_VAR.info;

  return (
    <div className="flex items-center gap-2 min-w-[140px]" title={prelim ? `Preliminar: menos de ${MIN_RESUELTOS_CONFIABLE} pedidos concluidos o cohorte aún inmaduro` : undefined}>
      <div className="bullet flex-1" role="img" aria-label={`${rate}% de entrega${prelim ? ' (preliminar)' : ''}`}>
        <div
          className="bullet-fill"
          style={{
            width: `${fill}%`,
            background: `linear-gradient(90deg, ${hsl(toneVar, 0.6)}, ${hsl(toneVar)})`,
            boxShadow: `0 0 8px -1px ${hsl(toneVar, 0.75)}`,
            opacity: prelim ? 0.6 : 1,
          }}
          aria-hidden="true"
        />
      </div>
      <span
        className="font-mono text-xs font-bold tabular-nums w-16 text-right"
        style={{ color: hsl(toneVar) }}
      >
        {rate}%{prelim ? '·pr' : ''}
      </span>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// Main component
// ──────────────────────────────────────────────────────────────

export default memo(function CarrierStatsTable({ rows, fletePorCarrier, fleteParcial }: Props) {
  const [sortKey, setSortKey] = useState<Key>('entregados');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // Sobreescribe tasa_entrega/tasa_devolucion con las MADURAS (÷ entregados+
  // devueltos). Así el sort, los bullets, los DataBar y el CSV usan la tasa
  // madura sin tocar nada más. Los conteos crudos (entregados/devueltos/total)
  // quedan intactos → la CompositionBar sigue mostrando composición real.
  const matureRows = useMemo<CarrierRow[]>(() => {
    const volumenTotal = rows.reduce((a, r) => a + (r.total_pedidos ?? 0), 0);
    return rows.map(r => {
      const m = deriveDeliveryMaturity(r.entregados, r.devueltos, r.total_pedidos, r.rechazados ?? 0);
      return {
        ...r,
        tasa_entrega: m.tasaEntregaMadura,
        tasa_devolucion: m.tasaDevolucionMadura,
        _prelim: isRatePreliminary(m),
        _resueltos: m.resueltos,
        _ticketProm: r.entregados > 0 ? r.valor_entregado / r.entregados : null,
        _perdidaPorDevol: r.devueltos > 0 ? r.valor_perdido / r.devueltos : null,
        _sharePct: volumenTotal > 0 ? (r.total_pedidos / volumenTotal) * 100 : 0,
        _fleteProm: fletePorCarrier?.get(r.transportadora)?.fleteProm ?? null,
        _fleteDevol: (() => {
          const agg = fletePorCarrier?.get(r.transportadora);
          return agg && agg.nDevol > 0 ? agg.fleteDevol : null;
        })(),
      };
    });
  }, [rows, fletePorCarrier]);

  const sorted = useMemo(() => {
    const out = [...matureRows];
    out.sort((a, b) => {
      const av = a[sortKey as keyof CarrierRow];
      const bv = b[sortKey as keyof CarrierRow];
      // Lo NO MEDIDO va al final en cualquier dirección: una transportadora
      // recién estrenada no es "la peor", simplemente no tiene tasa todavía.
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

  // Top 5 por volumen — leaderboard analítico
  const topByVolume = useMemo(
    () => [...matureRows].sort((a, b) => (b.total_pedidos ?? 0) - (a.total_pedidos ?? 0)).slice(0, 5),
    [matureRows],
  );

  const maxVolume = useMemo(
    () => Math.max(0, ...topByVolume.map(r => r.total_pedidos ?? 0)),
    [topByVolume],
  );

  const onSort = (k: Key) => {
    if (k === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(k); setSortDir('desc'); }
  };

  const exportCsv = () => {
    // Headers legibles (el dueño abre esto en Excel — "_ticketProm" con
    // 21833.333333333332 no le dice nada) y plata redondeada a 2 decimales.
    // null → celda vacía (escapeCell), así el CSV dice lo mismo que la pantalla.
    const r2 = (n: number | null) => (n == null ? null : Math.round(n * 100) / 100);
    const filas = sorted.map((r) => ({
      'Transportadora': r.transportadora,
      'Envios': r.total_pedidos,
      'Entregados': r.entregados,
      'Devueltos': r.devueltos,
      'En transito': r.en_transito,
      'Novedades': r.novedades,
      'Entrega %': r.tasa_entrega,
      'Devol %': r.tasa_devolucion,
      'Valor entregado': r2(r.valor_entregado),
      '$ Perdido': r2(r.valor_perdido),
      'Ticket prom.': r2(r._ticketProm),
      'Flete prom.': r2(r._fleteProm),
      'Flete devol.': r2(r._fleteDevol),
      '$ x devol.': r2(r._perdidaPorDevol),
      'Antiguedad prom. (dias)': r.avg_dias_entrega,
    }));
    // Fecha LOCAL para el nombre: toISOString es UTC y después de las 19:00
    // en Bogotá etiquetaba el archivo con la fecha de mañana.
    const hoy = new Date().toLocaleDateString('en-CA');
    downloadCsv(`logistica-transportadoras-${hoy}.csv`, rowsToCsv(Object.keys(filas[0] ?? {}) as never[], filas as never[]));
  };

  // Totales del período — para que la tabla cierre sola sin sumar a mano.
  const tot = useMemo(() => {
    const s = { envios: 0, entregados: 0, devueltos: 0, transito: 0, novedades: 0, vEntregado: 0, vPerdido: 0, fleteDevol: 0, hayFleteDevol: false };
    for (const r of matureRows) {
      s.envios += r.total_pedidos ?? 0;
      s.entregados += r.entregados ?? 0;
      s.devueltos += r.devueltos ?? 0;
      s.transito += r.en_transito ?? 0;
      s.novedades += r.novedades ?? 0;
      s.vEntregado += r.valor_entregado ?? 0;
      s.vPerdido += r.valor_perdido ?? 0;
      if (r._fleteDevol != null) { s.fleteDevol += r._fleteDevol; s.hayFleteDevol = true; }
    }
    return s;
  }, [matureRows]);

  // Flete promedio GLOBAL ponderado por muestra (no promedio de promedios).
  const fleteTotalProm = useMemo(() => {
    if (!fletePorCarrier) return null;
    let suma = 0, n = 0;
    for (const agg of fletePorCarrier.values()) {
      if (agg.fleteProm != null) { suma += agg.fleteProm * agg.muestra; n += agg.muestra; }
    }
    return n > 0 ? suma / n : null;
  }, [fletePorCarrier]);

  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-card/40 p-10 text-center shadow-card3d">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted/40">
          <Truck size={20} className="text-muted-foreground" aria-hidden="true" />
        </div>
        <p className="text-sm font-semibold text-foreground mb-1">Sin datos de transportadoras</p>
        <p className="text-xs text-muted-foreground max-w-sm mx-auto">
          No hay transportadoras con suficientes pedidos en este rango. Probá con un rango más amplio o esperá a que sincronicen más envíos.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* ── Leaderboard — card hero de la pestaña. Cada transportadora es una
          fila-tarjeta con la anatomía de RankRow (posición, avatar con inicial,
          nombre, detalle a la derecha) pero con DOS barras en vez de la
          monocolor: la de composición (ancho = volumen relativo al líder,
          segmentos = estado) y la barra de tasa de entrega. RankRow no se
          usa tal cual a propósito: su único `pct` sirve para el número Y el
          ancho, y acá el ancho significa VOLUMEN mientras el número significa
          TASA — y además clampea a 0% un carrier sin desenlaces, que es
          exactamente el veredicto inventado que este bloque evita. ── */}
      <motion.div {...fadeUp(0)}>
        {/* Card ESTÁTICA (era TiltCard con sheen+brackets): el dueño pidió
            "quitá la animación cuando paso el mouse, dejalo todo quieto"
            (23-ago-2026). Nada en este módulo se mueve con el puntero. */}
        <div className="bg-card/40 border border-border rounded-3xl p-6 shadow-card3d-lg hairline-top">
          <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
            <div className="flex items-center gap-2 min-w-0">
              <span className="w-9 h-9 rounded-xl border bg-accent/14 border-accent/30 text-accent glow-accent flex items-center justify-center flex-shrink-0">
                <Trophy size={17} aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-foreground">
                  Top 5 transportadoras por volumen
                </h2>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  La barra muestra composición real (entregados · tránsito · novedades · devueltos)
                </p>
              </div>
            </div>
            <Legend />
          </div>

          <div className="space-y-2.5">
            {topByVolume.map((row, idx) => (
              <div
                key={row.transportadora}
                className={`flex flex-col gap-2.5 px-4 py-3 rounded-2xl border transition-colors duration-200 ${
                  idx === 0
                    ? 'bg-accent/12 border-accent/32 glow-accent'
                    : 'bg-card/30 border-border hover:border-border-strong'
                }`}
              >
                <div className="flex items-center gap-3">
                  <span className="w-6 flex items-center justify-center flex-shrink-0">
                    <span className={`font-mono tabular-nums text-center font-bold text-[15px] ${
                      idx === 0 ? 'text-warning num-glow-accent' : 'text-muted-foreground'
                    }`}>
                      {String(idx + 1).padStart(2, '0')}
                    </span>
                  </span>
                  <span
                    aria-hidden="true"
                    className={`w-9 h-9 rounded-xl flex items-center justify-center text-[13px] font-bold flex-shrink-0 ${
                      idx === 0 ? 'bg-accent-gradient text-accent-foreground glow-accent' : 'bg-muted/60 text-muted-foreground'
                    }`}
                  >
                    {(row.transportadora || '?')[0].toUpperCase()}
                  </span>
                  <span className="flex-1 min-w-0 text-[13px] font-semibold text-foreground truncate" title={row.transportadora}>
                    {row.transportadora}
                  </span>
                  <span className="font-mono tabular-nums text-xs font-bold text-foreground/80 flex-shrink-0">
                    {(row.total_pedidos || 0).toLocaleString('es-CO')}
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-[1fr_170px] items-center gap-3">
                  <CompositionBar row={row} maxVolume={maxVolume} />

                  {/* Sin desenlaces no hay tasa: se dice, no se dibuja un 0%. */}
                  {row.tasa_entrega == null ? (
                    <span className="text-xs text-muted-foreground" title="Sin pedidos concluidos aún">— sin concluidos</span>
                  ) : (
                    <DeliveryBullet rate={row.tasa_entrega} prelim={row._prelim} />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </motion.div>

      {/* ── Tabla detalle: todas las transportadoras con sort y CSV.
          Encabezados en .hud-label como el Dashboard. ── */}
      <motion.section {...fadeUp(0.12)} className="rounded-2xl border border-border bg-card/40 shadow-card3d hairline-top overflow-hidden">
        <header className="px-5 py-3.5 border-b border-border/60 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Layers size={14} className="text-accent" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-foreground">
              Detalle por transportadora
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
        </header>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-card/95 [&_th]:backdrop-blur-sm">
              <tr className="border-b border-border">
                <th className="px-5 py-2.5 text-left hud-label font-normal w-10">#</th>
                <th className="px-3 py-2.5 text-left hud-label font-normal"><SortableHeader<Key> label="Transportadora" sortKey="transportadora" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right hud-label font-normal"><SortableHeader<Key> label="Envíos" sortKey="total_pedidos" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right hud-label font-normal" title="Qué parte de todos tus envíos del período va con esta transportadora"><SortableHeader<Key> label="% del total" sortKey="_sharePct" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right hud-label font-normal"><SortableHeader<Key> label="Entregados" sortKey="entregados" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right hud-label font-normal"><SortableHeader<Key> label="Devueltos" sortKey="devueltos" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right hud-label font-normal"><SortableHeader<Key> label="En tránsito" sortKey="en_transito" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right hud-label font-normal"><SortableHeader<Key> label="Novedades" sortKey="novedades" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right hud-label font-normal"><SortableHeader<Key> label="Entrega %" sortKey="tasa_entrega" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right hud-label font-normal"><SortableHeader<Key> label="Devol %" sortKey="tasa_devolucion" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right hud-label font-normal" title="Antigüedad promedio desde el último cambio de estado de los entregados — NO es el tiempo de tránsito despacho→entrega"><SortableHeader<Key> label="Antigüedad prom." sortKey="avg_dias_entrega" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right hud-label font-normal" title="Valor promedio de cada pedido entregado ($ entregado ÷ entregados)"><SortableHeader<Key> label="Ticket prom." sortKey="_ticketProm" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right hud-label font-normal" title={`Costo de envío promedio que te cobra esta transportadora (flete de los entregados)${fleteParcial ? ' — MUESTRA PARCIAL: el rango supera los 10.000 pedidos y el promedio sale de los primeros 10.000' : ''}`}><SortableHeader<Key> label={fleteParcial ? 'Flete prom. ·parcial' : 'Flete prom.'} sortKey="_fleteProm" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                {/* ⛔ MISMA MUESTRA, MISMO AVISO (4-sep-2026). `_fleteDevol` sale
                    del MISMO agregado que el flete promedio de al lado
                    (`fletePorCarrier`), así que hereda su recorte a 10.000
                    pedidos — pero solo la columna vecina lo declaraba. Un total
                    de plata quemada presentado como total redondo, cuando es
                    una suma parcial, se lee como si fuera toda. */}
                <th className="px-3 py-2.5 text-right hud-label font-normal" title={`Flete que pagaste en pedidos que VOLVIERON — plata quemada en envíos que no vendieron nada${fleteParcial ? ' — MUESTRA PARCIAL: el rango supera los 10.000 pedidos y esta suma sale de los primeros 10.000' : ''}`}><SortableHeader<Key> label={fleteParcial ? 'Flete devol. ·parcial' : 'Flete devol.'} sortKey="_fleteDevol" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right hud-label font-normal"><SortableHeader<Key> label="Valor entregado" sortKey="valor_entregado" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right hud-label font-normal" title="Venta perdida en devoluciones"><SortableHeader<Key> label="$ Perdido" sortKey="valor_perdido" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right hud-label font-normal" title="Venta perdida promedio por cada pedido devuelto"><SortableHeader<Key> label="$ x devol." sortKey="_perdidaPorDevol" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, idx) => (
                <tr key={r.transportadora} className="border-b border-border/50 last:border-0 hover:bg-card/60 transition-colors duration-200">
                  <td className="px-5 py-2.5">
                    <span className="font-mono text-[11px] font-bold tabular-nums text-muted-foreground">
                      {String(idx + 1).padStart(2, '0')}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 font-semibold text-foreground whitespace-nowrap">{r.transportadora}</td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums">{r.total_pedidos.toLocaleString('es-CO')}</td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-muted-foreground">{r._sharePct.toFixed(1)}%</td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums font-bold text-success">{r.entregados.toLocaleString('es-CO')}</td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums font-bold text-danger">{r.devueltos.toLocaleString('es-CO')}</td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-info">{(r.en_transito ?? 0).toLocaleString('es-CO')}</td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-warning">{(r.novedades ?? 0).toLocaleString('es-CO')}</td>
                  {/* Sin desenlaces (0 entregados+devueltos) la tasa NO es 0% — no hay dato.
                      Mostrar 0.0% en rojo hacía ver "pésima" a una transportadora recién usada. */}
                  {r.tasa_entrega == null || r.tasa_devolucion == null ? (
                    <>
                      <td className="px-3 py-2.5 text-right text-xs text-muted-foreground" title="Sin pedidos concluidos aún">—</td>
                      <td className="px-3 py-2.5 text-right text-xs text-muted-foreground" title="Sin pedidos concluidos aún">—</td>
                    </>
                  ) : (
                    <>
                      <td className="px-3 py-2.5"><DataBar value={r.tasa_entrega} tone="success" prelim={r._prelim} /></td>
                      <td className="px-3 py-2.5"><DataBar value={r.tasa_devolucion} tone="danger" prelim={r._prelim} /></td>
                    </>
                  )}
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-muted-foreground">{r.avg_dias_entrega != null ? `${r.avg_dias_entrega}d` : '—'}</td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-foreground">{r._ticketProm != null ? formatCOP(r._ticketProm) : '—'}</td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-muted-foreground">{r._fleteProm != null ? formatCOP(r._fleteProm) : '—'}</td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-danger">{r._fleteDevol != null ? formatCOP(r._fleteDevol) : '—'}</td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-xs text-foreground">{formatCOP(r.valor_entregado)}</td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-xs text-danger">{formatCOP(r.valor_perdido ?? 0)}</td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-muted-foreground">{r._perdidaPorDevol != null ? formatCOP(r._perdidaPorDevol) : '—'}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border font-semibold text-foreground">
                <td className="px-5 py-2.5" colSpan={2}>Total</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums">{tot.envios.toLocaleString('es-CO')}</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums text-muted-foreground">100%</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums text-success">{tot.entregados.toLocaleString('es-CO')}</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums text-danger">{tot.devueltos.toLocaleString('es-CO')}</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums text-info">{tot.transito.toLocaleString('es-CO')}</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums text-warning">{tot.novedades.toLocaleString('es-CO')}</td>
                <td className="px-3 py-2.5" colSpan={2} />
                <td className="px-3 py-2.5" />
                <td className="px-3 py-2.5 text-right font-mono tabular-nums">
                  {tot.entregados > 0 ? formatCOP(tot.vEntregado / tot.entregados) : '—'}
                </td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums text-muted-foreground" title={fleteParcial ? 'Promedio sobre muestra PARCIAL (primeros 10.000 pedidos del rango)' : undefined}>
                  {fleteTotalProm != null ? `${formatCOP(fleteTotalProm)}${fleteParcial ? ' ·parcial' : ''}` : '—'}
                </td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums text-danger" title={fleteParcial ? 'Suma sobre muestra PARCIAL (primeros 10.000 pedidos del rango)' : undefined}>
                  {tot.hayFleteDevol ? `${formatCOP(tot.fleteDevol)}${fleteParcial ? ' ·parcial' : ''}` : '—'}
                </td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums text-xs">{formatCOP(tot.vEntregado)}</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums text-xs text-danger">{formatCOP(tot.vPerdido)}</td>
                <td className="px-3 py-2.5 text-right font-mono tabular-nums text-muted-foreground">
                  {tot.devueltos > 0 ? formatCOP(tot.vPerdido / tot.devueltos) : '—'}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </motion.section>
    </div>
  );
});

// Leyenda visual — semánticamente conectada al chart, no decorativa
function Legend() {
  const items = [
    { color: hsl('--success'), label: 'Entregados' },
    { color: hsl('--info'),    label: 'En tránsito' },
    { color: hsl('--warning'), label: 'Novedades' },
    { color: hsl('--danger'),  label: 'Devueltos' },
  ];
  return (
    <div className="hidden md:flex items-center gap-3 flex-wrap">
      {items.map(it => (
        <span key={it.label} className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: it.color }} aria-hidden="true" />
          {it.label}
        </span>
      ))}
    </div>
  );
}

import { memo, useMemo, useState } from 'react';
import { Download, Truck } from 'lucide-react';
import { formatCOP } from '@/lib/utils';
import { rowsToCsv, downloadCsv } from '@/lib/csvExport';
import { SortableHeader, type SortDir } from './SortableHeader';
import { deriveDeliveryMaturity, isRatePreliminary, MIN_RESUELTOS_CONFIABLE } from '@/lib/logisticsRates';
import type { CarrierStats } from '@/lib/logistics.types';

interface Props { rows: CarrierStats[]; }

// Fila enriquecida con la madurez de la tasa (para atenuar/marcar prelim.).
type CarrierRow = CarrierStats & { _prelim: boolean; _resueltos: number };

type Key = keyof CarrierStats;

// Benchmark COD Colombia — usado como target line en el bullet
// del leaderboard. 70% de tasa de entrega es el promedio sano.
const DELIVERY_TARGET = 70;

// ──────────────────────────────────────────────────────────────
// Sub-components — pequeños, sin estado, solo presentación.
// ──────────────────────────────────────────────────────────────

/** Inline data bar usando .data-bar utility del DS. Si la tasa es PRELIMINAR
 *  (muestra chica / cohorte inmaduro) se atenúa a gris + sufijo, para no pintar
 *  100% verde sobre 1 pedido concluido. */
function DataBar({ value, tone, prelim }: { value: number; tone: 'success' | 'danger' | 'warning' | 'info' | 'neutral'; prelim?: boolean }) {
  const pct = Math.max(0, Math.min(100, value));
  const t = prelim ? 'neutral' : tone;
  return (
    <div className={`data-bar tone-${t}`} style={prelim ? { opacity: 0.55 } : undefined}
      title={prelim ? `Preliminar: menos de ${MIN_RESUELTOS_CONFIABLE} pedidos concluidos — la tasa aún no es confiable` : undefined}>
      <div className="data-bar-fill" style={{ width: `${pct}%` }} aria-hidden="true" />
      <span className="data-bar-value">{value.toFixed(1)}%{prelim ? ' ·prelim.' : ''}</span>
    </div>
  );
}

/** Stack bar con composición: entregados + tránsito + novedades +
 *  devueltos. Width relativa al carrier con más volumen (patrón
 *  leaderboard usado por Stripe/Linear/Vercel). El total se muestra
 *  como label a la derecha en mono tabular. SVG-free, accesible. */
function CompositionBar({ row, maxVolume }: { row: CarrierStats; maxVolume: number }) {
  const total = row.total_pedidos || 0;
  const entregados = row.entregados || 0;
  const enTransito = row.en_transito || 0;
  const novedades = row.novedades || 0;
  const devueltos = row.devueltos || 0;

  // Ancho relativo al líder — la barra más larga = top volumen.
  const widthPct = maxVolume > 0 ? Math.min(100, (total / maxVolume) * 100) : 0;

  // Fracciones internas (% del total de ESTA fila)
  const fracs = {
    entregados: total > 0 ? (entregados / total) * 100 : 0,
    enTransito: total > 0 ? (enTransito / total) * 100 : 0,
    novedades:  total > 0 ? (novedades / total) * 100 : 0,
    devueltos:  total > 0 ? (devueltos / total) * 100 : 0,
  };

  return (
    <div
      className="relative h-7 w-full rounded-md overflow-hidden bg-muted/30"
      role="img"
      aria-label={`${row.transportadora}: ${total} envíos. ${entregados} entregados, ${enTransito} en tránsito, ${novedades} novedades, ${devueltos} devueltos`}
    >
      <div
        className="absolute inset-y-0 left-0 flex overflow-hidden rounded-md transition-[width] duration-700 ease-out"
        style={{ width: `${widthPct}%` }}
      >
        {fracs.entregados > 0 && (
          <div
            className="bg-[hsl(var(--success))] h-full"
            style={{ width: `${fracs.entregados}%` }}
            title={`Entregados: ${entregados.toLocaleString('es-CO')} (${row.tasa_entrega.toFixed(1)}%)`}
          />
        )}
        {fracs.enTransito > 0 && (
          <div
            className="bg-[hsl(var(--info))] h-full"
            style={{ width: `${fracs.enTransito}%` }}
            title={`En tránsito: ${enTransito.toLocaleString('es-CO')}`}
          />
        )}
        {fracs.novedades > 0 && (
          <div
            className="bg-[hsl(var(--warning))] h-full"
            style={{ width: `${fracs.novedades}%` }}
            title={`Novedades: ${novedades.toLocaleString('es-CO')}`}
          />
        )}
        {fracs.devueltos > 0 && (
          <div
            className="bg-[hsl(var(--danger))] h-full"
            style={{ width: `${fracs.devueltos}%` }}
            title={`Devueltos: ${devueltos.toLocaleString('es-CO')} (${row.tasa_devolucion.toFixed(1)}%)`}
          />
        )}
      </div>

      <span className="absolute inset-y-0 right-2 flex items-center text-[11px] font-mono font-bold tabular-nums text-foreground/80">
        {total.toLocaleString('es-CO')}
      </span>
    </div>
  );
}

/** Bullet horizontal mini con target line — tasa de entrega vs
 *  meta 70%. Patrón Stephen Few. Prelim → gris (no verde/rojo sobre muestra chica). */
function DeliveryBullet({ rate, prelim }: { rate: number; prelim?: boolean }) {
  const fill = Math.max(0, Math.min(100, rate));
  const meets = rate >= DELIVERY_TARGET;
  const fillColor = prelim ? 'hsl(var(--muted-foreground))'
    : meets ? 'hsl(var(--success))' : rate >= 50 ? 'hsl(var(--warning))' : 'hsl(var(--danger))';

  return (
    <div className="flex items-center gap-2 min-w-[140px]" title={prelim ? `Preliminar: menos de ${MIN_RESUELTOS_CONFIABLE} pedidos concluidos` : undefined}>
      <div className="bullet flex-1" role="img" aria-label={`${rate.toFixed(1)}% vs meta ${DELIVERY_TARGET}%${prelim ? ' (preliminar)' : ''}`}>
        <div className="bullet-fill" style={{ width: `${fill}%`, background: fillColor, opacity: prelim ? 0.6 : 1 }} aria-hidden="true" />
        <div className="bullet-target" style={{ left: `${DELIVERY_TARGET}%` }} aria-hidden="true" />
      </div>
      <span
        className="font-mono text-xs font-bold tabular-nums w-16 text-right"
        style={{ color: fillColor }}
      >
        {rate.toFixed(1)}%{prelim ? '·pr' : ''}
      </span>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// Main component
// ──────────────────────────────────────────────────────────────

export default memo(function CarrierStatsTable({ rows }: Props) {
  const [sortKey, setSortKey] = useState<Key>('entregados');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // Sobreescribe tasa_entrega/tasa_devolucion con las MADURAS (÷ entregados+
  // devueltos). Así el sort, los bullets, los DataBar y el CSV usan la tasa
  // madura sin tocar nada más. Los conteos crudos (entregados/devueltos/total)
  // quedan intactos → la CompositionBar sigue mostrando composición real.
  const matureRows = useMemo<CarrierRow[]>(() => rows.map(r => {
    const m = deriveDeliveryMaturity(r.entregados, r.devueltos, r.total_pedidos);
    return {
      ...r,
      tasa_entrega: m.tasaEntregaMadura ?? 0,
      tasa_devolucion: m.tasaDevolucionMadura ?? 0,
      _prelim: isRatePreliminary(m),
      _resueltos: m.resueltos,
    };
  }), [rows]);

  const sorted = useMemo(() => {
    const out = [...matureRows];
    out.sort((a, b) => {
      const av = a[sortKey as keyof CarrierStats] ?? 0;
      const bv = b[sortKey as keyof CarrierStats] ?? 0;
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
    const csv = rowsToCsv<CarrierStats>(
      ['transportadora', 'total_pedidos', 'entregados', 'devueltos',
       'tasa_entrega', 'tasa_devolucion', 'valor_entregado', 'valor_perdido', 'avg_dias_entrega'],
      sorted,
    );
    downloadCsv(`logistica-transportadoras-${new Date().toISOString().split('T')[0]}.csv`, csv);
  };

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-card/40 p-10 text-center">
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
    <div className="space-y-6">
      {/* ── Leaderboard de composición — reemplaza el bar chart de
          recharts. Cada fila = una transportadora con rank, nombre,
          composition bar (volumen relativo al líder + segmentos por
          estado), y bullet de entrega vs meta 70%. ── */}
      <section className="rounded-xl border border-border bg-card overflow-hidden">
        <header className="px-4 py-3 border-b border-border/60 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-bold text-foreground tracking-tight">
              Top 5 transportadoras por volumen
            </h2>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              La barra muestra composición real (entregados · tránsito · novedades · devueltos)
            </p>
          </div>
          <Legend />
        </header>

        <div className="divide-y divide-border/40">
          {topByVolume.map((row, idx) => (
            <div
              key={row.transportadora}
              className="grid grid-cols-12 items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/20"
            >
              <div className="col-span-3 flex items-center gap-2.5 min-w-0">
                <span className="font-mono text-[11px] font-bold tabular-nums text-muted-foreground w-5 text-center">
                  {String(idx + 1).padStart(2, '0')}
                </span>
                <span className="font-semibold text-sm text-foreground truncate" title={row.transportadora}>
                  {row.transportadora}
                </span>
              </div>

              <div className="col-span-6">
                <CompositionBar row={row} maxVolume={maxVolume} />
              </div>

              <div className="col-span-3">
                {row._resueltos === 0 ? (
                  <span className="text-xs text-muted-foreground" title="Sin pedidos concluidos aún">— sin concluidos</span>
                ) : (
                  <DeliveryBullet rate={row.tasa_entrega} prelim={row._prelim} />
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Tabla detalle: todas las transportadoras con sort y CSV.
          Usa .data-table del DS (sticky thead, hover row). ── */}
      <section className="rounded-xl border border-border bg-card overflow-hidden">
        <header className="px-4 py-3 border-b border-border/60 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-bold text-foreground tracking-tight">
              Detalle por transportadora
            </h2>
            <span className="pill pill-neutral">{sorted.length}</span>
          </div>
          <button
            type="button"
            onClick={exportCsv}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-semibold transition-colors hover:border-border-strong hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <Download size={12} aria-hidden="true" /> CSV
          </button>
        </header>

        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th className="w-10">#</th>
                <th><SortableHeader<Key> label="Transportadora" sortKey="transportadora" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="text-right"><SortableHeader<Key> label="Envíos" sortKey="total_pedidos" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="text-right"><SortableHeader<Key> label="Entregados" sortKey="entregados" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="text-right"><SortableHeader<Key> label="Devueltos" sortKey="devueltos" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="text-right"><SortableHeader<Key> label="Entrega %" sortKey="tasa_entrega" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="text-right"><SortableHeader<Key> label="Devol %" sortKey="tasa_devolucion" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="text-right" title="Antigüedad promedio desde el último cambio de estado de los entregados — NO es el tiempo de tránsito despacho→entrega"><SortableHeader<Key> label="Antigüedad prom." sortKey="avg_dias_entrega" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="text-right"><SortableHeader<Key> label="Valor entregado" sortKey="valor_entregado" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, idx) => (
                <tr key={r.transportadora}>
                  <td>
                    <span className="font-mono text-[11px] font-bold tabular-nums text-muted-foreground">
                      {String(idx + 1).padStart(2, '0')}
                    </span>
                  </td>
                  <td className="font-semibold text-foreground">{r.transportadora}</td>
                  <td className="text-right font-mono tabular-nums">{r.total_pedidos.toLocaleString('es-CO')}</td>
                  <td className="text-right font-mono tabular-nums text-[hsl(var(--success))] font-semibold">{r.entregados.toLocaleString('es-CO')}</td>
                  <td className="text-right font-mono tabular-nums text-[hsl(var(--danger))] font-semibold">{r.devueltos.toLocaleString('es-CO')}</td>
                  {/* Sin desenlaces (0 entregados+devueltos) la tasa NO es 0% — no hay dato.
                      Mostrar 0.0% en rojo hacía ver "pésima" a una transportadora recién usada. */}
                  {r._resueltos === 0 ? (
                    <>
                      <td className="text-right text-xs text-muted-foreground" title="Sin pedidos concluidos aún">—</td>
                      <td className="text-right text-xs text-muted-foreground" title="Sin pedidos concluidos aún">—</td>
                    </>
                  ) : (
                    <>
                      <td className="text-right"><DataBar value={r.tasa_entrega} tone="success" prelim={r._prelim} /></td>
                      <td className="text-right"><DataBar value={r.tasa_devolucion} tone="danger" prelim={r._prelim} /></td>
                    </>
                  )}
                  <td className="text-right font-mono tabular-nums text-muted-foreground">{r.avg_dias_entrega != null ? `${r.avg_dias_entrega}d` : '—'}</td>
                  <td className="text-right font-mono tabular-nums text-xs text-foreground">{formatCOP(r.valor_entregado)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
});

// Leyenda visual — semánticamente conectada al chart, no decorativa
function Legend() {
  const items = [
    { color: 'hsl(var(--success))', label: 'Entregados' },
    { color: 'hsl(var(--info))',    label: 'En tránsito' },
    { color: 'hsl(var(--warning))', label: 'Novedades' },
    { color: 'hsl(var(--danger))',  label: 'Devueltos' },
  ];
  return (
    <div className="hidden md:flex items-center gap-3 text-[11px] text-muted-foreground">
      {items.map(it => (
        <span key={it.label} className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm" style={{ background: it.color }} aria-hidden="true" />
          {it.label}
        </span>
      ))}
    </div>
  );
}

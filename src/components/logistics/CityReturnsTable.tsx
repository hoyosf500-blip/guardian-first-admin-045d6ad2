import { memo, useMemo, useState } from 'react';
import { Download, MapPin, AlertTriangle } from 'lucide-react';
import { formatCOP } from '@/lib/utils';
import { rowsToCsv, downloadCsv } from '@/lib/csvExport';
import { SortableHeader, type SortDir } from './SortableHeader';
import { deriveDeliveryMaturity, isRatePreliminary, MIN_RESUELTOS_CONFIABLE } from '@/lib/logisticsRates';
import type { CityReturns } from '@/lib/logistics.types';

interface Props { rows: CityReturns[]; }

// Fila enriquecida con la madurez para que el render decida atenuar/marcar prelim.
type CityRow = CityReturns & { _prelim: boolean; _resueltos: number };

type Key = keyof CityReturns;

/** Heat-map data bar para tasa de devolución. Tono escala según
 *  severidad: <15% neutral, 15-30% warning, ≥30% danger. Si la tasa es
 *  PRELIMINAR (muestra chica / cohorte inmaduro) se pinta gris + sufijo,
 *  para no gritar rojo sobre 1-4 pedidos concluidos. */
function ReturnRateBar({ value, prelim }: { value: number; prelim?: boolean }) {
  const pct = Math.max(0, Math.min(100, value));
  const tone = prelim ? 'neutral' : pct >= 30 ? 'danger' : pct >= 15 ? 'warning' : 'neutral';
  return (
    <div className={`data-bar tone-${tone}`} style={prelim ? { opacity: 0.55 } : undefined}
      title={prelim ? `Preliminar: menos de ${MIN_RESUELTOS_CONFIABLE} pedidos concluidos — la tasa aún no es confiable` : undefined}>
      <div className="data-bar-fill" style={{ width: `${pct}%` }} aria-hidden="true" />
      <span className="data-bar-value">{value.toFixed(1)}%{prelim ? ' ·prelim.' : ''}</span>
    </div>
  );
}

export default memo(function CityReturnsTable({ rows }: Props) {
  const [sortKey, setSortKey] = useState<Key>('tasa_devolucion');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // tasa_entrega/tasa_devolucion → maduras (÷ entregados+devueltos). Conteos
  // crudos intactos. Sort/bars/CSV usan la tasa madura automáticamente.
  // `_prelim` marca las tasas de muestra chica / cohorte inmaduro para atenuarlas.
  const matureRows = useMemo<CityRow[]>(() => rows.map(r => {
    const m = deriveDeliveryMaturity(r.entregados, r.devueltos, r.total_pedidos, r.rechazados ?? 0);
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
      const av = a[sortKey as keyof CityReturns] ?? 0;
      const bv = b[sortKey as keyof CityReturns] ?? 0;
      if (typeof av === 'number' && typeof bv === 'number') {
        return sortDir === 'asc' ? av - bv : bv - av;
      }
      return sortDir === 'asc'
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
    return out;
  }, [matureRows, sortKey, sortDir]);

  const totalLost = useMemo(
    () => sorted.reduce((s, r) => s + (r.valor_perdido ?? 0), 0),
    [sorted],
  );

  const onSort = (k: Key) => {
    if (k === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(k); setSortDir('desc'); }
  };

  const exportCsv = () => {
    const csv = rowsToCsv<CityReturns>(
      ['ciudad', 'departamento', 'total_pedidos', 'entregados', 'devueltos',
       'tasa_entrega', 'tasa_devolucion', 'valor_perdido'],
      sorted,
    );
    downloadCsv(`logistica-ciudades-${new Date().toISOString().split('T')[0]}.csv`, csv);
  };

  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-card/40 p-10 text-center shadow-card3d">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted/40">
          <MapPin size={20} className="text-muted-foreground" aria-hidden="true" />
        </div>
        <p className="text-sm font-semibold text-foreground mb-1">Sin datos de ciudades</p>
        <p className="text-xs text-muted-foreground max-w-sm mx-auto">
          No hay ciudades con devoluciones en este rango. Probá con un rango más amplio o quitá el filtro de ciudad.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Stat banner: valor total perdido — gradient hero pattern */}
      {totalLost > 0 && (
        <div className="rounded-2xl border-2 border-danger/30 bg-gradient-to-br from-danger/8 via-danger/3 to-transparent p-5 shadow-card3d flex items-center gap-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border bg-danger/15 border-danger/40">
            <AlertTriangle size={18} className="text-danger" aria-hidden="true" strokeWidth={2.25} />
          </div>
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.12em] font-bold text-muted-foreground">
              Valor perdido · {sorted.length} ciudades con mayor tasa de devolución
            </div>
            <div className="font-extrabold text-3xl text-danger tabular-nums leading-none mt-1.5">
              {formatCOP(totalLost)}
            </div>
          </div>
        </div>
      )}

      <section className="rounded-2xl border border-border bg-card/40 overflow-hidden shadow-card3d hairline-top transition-colors hover:border-border-strong">
        <header className="px-4 py-3 border-b border-border/60 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-bold text-foreground tracking-tight">
              Ciudades con más devoluciones
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
                <th><SortableHeader<Key> label="Ciudad" sortKey="ciudad" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th><SortableHeader<Key> label="Depto" sortKey="departamento" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="text-right"><SortableHeader<Key> label="Envíos" sortKey="total_pedidos" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="text-right"><SortableHeader<Key> label="Devueltos" sortKey="devueltos" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="text-right"><SortableHeader<Key> label="Devol %" sortKey="tasa_devolucion" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="text-right"><SortableHeader<Key> label="Valor perdido" sortKey="valor_perdido" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, idx) => (
                <tr key={`${r.ciudad}|${r.departamento}`}>
                  <td>
                    <span className="font-mono text-[11px] font-bold tabular-nums text-muted-foreground">
                      {String(idx + 1).padStart(2, '0')}
                    </span>
                  </td>
                  <td className="font-semibold text-foreground">{r.ciudad}</td>
                  <td className="text-muted-foreground text-xs">{r.departamento || '—'}</td>
                  <td className="text-right font-mono tabular-nums">{r.total_pedidos.toLocaleString('es-CO')}</td>
                  <td className="text-right font-mono tabular-nums text-[hsl(var(--danger))] font-semibold">{r.devueltos.toLocaleString('es-CO')}</td>
                  {/* Sin desenlaces no hay tasa: "0.0%" hacía ver perfecta a una
                      ciudad donde simplemente no concluyó ningún pedido todavía.
                      Con muestra chica se marca prelim. (gris) en vez de rojo. */}
                  <td className="text-right">
                    {r._resueltos === 0
                      ? <span className="text-xs text-muted-foreground" title="Sin pedidos concluidos aún">—</span>
                      : <ReturnRateBar value={r.tasa_devolucion} prelim={r._prelim} />}
                  </td>
                  <td className="text-right font-mono tabular-nums text-xs text-[hsl(var(--danger))]">{formatCOP(r.valor_perdido)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
});

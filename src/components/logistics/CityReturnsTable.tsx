import { memo, useMemo, useState } from 'react';
import { Download, MapPin, AlertTriangle } from 'lucide-react';
import { formatCOP } from '@/lib/utils';
import { rowsToCsv, downloadCsv } from '@/lib/csvExport';
import { SortableHeader, type SortDir } from './SortableHeader';
import type { CityReturns } from '@/lib/logistics.types';

interface Props { rows: CityReturns[]; }

type Key = keyof CityReturns;

/** Heat-map data bar para tasa de devolución. Tono escala según
 *  severidad: <15% neutral, 15-30% warning, ≥30% danger. */
function ReturnRateBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value));
  const tone = pct >= 30 ? 'danger' : pct >= 15 ? 'warning' : 'neutral';
  return (
    <div className={`data-bar tone-${tone}`}>
      <div className="data-bar-fill" style={{ width: `${pct}%` }} aria-hidden="true" />
      <span className="data-bar-value">{value.toFixed(1)}%</span>
    </div>
  );
}

export default memo(function CityReturnsTable({ rows }: Props) {
  const [sortKey, setSortKey] = useState<Key>('tasa_devolucion');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const sorted = useMemo(() => {
    const out = [...rows];
    out.sort((a, b) => {
      const av = a[sortKey] ?? 0;
      const bv = b[sortKey] ?? 0;
      if (typeof av === 'number' && typeof bv === 'number') {
        return sortDir === 'asc' ? av - bv : bv - av;
      }
      return sortDir === 'asc'
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
    return out;
  }, [rows, sortKey, sortDir]);

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
      <div className="rounded-xl border border-dashed border-border bg-card/40 p-10 text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted/40">
          <MapPin size={20} className="text-muted-foreground" aria-hidden="true" />
        </div>
        <p className="text-sm font-semibold text-foreground mb-1">Sin datos de ciudades</p>
        <p className="text-xs text-muted-foreground max-w-sm mx-auto">
          No hay ciudades con suficientes pedidos en este rango. Probá con un rango más amplio.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Stat banner: valor total perdido — gradient hero pattern */}
      {totalLost > 0 && (
        <div className="rounded-2xl border-2 border-danger/30 bg-gradient-to-br from-danger/8 via-danger/3 to-transparent p-5 flex items-center gap-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border bg-danger/15 border-danger/40">
            <AlertTriangle size={18} className="text-danger" aria-hidden="true" strokeWidth={2.25} />
          </div>
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.12em] font-bold text-muted-foreground">
              Valor perdido total · top {sorted.length} ciudades
            </div>
            <div className="font-extrabold text-3xl text-danger tabular-nums leading-none mt-1.5">
              {formatCOP(totalLost)}
            </div>
          </div>
        </div>
      )}

      <section className="rounded-xl border border-border bg-card overflow-hidden">
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
                  <td className="text-right"><ReturnRateBar value={r.tasa_devolucion} /></td>
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

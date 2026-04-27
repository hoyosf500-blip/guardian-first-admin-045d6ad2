import { memo, useMemo, useState } from 'react';
import { Download, Package, AlertOctagon } from 'lucide-react';
import { formatCOP } from '@/lib/utils';
import { rowsToCsv, downloadCsv } from '@/lib/csvExport';
import { SortableHeader, type SortDir } from './SortableHeader';
import type { ProductFailure } from '@/lib/logistics.types';

interface Props { rows: ProductFailure[]; }

type Key = keyof ProductFailure;

/** Heat-map data bar para tasa de entrega. Tono inverso: <30%
 *  danger (producto crítico), 30-60% warning, ≥60% success. */
function DeliveryRateBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value));
  const tone = pct < 30 ? 'danger' : pct < 60 ? 'warning' : 'success';
  return (
    <div className={`data-bar tone-${tone}`}>
      <div className="data-bar-fill" style={{ width: `${pct}%` }} aria-hidden="true" />
      <span className="data-bar-value">{value.toFixed(1)}%</span>
    </div>
  );
}

/** Severity badge — productos crónicamente fallidos (entrega <30%
 *  + ≥10 envíos) → invita a discontinuar del catálogo. */
function SeverityBadge({ row }: { row: ProductFailure }) {
  if (row.total_pedidos >= 10 && row.tasa_entrega < 30) {
    return (
      <span className="pill pill-danger">
        <AlertOctagon size={9} aria-hidden="true" /> Crítico
      </span>
    );
  }
  return null;
}

export default memo(function ProductFailuresTable({ rows }: Props) {
  const [sortKey, setSortKey] = useState<Key>('tasa_entrega');
  const [sortDir, setSortDir] = useState<SortDir>('asc'); // peores primero

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

  const criticalCount = useMemo(
    () => sorted.filter(r => r.total_pedidos >= 10 && r.tasa_entrega < 30).length,
    [sorted],
  );
  const totalLost = useMemo(
    () => sorted.reduce((s, r) => s + (r.valor_perdido ?? 0), 0),
    [sorted],
  );

  const onSort = (k: Key) => {
    if (k === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(k); setSortDir(k === 'tasa_entrega' ? 'asc' : 'desc'); }
  };

  const exportCsv = () => {
    const csv = rowsToCsv<ProductFailure>(
      ['producto', 'total_pedidos', 'entregados', 'devueltos',
       'tasa_entrega', 'tasa_devolucion', 'valor_entregado', 'valor_perdido'],
      sorted,
    );
    downloadCsv(`logistica-productos-${new Date().toISOString().split('T')[0]}.csv`, csv);
  };

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-card/40 p-10 text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted/40">
          <Package size={20} className="text-muted-foreground" aria-hidden="true" />
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
      {/* Stat banners */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {criticalCount > 0 && (
          <div className="rounded-xl border border-[hsl(var(--danger)/0.30)] bg-card p-4 flex items-center gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-[hsl(var(--danger)/0.12)]">
              <AlertOctagon size={16} className="text-[hsl(var(--danger))]" aria-hidden="true" strokeWidth={2.25} />
            </div>
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-[0.08em] font-semibold text-muted-foreground">
                Productos críticos
              </div>
              <div className="font-mono text-lg font-bold text-foreground tabular-nums leading-tight">
                {criticalCount} <span className="text-sm font-medium text-muted-foreground">{criticalCount === 1 ? 'producto' : 'productos'}</span>
              </div>
              <div className="text-[11px] text-[hsl(var(--danger))] font-semibold mt-0.5">
                Tasa de entrega &lt;30% — considerar discontinuar
              </div>
            </div>
          </div>
        )}
        {totalLost > 0 && (
          <div className="rounded-xl border border-[hsl(var(--warning)/0.30)] bg-card p-4 flex items-center gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-[hsl(var(--warning)/0.12)]">
              <Package size={16} className="text-[hsl(var(--warning))]" aria-hidden="true" strokeWidth={2.25} />
            </div>
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-[0.08em] font-semibold text-muted-foreground">
                Valor perdido · top {sorted.length} productos
              </div>
              <div className="font-mono text-2xl font-bold text-[hsl(var(--warning))] tabular-nums leading-tight">
                {formatCOP(totalLost)}
              </div>
            </div>
          </div>
        )}
      </div>

      <section className="rounded-xl border border-border bg-card overflow-hidden">
        <header className="px-4 py-3 border-b border-border/60 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-bold text-foreground tracking-tight">
              Productos con menor tasa de entrega
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
                <th><SortableHeader<Key> label="Producto" sortKey="producto" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="text-right"><SortableHeader<Key> label="Envíos" sortKey="total_pedidos" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="text-right"><SortableHeader<Key> label="Entregados" sortKey="entregados" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="text-right"><SortableHeader<Key> label="Devueltos" sortKey="devueltos" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="text-right"><SortableHeader<Key> label="Entrega %" sortKey="tasa_entrega" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="text-right"><SortableHeader<Key> label="Devol %" sortKey="tasa_devolucion" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="text-right"><SortableHeader<Key> label="Valor perdido" sortKey="valor_perdido" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, idx) => (
                <tr key={r.producto}>
                  <td>
                    <span className="font-mono text-[11px] font-bold tabular-nums text-muted-foreground">
                      {String(idx + 1).padStart(2, '0')}
                    </span>
                  </td>
                  <td className="max-w-md">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-semibold text-foreground truncate" title={r.producto}>{r.producto}</span>
                      <SeverityBadge row={r} />
                    </div>
                  </td>
                  <td className="text-right font-mono tabular-nums">{r.total_pedidos.toLocaleString('es-CO')}</td>
                  <td className="text-right font-mono tabular-nums text-[hsl(var(--success))] font-semibold">{r.entregados.toLocaleString('es-CO')}</td>
                  <td className="text-right font-mono tabular-nums text-[hsl(var(--danger))] font-semibold">{r.devueltos.toLocaleString('es-CO')}</td>
                  <td className="text-right"><DeliveryRateBar value={r.tasa_entrega} /></td>
                  <td className="text-right font-mono tabular-nums text-muted-foreground">{r.tasa_devolucion.toFixed(1)}%</td>
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

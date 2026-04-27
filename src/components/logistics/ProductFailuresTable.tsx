import { memo, useMemo, useState } from 'react';
import { Download, Package, AlertOctagon } from 'lucide-react';
import { formatCOP } from '@/lib/utils';
import { rowsToCsv, downloadCsv } from '@/lib/csvExport';
import { SortableHeader, type SortDir } from './SortableHeader';
import type { ProductFailure } from '@/lib/logistics.types';

interface Props { rows: ProductFailure[]; }

type Key = keyof ProductFailure;

// Data bar para tasa de entrega: tono según severidad. Entrega <30%
// es señal de alerta para discontinuar el producto del catálogo.
function DeliveryRateBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value));
  const tone =
    pct < 30 ? 'bg-rose-500/15 [&>div]:bg-gradient-to-r [&>div]:from-rose-600/60 [&>div]:to-rose-400/80 text-rose-300'
    : pct < 60 ? 'bg-amber-500/10 [&>div]:bg-gradient-to-r [&>div]:from-amber-500/40 [&>div]:to-amber-400/60 text-amber-300'
    : 'bg-emerald-500/10 [&>div]:bg-gradient-to-r [&>div]:from-emerald-500/40 [&>div]:to-emerald-400/60 text-emerald-300';
  return (
    <div className={`relative inline-flex h-7 w-28 items-center justify-end overflow-hidden rounded-md ${tone}`}>
      <div className="absolute inset-y-0 left-0 rounded-md transition-all" style={{ width: `${pct}%` }} aria-hidden="true" />
      <span className="relative px-2 text-xs font-bold tabular-nums">{value.toFixed(1)}%</span>
    </div>
  );
}

// Severity badge: producto crónicamente fallido (entrega <30% + ≥10
// envíos) → invita a discontinuar.
function SeverityBadge({ row }: { row: ProductFailure }) {
  if (row.total_pedidos >= 10 && row.tasa_entrega < 30) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-bold text-rose-400">
        <AlertOctagon size={9} aria-hidden="true" /> CRÍTICO
      </span>
    );
  }
  return null;
}

export default memo(function ProductFailuresTable({ rows }: Props) {
  const [sortKey, setSortKey] = useState<Key>('tasa_entrega');
  const [sortDir, setSortDir] = useState<SortDir>('asc'); // los PEORES primero

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
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
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
      {/* Insight callouts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {criticalCount > 0 && (
          <div className="rounded-xl border border-rose-500/25 bg-gradient-to-br from-rose-500/[0.08] to-card p-3.5 flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-rose-500/15 ring-1 ring-rose-500/30">
              <AlertOctagon size={16} className="text-rose-400" aria-hidden="true" />
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">
                Productos críticos
              </div>
              <div className="text-sm font-bold text-foreground">
                {criticalCount} {criticalCount === 1 ? 'producto' : 'productos'} con &lt;30% entrega
              </div>
              <div className="text-xs text-rose-400 font-semibold">Considerar discontinuar</div>
            </div>
          </div>
        )}
        {totalLost > 0 && (
          <div className="rounded-xl border border-amber-500/25 bg-gradient-to-br from-amber-500/[0.08] to-card p-3.5 flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 ring-1 ring-amber-500/30">
              <Package size={16} className="text-amber-400" aria-hidden="true" />
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">
                Valor perdido — top {sorted.length} productos
              </div>
              <div className="text-xl font-bold text-amber-400 tabular-nums leading-tight">
                {formatCOP(totalLost)}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="flex items-center justify-between p-3.5 border-b border-border bg-gradient-to-r from-card to-card/50">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-500/10 ring-1 ring-amber-500/20">
              <Package size={13} className="text-amber-400" aria-hidden="true" />
            </div>
            <h3 className="text-sm font-bold text-foreground">
              Productos con menor tasa de entrega
            </h3>
            <span className="text-[11px] text-muted-foreground tabular-nums">· {sorted.length}</span>
          </div>
          <button
            type="button"
            onClick={exportCsv}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-semibold transition-colors hover:border-border-strong hover:bg-surface"
          >
            <Download size={12} aria-hidden="true" /> CSV
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface/40 border-b border-border/60">
              <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2.5 w-12">#</th>
                <th className="px-3 py-2.5"><SortableHeader<Key> label="Producto" sortKey="producto" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right"><SortableHeader<Key> label="Envíos" sortKey="total_pedidos" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right"><SortableHeader<Key> label="Entregados" sortKey="entregados" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right"><SortableHeader<Key> label="Devueltos" sortKey="devueltos" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right"><SortableHeader<Key> label="Entrega %" sortKey="tasa_entrega" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right"><SortableHeader<Key> label="Devol %" sortKey="tasa_devolucion" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right"><SortableHeader<Key> label="Valor perdido" sortKey="valor_perdido" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, idx) => (
                <tr
                  key={r.producto}
                  className="border-t border-border/40 transition-colors hover:bg-surface/40"
                >
                  <td className="px-3 py-3 text-muted-foreground tabular-nums text-xs font-bold">#{idx + 1}</td>
                  <td className="px-3 py-3 max-w-md">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-semibold text-foreground truncate" title={r.producto}>{r.producto}</span>
                      <SeverityBadge row={r} />
                    </div>
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">{r.total_pedidos.toLocaleString('es-CO')}</td>
                  <td className="px-3 py-3 text-right tabular-nums text-emerald-400 font-semibold">{r.entregados.toLocaleString('es-CO')}</td>
                  <td className="px-3 py-3 text-right tabular-nums text-rose-400 font-semibold">{r.devueltos.toLocaleString('es-CO')}</td>
                  <td className="px-3 py-3 text-right"><DeliveryRateBar value={r.tasa_entrega} /></td>
                  <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">{r.tasa_devolucion.toFixed(1)}%</td>
                  <td className="px-3 py-3 text-right tabular-nums font-mono text-xs text-rose-400">{formatCOP(r.valor_perdido)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
});

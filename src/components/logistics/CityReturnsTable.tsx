import { memo, useMemo, useState } from 'react';
import { Download, MapPin } from 'lucide-react';
import { formatCOP } from '@/lib/utils';
import { rowsToCsv, downloadCsv } from '@/lib/csvExport';
import { SortableHeader, type SortDir } from './SortableHeader';
import type { CityReturns } from '@/lib/logistics.types';

interface Props { rows: CityReturns[]; }

type Key = keyof CityReturns;

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
      <div className="rounded-xl border border-dashed border-border bg-card/40 p-8 text-center">
        <MapPin size={20} className="mx-auto text-muted-foreground mb-2" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">
          No hay ciudades con suficientes pedidos en este rango.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between p-3 border-b border-border">
        <h3 className="text-sm font-semibold text-foreground">
          Top {sorted.length} ciudades por tasa de devolución
        </h3>
        <button
          type="button"
          onClick={exportCsv}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-semibold hover:border-border-strong"
        >
          <Download size={12} aria-hidden="true" /> CSV
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface/40">
            <tr className="text-left">
              <th className="px-3 py-2 w-8">#</th>
              <th className="px-3 py-2"><SortableHeader<Key> label="Ciudad" sortKey="ciudad" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
              <th className="px-3 py-2"><SortableHeader<Key> label="Depto" sortKey="departamento" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
              <th className="px-3 py-2 text-right"><SortableHeader<Key> label="Envíos" sortKey="total_pedidos" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
              <th className="px-3 py-2 text-right"><SortableHeader<Key> label="Devueltos" sortKey="devueltos" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
              <th className="px-3 py-2 text-right"><SortableHeader<Key> label="Devol %" sortKey="tasa_devolucion" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
              <th className="px-3 py-2 text-right"><SortableHeader<Key> label="Valor perdido" sortKey="valor_perdido" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, idx) => (
              <tr key={`${r.ciudad}|${r.departamento}`} className="border-t border-border/50 hover:bg-card/60">
                <td className="px-3 py-2 text-muted-foreground tabular-nums">{idx + 1}</td>
                <td className="px-3 py-2 font-semibold text-foreground">{r.ciudad}</td>
                <td className="px-3 py-2 text-muted-foreground">{r.departamento || '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.total_pedidos.toLocaleString('es-CO')}</td>
                <td className="px-3 py-2 text-right tabular-nums text-red-500">{r.devueltos.toLocaleString('es-CO')}</td>
                <td className="px-3 py-2 text-right tabular-nums font-bold">{r.tasa_devolucion.toFixed(1)}%</td>
                <td className="px-3 py-2 text-right tabular-nums font-mono text-xs text-red-500">{formatCOP(r.valor_perdido)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
});

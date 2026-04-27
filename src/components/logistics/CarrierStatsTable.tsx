import { memo, useMemo, useState } from 'react';
import { Download, Truck } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, Legend } from 'recharts';
import { formatCOP } from '@/lib/utils';
import { rowsToCsv, downloadCsv } from '@/lib/csvExport';
import { SortableHeader, type SortDir } from './SortableHeader';
import type { CarrierStats } from '@/lib/logistics.types';

interface Props { rows: CarrierStats[]; }

type Key = keyof CarrierStats;

export default memo(function CarrierStatsTable({ rows }: Props) {
  const [sortKey, setSortKey] = useState<Key>('entregados');
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
    const csv = rowsToCsv<CarrierStats>(
      ['transportadora', 'total_pedidos', 'entregados', 'devueltos',
       'tasa_entrega', 'tasa_devolucion', 'valor_entregado', 'valor_perdido', 'avg_dias_entrega'],
      sorted,
    );
    downloadCsv(`logistica-transportadoras-${new Date().toISOString().split('T')[0]}.csv`, csv);
  };

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-card/40 p-8 text-center">
        <Truck size={20} className="mx-auto text-muted-foreground mb-2" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">
          No hay transportadoras con suficientes pedidos en este rango.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Bar chart Top 5 — entregas vs devoluciones */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">Top 5 — entrega vs devolución (%)</h3>
        </div>
        <ResponsiveContainer width="100%" height={Math.max(180, sorted.slice(0, 5).length * 36)}>
          <BarChart data={sorted.slice(0, 5)} layout="vertical" margin={{ left: 80, right: 12 }}>
            <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 11 }} />
            <YAxis type="category" dataKey="transportadora" tick={{ fontSize: 11 }} width={140} />
            <Tooltip
              formatter={(v: number, n: string) => [`${v.toFixed(1)}%`, n]}
              contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', fontSize: 12 }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="tasa_entrega"     name="Entrega %"    fill="#10b981" />
            <Bar dataKey="tasa_devolucion"  name="Devolución %" fill="#ef4444" />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Tabla detalle */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="flex items-center justify-between p-3 border-b border-border">
          <h3 className="text-sm font-semibold text-foreground">Detalle por transportadora</h3>
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
                <th className="px-3 py-2"><SortableHeader<Key> label="Transportadora" sortKey="transportadora" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2 text-right"><SortableHeader<Key> label="Envíos" sortKey="total_pedidos" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2 text-right"><SortableHeader<Key> label="Entregados" sortKey="entregados" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2 text-right"><SortableHeader<Key> label="Devueltos" sortKey="devueltos" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2 text-right"><SortableHeader<Key> label="Entrega %" sortKey="tasa_entrega" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2 text-right"><SortableHeader<Key> label="Devol %" sortKey="tasa_devolucion" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2 text-right"><SortableHeader<Key> label="Días promedio" sortKey="avg_dias_entrega" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2 text-right"><SortableHeader<Key> label="Valor entregado" sortKey="valor_entregado" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(r => (
                <tr key={r.transportadora} className="border-t border-border/50 hover:bg-card/60">
                  <td className="px-3 py-2 font-semibold text-foreground">{r.transportadora}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.total_pedidos.toLocaleString('es-CO')}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-emerald-500">{r.entregados.toLocaleString('es-CO')}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-red-500">{r.devueltos.toLocaleString('es-CO')}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.tasa_entrega.toFixed(1)}%</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.tasa_devolucion.toFixed(1)}%</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.avg_dias_entrega != null ? `${r.avg_dias_entrega}d` : '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-mono text-xs">{formatCOP(r.valor_entregado)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
});

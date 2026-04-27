import { memo, useMemo, useState } from 'react';
import { Download, Truck, Trophy, Medal, Award } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, Legend, LabelList } from 'recharts';
import { formatCOP } from '@/lib/utils';
import { rowsToCsv, downloadCsv } from '@/lib/csvExport';
import { SortableHeader, type SortDir } from './SortableHeader';
import type { CarrierStats } from '@/lib/logistics.types';

interface Props { rows: CarrierStats[]; }

type Key = keyof CarrierStats;

// Data bar inline para columnas %. Fondo tonal + barra rellena
// proporcional al valor → comunica magnitud sin ocupar espacio extra.
function DataBar({
  value,
  tone,
}: {
  value: number;
  tone: 'success' | 'danger' | 'warning';
}) {
  const pct = Math.max(0, Math.min(100, value));
  const palette = {
    success: 'bg-emerald-500/10 [&>div]:bg-gradient-to-r [&>div]:from-emerald-500/40 [&>div]:to-emerald-400/60 text-emerald-400',
    danger:  'bg-rose-500/10 [&>div]:bg-gradient-to-r [&>div]:from-rose-500/40 [&>div]:to-rose-400/60 text-rose-400',
    warning: 'bg-amber-500/10 [&>div]:bg-gradient-to-r [&>div]:from-amber-500/40 [&>div]:to-amber-400/60 text-amber-400',
  };
  return (
    <div className={`relative inline-flex h-7 w-24 items-center justify-end overflow-hidden rounded-md ${palette[tone]}`}>
      <div className="absolute inset-y-0 left-0 rounded-md transition-all" style={{ width: `${pct}%` }} aria-hidden="true" />
      <span className="relative px-2 text-xs font-bold tabular-nums">{value.toFixed(1)}%</span>
    </div>
  );
}

// Rank con icon medalla para top 3, número para el resto.
function RankBadge({ idx }: { idx: number }) {
  if (idx === 0) return <Trophy className="h-4 w-4 text-amber-400" aria-label="Posición 1" />;
  if (idx === 1) return <Medal className="h-4 w-4 text-zinc-300" aria-label="Posición 2" />;
  if (idx === 2) return <Award className="h-4 w-4 text-orange-500" aria-label="Posición 3" />;
  return <span className="text-xs font-bold text-muted-foreground tabular-nums">#{idx + 1}</span>;
}

// Tooltip custom con breakdown completo + dots de color por categoría.
interface TooltipPayload { payload: CarrierStats; }
function CarrierTooltip({ active, payload }: { active?: boolean; payload?: TooltipPayload[] }) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  return (
    <div className="rounded-lg border border-border bg-card/95 backdrop-blur-sm p-3 shadow-2xl text-xs min-w-[220px]">
      <div className="mb-2 font-bold text-sm text-foreground">{d.transportadora}</div>
      <div className="space-y-1.5">
        <Row dot="bg-emerald-500" label="Entregados"  value={d.entregados}        extra={`${d.tasa_entrega.toFixed(1)}%`}    valueClass="text-emerald-400" />
        <Row dot="bg-blue-500"    label="En tránsito" value={d.en_transito ?? 0}                                              valueClass="text-blue-400" />
        <Row dot="bg-amber-500"   label="Novedades"   value={d.novedades ?? 0}                                                valueClass="text-amber-400" />
        <Row dot="bg-rose-500"    label="Devueltos"   value={d.devueltos}         extra={`${d.tasa_devolucion.toFixed(1)}%`} valueClass="text-rose-400" />
        <div className="flex items-center justify-between gap-4 pt-1.5 mt-1.5 border-t border-border/60">
          <span className="text-muted-foreground">Total envíos</span>
          <span className="font-bold tabular-nums text-foreground">{d.total_pedidos.toLocaleString('es-CO')}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">Valor entregado</span>
          <span className="font-bold tabular-nums text-emerald-400">{formatCOP(d.valor_entregado)}</span>
        </div>
      </div>
    </div>
  );
}
function Row({ dot, label, value, extra, valueClass }: { dot: string; label: string; value: number; extra?: string; valueClass?: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden="true" />
        {label}
      </span>
      <span className={`font-bold tabular-nums ${valueClass ?? 'text-foreground'}`}>
        {value.toLocaleString('es-CO')}{extra ? <span className="ml-1.5 font-normal opacity-60">{extra}</span> : null}
      </span>
    </div>
  );
}

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

  // Top 5 por VOLUMEN total (no por entrega) — el chart comunica
  // composición. Si una transportadora mueve 1000 envíos con 30%
  // entrega importa más que una con 5 envíos al 90%.
  const topByVolume = useMemo(() => {
    return [...rows]
      .sort((a, b) => (b.total_pedidos ?? 0) - (a.total_pedidos ?? 0))
      .slice(0, 5);
  }, [rows]);

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
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Truck size={20} className="text-muted-foreground" aria-hidden="true" />
        </div>
        <p className="text-sm font-semibold text-foreground mb-1">Sin datos de transportadoras</p>
        <p className="text-xs text-muted-foreground max-w-sm mx-auto">
          No hay transportadoras con suficientes pedidos en este rango. Probá con un rango más amplio o esperá a que sincronicen más envíos.
        </p>
      </div>
    );
  }

  // Insights: mejor entrega + peor devolución (≥10 envíos para evitar ruido).
  const bestRate = sorted.reduce<CarrierStats | null>(
    (best, r) => (r.total_pedidos >= 10 && (!best || r.tasa_entrega > best.tasa_entrega) ? r : best),
    null,
  );
  const worstRate = sorted.reduce<CarrierStats | null>(
    (worst, r) => (r.total_pedidos >= 10 && (!worst || r.tasa_devolucion > worst.tasa_devolucion) ? r : worst),
    null,
  );

  return (
    <div className="space-y-4">
      {/* Insight callouts: mejor + peor transportadora con ≥10 envíos */}
      {(bestRate || worstRate) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {bestRate && (
            <div className="rounded-xl border border-emerald-500/25 bg-gradient-to-br from-emerald-500/[0.08] to-card p-3.5 flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 ring-1 ring-emerald-500/30">
                <Trophy size={16} className="text-emerald-400" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">Mejor desempeño</div>
                <div className="text-sm font-bold text-foreground truncate">{bestRate.transportadora}</div>
                <div className="text-xs text-emerald-400 font-semibold tabular-nums">
                  {bestRate.tasa_entrega.toFixed(1)}% entrega · {bestRate.total_pedidos.toLocaleString('es-CO')} envíos
                </div>
              </div>
            </div>
          )}
          {worstRate && (
            <div className="rounded-xl border border-rose-500/25 bg-gradient-to-br from-rose-500/[0.08] to-card p-3.5 flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-rose-500/15 ring-1 ring-rose-500/30">
                <Truck size={16} className="text-rose-400" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">Más devoluciones</div>
                <div className="text-sm font-bold text-foreground truncate">{worstRate.transportadora}</div>
                <div className="text-xs text-rose-400 font-semibold tabular-nums">
                  {worstRate.tasa_devolucion.toFixed(1)}% devuelto · {formatCOP(worstRate.valor_perdido)} perdido
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Chart card: barras stacked horizontales con composición real.
          Cada barra muestra TOTAL como ancho y se divide en 4 segmentos:
          entregados / en tránsito / novedades / devueltos. Mucho más
          informativo que dos barras paralelas — comunica volumen +
          composición en un solo glance. */}
      <div className="rounded-xl border border-border bg-gradient-to-br from-card to-card/60 p-5">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-foreground">Volumen y composición</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Top 5 por volumen — cada barra es el total de envíos dividido por estado actual
            </p>
          </div>
        </div>

        <ResponsiveContainer width="100%" height={Math.max(220, topByVolume.length * 56)}>
          <BarChart
            data={topByVolume}
            layout="vertical"
            margin={{ top: 4, right: 80, left: 0, bottom: 4 }}
            barCategoryGap="22%"
          >
            <defs>
              <linearGradient id="g_entreg" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#34d399" />
                <stop offset="100%" stopColor="#10b981" />
              </linearGradient>
              <linearGradient id="g_transito" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#60a5fa" />
                <stop offset="100%" stopColor="#3b82f6" />
              </linearGradient>
              <linearGradient id="g_novedad" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#fbbf24" />
                <stop offset="100%" stopColor="#f59e0b" />
              </linearGradient>
              <linearGradient id="g_devuelt" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#fb7185" />
                <stop offset="100%" stopColor="#f43f5e" />
              </linearGradient>
            </defs>
            <XAxis
              type="number"
              tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
              stroke="hsl(var(--border))"
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              type="category"
              dataKey="transportadora"
              tick={{ fontSize: 11, fill: 'hsl(var(--foreground))', fontWeight: 600 }}
              width={130}
              stroke="hsl(var(--border))"
              tickLine={false}
              axisLine={false}
            />
            <Tooltip content={<CarrierTooltip />} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
            <Legend
              wrapperStyle={{ fontSize: 11, paddingTop: 12 }}
              iconType="circle"
              iconSize={9}
            />
            <Bar dataKey="entregados"  stackId="vol" name="Entregados"  fill="url(#g_entreg)"  radius={[6, 0, 0, 6]} />
            <Bar dataKey="en_transito" stackId="vol" name="En tránsito" fill="url(#g_transito)" />
            <Bar dataKey="novedades"   stackId="vol" name="Novedades"   fill="url(#g_novedad)" />
            <Bar dataKey="devueltos"   stackId="vol" name="Devueltos"   fill="url(#g_devuelt)" radius={[0, 6, 6, 0]}>
              <LabelList
                dataKey="total_pedidos"
                position="right"
                fill="hsl(var(--foreground))"
                fontSize={11}
                fontWeight={700}
                formatter={(v: number) => v.toLocaleString('es-CO')}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Tabla detalle con data bars inline + rank badges */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="flex items-center justify-between p-3.5 border-b border-border bg-gradient-to-r from-card to-card/50">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-500/10 ring-1 ring-blue-500/20">
              <Truck size={13} className="text-blue-400" aria-hidden="true" />
            </div>
            <h3 className="text-sm font-bold text-foreground">Detalle por transportadora</h3>
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
                <th className="px-3 py-2.5"><SortableHeader<Key> label="Transportadora" sortKey="transportadora" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right"><SortableHeader<Key> label="Envíos" sortKey="total_pedidos" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right"><SortableHeader<Key> label="Entregados" sortKey="entregados" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right"><SortableHeader<Key> label="Devueltos" sortKey="devueltos" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right"><SortableHeader<Key> label="Entrega %" sortKey="tasa_entrega" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right"><SortableHeader<Key> label="Devol %" sortKey="tasa_devolucion" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right"><SortableHeader<Key> label="Días promedio" sortKey="avg_dias_entrega" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
                <th className="px-3 py-2.5 text-right"><SortableHeader<Key> label="Valor entregado" sortKey="valor_entregado" activeKey={sortKey} activeDir={sortDir} onSort={onSort} /></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, idx) => (
                <tr
                  key={r.transportadora}
                  className="border-t border-border/40 transition-colors hover:bg-surface/40"
                >
                  <td className="px-3 py-3"><RankBadge idx={idx} /></td>
                  <td className="px-3 py-3 font-semibold text-foreground">{r.transportadora}</td>
                  <td className="px-3 py-3 text-right tabular-nums font-semibold">{r.total_pedidos.toLocaleString('es-CO')}</td>
                  <td className="px-3 py-3 text-right tabular-nums text-emerald-400 font-semibold">{r.entregados.toLocaleString('es-CO')}</td>
                  <td className="px-3 py-3 text-right tabular-nums text-rose-400 font-semibold">{r.devueltos.toLocaleString('es-CO')}</td>
                  <td className="px-3 py-3 text-right"><DataBar value={r.tasa_entrega} tone="success" /></td>
                  <td className="px-3 py-3 text-right"><DataBar value={r.tasa_devolucion} tone="danger" /></td>
                  <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">{r.avg_dias_entrega != null ? `${r.avg_dias_entrega}d` : '—'}</td>
                  <td className="px-3 py-3 text-right tabular-nums font-mono text-xs text-foreground">{formatCOP(r.valor_entregado)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
});

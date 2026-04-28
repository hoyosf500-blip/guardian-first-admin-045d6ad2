import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  PieChart, Pie, Cell, Tooltip as RTooltip, ResponsiveContainer,
  LineChart, Line, XAxis, YAxis, CartesianGrid, Legend,
  BarChart, Bar,
} from 'recharts';
import { supabase } from '@/integrations/supabase/client';
import { Skeleton } from '@/components/ui/skeleton';
import { Info, RefreshCw } from 'lucide-react';

type Range = '7d' | '30d' | '90d';

interface DashboardData {
  kpis: { total: number; entregados: number; devueltos: number; en_transito: number };
  by_transportadora: { transportadora: string; total: number }[];
  by_transportadora_and_date: { fecha: string; transportadora: string; total: number }[];
  by_estado: { estado_agrupado: string; total: number }[];
  by_date_and_estado: { fecha: string; entregada: number; devolucion: number; transito: number; novedad: number; rechazada: number }[];
  by_transportadora_and_estado: { transportadora: string; entregada: number; devolucion: number; transito: number; novedad: number; rechazada: number; total: number }[];
}

// Colores fijos por estado (paleta EFFI)
const ESTADO_COLORS: Record<string, string> = {
  'Entregada a destino': '#22c55e',
  'Devolucion a origen': '#ef4444',
  'En transito': '#9ca3af',
  'Novedad': '#f97316',
  'Rechazada': '#dc2626',
  'En preparacion': '#a78bfa',
  'Cancelada': '#6b7280',
  'Otro': '#94a3b8',
};

// Paleta para transportadoras (asignación estable por orden alfabético)
const CARRIER_PALETTE = ['#0f172a', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];

function carrierColor(name: string, index: number): string {
  return CARRIER_PALETTE[index % CARRIER_PALETTE.length];
}

function fmtDate(s: string): string {
  const d = new Date(s);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function pct(n: number, total: number): string {
  if (!total) return '0%';
  return `${((n / total) * 100).toFixed(1)}%`;
}

function EmptyChart({ msg = 'No hay datos suficientes para este periodo' }: { msg?: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-[280px] text-gray-400 gap-2">
      <Info size={28} />
      <p className="text-sm">{msg}</p>
    </div>
  );
}

function ChartCard({ title, children, className = '' }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-white rounded-xl shadow-sm border border-gray-100 p-6 ${className}`}>
      <h3 className="text-lg font-semibold text-gray-800 mb-4">{title}</h3>
      {children}
    </div>
  );
}

export default function LogisticaTab() {
  const [range, setRange] = useState<Range>('30d');

  const { data, isLoading, isError, refetch, isFetching } = useQuery<DashboardData>({
    queryKey: ['logistics_dashboard', range],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('logistics_dashboard', { p_range: range });
      if (error) throw error;
      return data as unknown as DashboardData;
    },
    staleTime: 60_000,
  });

  // Asignar colores estables por transportadora
  const carrierColorMap = useMemo(() => {
    const map = new Map<string, string>();
    const list = [...(data?.by_transportadora ?? [])].sort((a, b) => a.transportadora.localeCompare(b.transportadora));
    list.forEach((c, i) => map.set(c.transportadora, carrierColor(c.transportadora, i)));
    return map;
  }, [data?.by_transportadora]);

  return (
    <div className="bg-gray-50 -mx-4 -my-4 sm:-mx-6 sm:-my-6 px-4 py-4 sm:px-6 sm:py-6 min-h-screen">
      {/* Header con filtro de rango */}
      <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-6">
        <div>
          <div className="text-[11px] uppercase tracking-wider font-semibold text-gray-500">Análisis · Admin</div>
          <h1 className="text-2xl font-bold text-gray-900 mt-1">Logística</h1>
          <p className="text-sm text-gray-600 mt-1">Rendimiento por transportadora, estado de pedidos y series temporales.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-lg border border-gray-200 bg-white p-1">
            {(['7d', '30d', '90d'] as Range[]).map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition ${
                  range === r ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-50'
                }`}
              >
                {r === '7d' ? '7 días' : r === '30d' ? '30 días' : '90 días'}
              </button>
            ))}
          </div>
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-gray-200 bg-white hover:bg-gray-50 disabled:opacity-50"
            aria-label="Refrescar"
          >
            <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} />
          </button>
        </div>
      </header>

      {isError && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-red-700">
          Error al cargar el dashboard. Probá refrescar.
        </div>
      )}

      {isLoading || !data ? (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
          </div>
          <Skeleton className="h-[360px] rounded-xl" />
          <Skeleton className="h-[360px] rounded-xl" />
        </div>
      ) : (
        <div className="space-y-6">
          {/* SECCIÓN 1 — KPI Cards */}
          <Section1Kpis kpis={data.kpis} />

          {/* SECCIÓN 2 — Donut Distribución por Transportadora */}
          <Section2Carriers data={data.by_transportadora} colorMap={carrierColorMap} />

          {/* SECCIÓN 3 — Líneas: Guías por fecha y transportadora */}
          <Section3Timeline data={data.by_transportadora_and_date} colorMap={carrierColorMap} />

          {/* SECCIÓN 4 — Donut Estado Global + Barras verticales apiladas */}
          <Section4Estado donut={data.by_estado} stack={data.by_date_and_estado} />

          {/* SECCIÓN 5 — Barras horizontales apiladas por transportadora */}
          <Section5HorizontalStack data={data.by_transportadora_and_estado} />
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sección 1: KPIs
// ─────────────────────────────────────────────────────────────────────────────
function Section1Kpis({ kpis }: { kpis: DashboardData['kpis'] }) {
  const total = kpis.total || 0;
  const cards = [
    { label: 'Total pedidos', value: total, sub: '100%', color: 'text-gray-900', badgeBg: 'bg-gray-100 text-gray-700' },
    { label: 'Entregados', value: kpis.entregados, sub: pct(kpis.entregados, total), color: 'text-green-600', badgeBg: 'bg-green-100 text-green-700' },
    { label: 'Devueltos', value: kpis.devueltos, sub: pct(kpis.devueltos, total), color: 'text-red-600', badgeBg: 'bg-red-100 text-red-700' },
    { label: 'En tránsito', value: kpis.en_transito, sub: pct(kpis.en_transito, total), color: 'text-gray-600', badgeBg: 'bg-gray-100 text-gray-700' },
  ];
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((c) => (
        <div key={c.label} className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <div className="text-sm font-medium text-gray-500">{c.label}</div>
          <div className={`text-3xl font-bold mt-2 tabular-nums ${c.color}`}>{c.value.toLocaleString('es-CO')}</div>
          <span className={`inline-block mt-2 px-2 py-0.5 text-xs font-semibold rounded-md ${c.badgeBg}`}>{c.sub}</span>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sección 2: Donut por Transportadora
// ─────────────────────────────────────────────────────────────────────────────
function Section2Carriers({ data, colorMap }: { data: DashboardData['by_transportadora']; colorMap: Map<string, string> }) {
  const total = data.reduce((s, x) => s + x.total, 0);
  const top = data[0];

  return (
    <ChartCard title="Distribución por transportadora">
      {data.length === 0 ? <EmptyChart /> : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-center">
          <div className="relative h-[280px]">
            <ResponsiveContainer>
              <PieChart>
                <Pie data={data} dataKey="total" nameKey="transportadora" innerRadius={60} outerRadius={100} paddingAngle={2}>
                  {data.map((d) => <Cell key={d.transportadora} fill={colorMap.get(d.transportadora) ?? '#94a3b8'} />)}
                </Pie>
                <RTooltip
                  contentStyle={{ background: '#111', border: 'none', borderRadius: 8, color: '#fff' }}
                  formatter={(v: number, n) => [`${v} (${pct(v, total)})`, n]}
                />
              </PieChart>
            </ResponsiveContainer>
            {top && (
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                <div className="text-xs text-gray-500 uppercase tracking-wide">{top.transportadora}</div>
                <div className="text-2xl font-bold text-gray-900">{pct(top.total, total)}</div>
              </div>
            )}
          </div>
          <ul className="space-y-2">
            {data.map((d) => (
              <li key={d.transportadora} className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2">
                  <span className="inline-block w-3 h-3 rounded-sm" style={{ background: colorMap.get(d.transportadora) }} />
                  <span className="font-medium text-gray-700">{d.transportadora}</span>
                </span>
                <span className="text-gray-500 tabular-nums">{d.total} · {pct(d.total, total)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </ChartCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sección 3: Líneas por fecha y transportadora
// ─────────────────────────────────────────────────────────────────────────────
function Section3Timeline({ data, colorMap }: { data: DashboardData['by_transportadora_and_date']; colorMap: Map<string, string> }) {
  const carriers = useMemo(() => Array.from(new Set(data.map((d) => d.transportadora))), [data]);
  const dates = useMemo(() => Array.from(new Set(data.map((d) => d.fecha))).sort(), [data]);

  const rows = useMemo(() => dates.map((fecha) => {
    const row: Record<string, number | string> = { fecha: fmtDate(fecha) };
    let total = 0;
    carriers.forEach((c) => {
      const found = data.find((d) => d.fecha === fecha && d.transportadora === c);
      const v = found?.total ?? 0;
      row[c] = v;
      total += v;
    });
    row.TODAS = total;
    return row;
  }), [data, dates, carriers]);

  return (
    <ChartCard title="Guías por fecha y transportadora">
      {rows.length === 0 ? <EmptyChart /> : (
        <div className="h-[320px]">
          <ResponsiveContainer>
            <LineChart data={rows} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="fecha" stroke="#94a3b8" fontSize={12} />
              <YAxis stroke="#94a3b8" fontSize={12} />
              <RTooltip contentStyle={{ background: '#111', border: 'none', borderRadius: 8, color: '#fff' }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="TODAS" stroke="#888" strokeWidth={2} strokeDasharray="5 5" dot={false} />
              {carriers.map((c) => (
                <Line key={c} type="monotone" dataKey={c} stroke={colorMap.get(c) ?? '#94a3b8'} strokeWidth={2} dot={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </ChartCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sección 4: Donut Estado + Barras verticales apiladas
// ─────────────────────────────────────────────────────────────────────────────
function Section4Estado({ donut, stack }: { donut: DashboardData['by_estado']; stack: DashboardData['by_date_and_estado'] }) {
  const total = donut.reduce((s, x) => s + x.total, 0);
  const top = donut[0];
  const stackRows = stack.map((s) => ({ ...s, fecha: fmtDate(s.fecha) }));

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <ChartCard title="Estado global">
        {donut.length === 0 ? <EmptyChart /> : (
          <div className="relative h-[280px]">
            <ResponsiveContainer>
              <PieChart>
                <Pie data={donut} dataKey="total" nameKey="estado_agrupado" innerRadius={60} outerRadius={100} paddingAngle={2}>
                  {donut.map((d) => <Cell key={d.estado_agrupado} fill={ESTADO_COLORS[d.estado_agrupado] ?? '#94a3b8'} />)}
                </Pie>
                <RTooltip
                  contentStyle={{ background: '#111', border: 'none', borderRadius: 8, color: '#fff' }}
                  formatter={(v: number, n) => [`${v} (${pct(v, total)})`, n]}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
              </PieChart>
            </ResponsiveContainer>
            {top && (
              <div className="absolute inset-x-0 top-1/2 -translate-y-[60%] flex flex-col items-center pointer-events-none">
                <div className="text-[10px] text-gray-500 uppercase tracking-wide max-w-[140px] text-center">{top.estado_agrupado}</div>
                <div className="text-2xl font-bold text-gray-900">{pct(top.total, total)}</div>
              </div>
            )}
          </div>
        )}
      </ChartCard>

      <ChartCard title="Estados por día">
        {stackRows.length === 0 ? <EmptyChart /> : (
          <div className="h-[280px]">
            <ResponsiveContainer>
              <BarChart data={stackRows} margin={{ top: 5, right: 10, bottom: 5, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="fecha" stroke="#94a3b8" fontSize={11} />
                <YAxis stroke="#94a3b8" fontSize={11} />
                <RTooltip contentStyle={{ background: '#111', border: 'none', borderRadius: 8, color: '#fff' }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="entregada" stackId="a" fill="#22c55e" name="Entregada" />
                <Bar dataKey="transito" stackId="a" fill="#9ca3af" name="En tránsito" />
                <Bar dataKey="novedad" stackId="a" fill="#f97316" name="Novedad" />
                <Bar dataKey="devolucion" stackId="a" fill="#ef4444" name="Devolución" />
                <Bar dataKey="rechazada" stackId="a" fill="#dc2626" name="Rechazada" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </ChartCard>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sección 5: Barras horizontales apiladas por transportadora (porcentajes)
// ─────────────────────────────────────────────────────────────────────────────
function Section5HorizontalStack({ data }: { data: DashboardData['by_transportadora_and_estado'] }) {
  const rows = data.map((d) => {
    const t = d.total || 1;
    return {
      transportadora: d.transportadora,
      Entregada: +(d.entregada * 100 / t).toFixed(2),
      'En tránsito': +(d.transito * 100 / t).toFixed(2),
      Novedad: +(d.novedad * 100 / t).toFixed(2),
      Devolución: +(d.devolucion * 100 / t).toFixed(2),
      Rechazada: +(d.rechazada * 100 / t).toFixed(2),
      total: d.total,
    };
  });

  return (
    <ChartCard title="Desempeño por transportadora (% de estado)">
      {rows.length === 0 ? <EmptyChart /> : (
        <div style={{ height: Math.max(200, rows.length * 60) }}>
          <ResponsiveContainer>
            <BarChart data={rows} layout="vertical" margin={{ top: 5, right: 20, bottom: 5, left: 20 }} stackOffset="expand">
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis type="number" domain={[0, 100]} stroke="#94a3b8" fontSize={11} tickFormatter={(v) => `${v}%`} />
              <YAxis type="category" dataKey="transportadora" stroke="#475569" fontSize={12} width={130} />
              <RTooltip
                contentStyle={{ background: '#111', border: 'none', borderRadius: 8, color: '#fff' }}
                formatter={(v: number, n) => [`${v.toFixed(2)}%`, n]}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="Entregada" stackId="b" fill="#22c55e" />
              <Bar dataKey="En tránsito" stackId="b" fill="#9ca3af" />
              <Bar dataKey="Novedad" stackId="b" fill="#f97316" />
              <Bar dataKey="Devolución" stackId="b" fill="#ef4444" />
              <Bar dataKey="Rechazada" stackId="b" fill="#dc2626" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </ChartCard>
  );
}

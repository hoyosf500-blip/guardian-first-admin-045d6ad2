import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  PieChart, Pie, Cell, Tooltip as RTooltip, ResponsiveContainer,
  LineChart, Line, XAxis, YAxis, CartesianGrid, Legend,
  BarChart, Bar,
} from 'recharts';
import { supabase } from '@/integrations/supabase/client';
import { Skeleton } from '@/components/ui/skeleton';
import { Info, RefreshCw, MapPin, Package } from 'lucide-react';

type Range = '7d' | '30d' | '90d';

interface DashboardData {
  kpis: { total: number; entregados: number; devueltos: number; en_transito: number };
  by_transportadora: { transportadora: string; total: number }[];
  by_transportadora_and_date: { fecha: string; transportadora: string; total: number }[];
  by_estado: { estado_agrupado: string; total: number }[];
  by_date_and_estado: { fecha: string; entregada: number; devolucion: number; transito: number; novedad: number; rechazada: number }[];
  by_transportadora_and_estado: { transportadora: string; entregada: number; devolucion: number; transito: number; novedad: number; rechazada: number; total: number }[];
}

// Tipos para las RPCs separadas (logistics_by_city, logistics_by_product)
interface CityData {
  ciudad: string;
  departamento: string;
  total_pedidos: number;
  entregados: number;
  devueltos: number;
  tasa_devolucion: number;
  tasa_entrega: number;
  valor_perdido: number;
}

interface ProductData {
  producto: string;
  total_pedidos: number;
  entregados: number;
  devueltos: number;
  tasa_entrega: number;
  tasa_devolucion: number;
  valor_entregado: number;
  valor_perdido: number;
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

const STACK_COLORS: Record<string, string> = {
  entregada: '#22c55e',
  transito: '#9ca3af',
  novedad: '#f97316',
  devolucion: '#ef4444',
  rechazada: '#dc2626',
};

const STACK_LABELS: Record<string, string> = {
  entregada: 'Entregada',
  transito: 'En tr\u00e1nsito',
  novedad: 'Novedad',
  devolucion: 'Devoluci\u00f3n',
  rechazada: 'Rechazada',
};

// Paleta para transportadoras
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

function rangeToDates(range: Range): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  if (range === '7d') from.setDate(to.getDate() - 7);
  else if (range === '30d') from.setDate(to.getDate() - 30);
  else from.setDate(to.getDate() - 90);
  return {
    from: from.toISOString().split('T')[0],
    to: to.toISOString().split('T')[0],
  };
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

/** Leyenda interactiva de Recharts — clic para ocultar/mostrar series */
function useInteractiveLegend(keys: string[]) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const toggle = (key: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const isVisible = (key: string) => !hidden.has(key);
  return { hidden, toggle, isVisible };
}

export default function LogisticaTab() {
  const [range, setRange] = useState<Range>('30d');
  const dates = useMemo(() => rangeToDates(range), [range]);

  // Query principal (monolítica — transportadoras + estados)
  const { data, isLoading, isError, refetch, isFetching } = useQuery<DashboardData>({
    queryKey: ['logistics_dashboard', range],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('logistics_dashboard', { p_range: range });
      if (error) throw error;
      return data as unknown as DashboardData;
    },
    staleTime: 60_000,
  });

  // Query separada: Ciudades (top devoluciones)
  const { data: citiesData, isLoading: citiesLoading } = useQuery<CityData[]>({
    queryKey: ['logistics_cities', range],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('logistics_by_city', {
        p_from_date: dates.from,
        p_to_date: dates.to,
        p_limit: 15,
      });
      if (error) throw error;
      return (data ?? []) as unknown as CityData[];
    },
    staleTime: 60_000,
    enabled: !!data,
  });

  // Query separada: Productos (menor entrega)
  const { data: productsData, isLoading: productsLoading } = useQuery<ProductData[]>({
    queryKey: ['logistics_products', range],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('logistics_by_product', {
        p_from_date: dates.from,
        p_to_date: dates.to,
        p_limit: 15,
      });
      if (error) throw error;
      return (data ?? []) as unknown as ProductData[];
    },
    staleTime: 60_000,
    enabled: !!data,
  });

  // Asignar colores estables por transportadora
  const carrierColorMap = useMemo(() => {
    const map = new Map<string, string>();
    const list = [...(data?.by_transportadora ?? [])].sort((a, b) => a.transportadora.localeCompare(b.transportadora));
    list.forEach((c, i) => map.set(c.transportadora, carrierColor(c.transportadora, i)));
    return map;
  }, [data?.by_transportadora]);

  const allLoaded = isLoading || citiesLoading || productsLoading;

  return (
    <div className="bg-gray-50 -mx-4 -my-4 sm:-mx-6 sm:-my-6 px-4 py-4 sm:px-6 sm:py-6 min-h-screen">
      {/* Header con filtro de rango */}
      <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-6">
        <div>
          <div className="text-[11px] uppercase tracking-wider font-semibold text-gray-500">An\u00e1lisis \u00b7 Admin</div>
          <h1 className="text-2xl font-bold text-gray-900 mt-1">Log\u00edstica</h1>
          <p className="text-sm text-gray-600 mt-1">Rendimiento por transportadora, ciudad, producto y estado de pedidos.</p>
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
                {r === '7d' ? '7 d\u00edas' : r === '30d' ? '30 d\u00edas' : '90 d\u00edas'}
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
          Error al cargar el dashboard. Prob\u00e1 refrescar.
        </div>
      )}

      {allLoaded || !data ? (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
          </div>
          <Skeleton className="h-[360px] rounded-xl" />
          <Skeleton className="h-[360px] rounded-xl" />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Skeleton className="h-[400px] rounded-xl" />
            <Skeleton className="h-[400px] rounded-xl" />
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {/* SECCI\u00d3N 1 \u2014 KPI Cards */}
          <Section1Kpis kpis={data.kpis} />

          {/* SECCI\u00d3N 2 \u2014 Donut Distribuci\u00f3n por Transportadora */}
          <Section2Carriers data={data.by_transportadora} colorMap={carrierColorMap} />

          {/* SECCI\u00d3N 3 \u2014 L\u00edneas: Gu\u00edas por fecha y transportadora */}
          <Section3Timeline data={data.by_transportadora_and_date} colorMap={carrierColorMap} />

          {/* SECCI\u00d3N 4 \u2014 Donut Estado Global + Barras verticales apiladas */}
          <Section4Estado donut={data.by_estado} stack={data.by_date_and_estado} />

          {/* SECCI\u00d3N 5 \u2014 Barras horizontales apiladas por transportadora */}
          <Section5HorizontalStack data={data.by_transportadora_and_estado} />

          {/* SECCI\u00d3N 6 \u2014 Tablas: Ciudades + Productos */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Section6Cities data={citiesData ?? []} />
            <Section7Products data={productsData ?? []} />
          </div>
        </div>
      )}
    </div>
  );
}

// \u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014
// Secci\u00f3n 1: KPIs
// \u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014
function Section1Kpis({ kpis }: { kpis: DashboardData['kpis'] }) {
  const total = kpis.total || 0;
  const cards = [
    { label: 'Total pedidos', value: total, sub: '100%', color: 'text-gray-900', badgeBg: 'bg-gray-100 text-gray-700' },
    { label: 'Entregados', value: kpis.entregados, sub: pct(kpis.entregados, total), color: 'text-green-600', badgeBg: 'bg-green-100 text-green-700' },
    { label: 'Devueltos', value: kpis.devueltos, sub: pct(kpis.devueltos, total), color: 'text-red-600', badgeBg: 'bg-red-100 text-red-700' },
    { label: 'En tr\u00e1nsito', value: kpis.en_transito, sub: pct(kpis.en_transito, total), color: 'text-gray-600', badgeBg: 'bg-gray-100 text-gray-700' },
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

// \u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014
// Secci\u00f3n 2: Donut por Transportadora
// \u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014
function Section2Carriers({ data, colorMap }: { data: DashboardData['by_transportadora']; colorMap: Map<string, string> }) {
  const total = data.reduce((s, x) => s + x.total, 0);
  const top = data[0];

  return (
    <ChartCard title="Distribuci\u00f3n por transportadora">
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
                <span className="text-gray-500 tabular-nums">{d.total} \u00b7 {pct(d.total, total)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </ChartCard>
  );
}

// \u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014
// Secci\u00f3n 3: L\u00edneas por fecha y transportadora (CON leyenda interactiva)
// \u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014
function Section3Timeline({ data, colorMap }: { data: DashboardData['by_transportadora_and_date']; colorMap: Map<string, string> }) {
  const carriers = useMemo(() => Array.from(new Set(data.map((d) => d.transportadora))), [data]);
  const dates = useMemo(() => Array.from(new Set(data.map((d) => d.fecha))).sort(), [data]);
  const legend = useInteractiveLegend(['TODAS', ...carriers]);

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
    <ChartCard title="Gu\u00edas por fecha y transportadora">
      {rows.length === 0 ? <EmptyChart /> : (
        <div className="h-[320px]">
          <ResponsiveContainer>
            <LineChart data={rows} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="fecha" stroke="#94a3b8" fontSize={12} />
              <YAxis stroke="#94a3b8" fontSize={12} />
              <RTooltip contentStyle={{ background: '#111', border: 'none', borderRadius: 8, color: '#fff' }} />
              <Legend
                wrapperStyle={{ fontSize: 12, cursor: 'pointer' }}
                onClick={(e: { value: string }) => legend.toggle(e.value)}
                formatter={(value: string) => (
                  <span style={{ opacity: legend.isVisible(value) ? 1 : 0.4, color: '#475569' }}>{value}</span>
                )}
              />
              {legend.isVisible('TODAS') && (
                <Line type="monotone" dataKey="TODAS" stroke="#888" strokeWidth={2} strokeDasharray="5 5" dot={false} />
              )}
              {carriers.map((c) =>
                legend.isVisible(c) ? (
                  <Line key={c} type="monotone" dataKey={c} stroke={colorMap.get(c) ?? '#94a3b8'} strokeWidth={2} dot={false} />
                ) : null
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </ChartCard>
  );
}

// \u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014
// Secci\u00f3n 4: Donut Estado + Barras verticales apiladas (CON leyenda interactiva)
// \u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014
function Section4Estado({ donut, stack }: { donut: DashboardData['by_estado']; stack: DashboardData['by_date_and_estado'] }) {
  const total = donut.reduce((s, x) => s + x.total, 0);
  const top = donut[0];
  const stackRows = stack.map((s) => ({ ...s, fecha: fmtDate(s.fecha) }));
  const stackKeys = ['entregada', 'transito', 'novedad', 'devolucion', 'rechazada'];
  const legend = useInteractiveLegend(stackKeys);

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

      <ChartCard title="Estados por d\u00eda">
        {stackRows.length === 0 ? <EmptyChart /> : (
          <div className="h-[280px]">
            <ResponsiveContainer>
              <BarChart data={stackRows} margin={{ top: 5, right: 10, bottom: 5, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="fecha" stroke="#94a3b8" fontSize={11} />
                <YAxis stroke="#94a3b8" fontSize={11} />
                <RTooltip contentStyle={{ background: '#111', border: 'none', borderRadius: 8, color: '#fff' }} />
                <Legend
                  wrapperStyle={{ fontSize: 11, cursor: 'pointer' }}
                  onClick={(e: { value: string }) => {
                    const key = Object.entries(STACK_LABELS).find(([,v]) => v === e.value)?.[0];
                    if (key) legend.toggle(key);
                  }}
                  formatter={(value: string) => {
                    const key = Object.entries(STACK_LABELS).find(([,v]) => v === value)?.[0] ?? value;
                    return <span style={{ opacity: legend.isVisible(key) ? 1 : 0.4, color: '#475569' }}>{value}</span>;
                  }}
                />
                {stackKeys.map((key) =>
                  legend.isVisible(key) ? (
                    <Bar key={key} dataKey={key} stackId="a" fill={STACK_COLORS[key]} name={STACK_LABELS[key]} />
                  ) : null
                )}
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </ChartCard>
    </div>
  );
}

// \u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014
// Secci\u00f3n 5: Barras horizontales apiladas por transportadora
// \u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014
function Section5HorizontalStack({ data }: { data: DashboardData['by_transportadora_and_estado'] }) {
  const rows = data.map((d) => {
    const t = d.total || 1;
    return {
      transportadora: d.transportadora,
      Entregada: +(d.entregada * 100 / t).toFixed(2),
      'En tr\u00e1nsito': +(d.transito * 100 / t).toFixed(2),
      Novedad: +(d.novedad * 100 / t).toFixed(2),
      'Devoluci\u00f3n': +(d.devolucion * 100 / t).toFixed(2),
      Rechazada: +(d.rechazada * 100 / t).toFixed(2),
      total: d.total,
    };
  });

  return (
    <ChartCard title="Desempe\u00f1o por transportadora (% de estado)">
      {rows.length === 0 ? <EmptyChart /> : (
        <div style={{ height: Math.max(200, rows.length * 60) }}>
          <ResponsiveContainer>
            <BarChart data={rows} layout="vertical" margin={{ top: 5, right: 20, bottom: 5, left: 20 }} stackOffset="expand">
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis type="number" domain={[0, 100]} stroke="#94a3b8" fontSize={11} tickFormatter={(v) => `${v}%`} />
              <YAxis type="category" dataKey="transportadora" stroke="#475569" fontSize={12} width={130} />
              <RTooltip
                contentStyle={{ background: '#111', border: 'none', borderRadius: 8, color: '#fff' }}
                formatter={(v: number, n: string, props: { payload?: { total?: number } }) => {
                  const total = props?.payload?.total ?? 0;
                  return [`${v.toFixed(1)}% (${Math.round(v * total / 100)} ped)`, n];
                }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="Entregada" stackId="b" fill="#22c55e" />
              <Bar dataKey="En tr\u00e1nsito" stackId="b" fill="#9ca3af" />
              <Bar dataKey="Novedad" stackId="b" fill="#f97316" />
              <Bar dataKey="Devoluci\u00f3n" stackId="b" fill="#ef4444" />
              <Bar dataKey="Rechazada" stackId="b" fill="#dc2626" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </ChartCard>
  );
}

// \u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014
// Secci\u00f3n 6: Tabla — Ciudades con m\u00e1s devoluciones (NUEVA)
// \u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014
function Section6Cities({ data }: { data: CityData[] }) {
  const sorted = [...data].sort((a, b) => b.tasa_devolucion - a.tasa_devolucion).slice(0, 15);

  return (
    <ChartCard title="Ciudades con m\u00e1s devoluciones" className="overflow-hidden">
      <div className="flex items-center gap-2 mb-4 text-gray-500">
        <MapPin size={16} />
        <span className="text-xs">Ordenado por % de devoluci\u00f3n (top 15)</span>
      </div>
      {sorted.length === 0 ? (
        <EmptyChart msg="No hay datos de ciudades para este periodo" />
      ) : (
        <div className="overflow-x-auto -mx-6">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-gray-500 text-xs uppercase tracking-wide">
                <th className="text-left px-6 py-2 font-medium">#</th>
                <th className="text-left px-6 py-2 font-medium">Ciudad</th>
                <th className="text-left px-6 py-2 font-medium">Depto</th>
                <th className="text-right px-6 py-2 font-medium">Env\u00edos</th>
                <th className="text-right px-6 py-2 font-medium">Entreg</th>
                <th className="text-right px-6 py-2 font-medium">Devol</th>
                <th className="text-right px-6 py-2 font-medium">% Devol</th>
                <th className="text-right px-6 py-2 font-medium">% Entreg</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((c, i) => (
                <tr key={`${c.ciudad}-${c.departamento}`} className="border-b border-gray-50 hover:bg-gray-50/50 transition">
                  <td className="px-6 py-2.5 text-gray-400 tabular-nums">{i + 1}</td>
                  <td className="px-6 py-2.5 font-medium text-gray-800">{c.ciudad}</td>
                  <td className="px-6 py-2.5 text-gray-500">{c.departamento}</td>
                  <td className="px-6 py-2.5 text-right tabular-nums">{c.total_pedidos.toLocaleString('es-CO')}</td>
                  <td className="px-6 py-2.5 text-right tabular-nums text-green-600">{c.entregados.toLocaleString('es-CO')}</td>
                  <td className="px-6 py-2.5 text-right tabular-nums text-red-600">{c.devueltos.toLocaleString('es-CO')}</td>
                  <td className="px-6 py-2.5 text-right tabular-nums">
                    <span className={`inline-flex px-1.5 py-0.5 rounded text-xs font-semibold ${
                      c.tasa_devolucion > 25 ? 'bg-red-100 text-red-700' :
                      c.tasa_devolucion > 15 ? 'bg-orange-100 text-orange-700' :
                      'bg-green-100 text-green-700'
                    }`}>
                      {c.tasa_devolucion.toFixed(1)}%
                    </span>
                  </td>
                  <td className="px-6 py-2.5 text-right tabular-nums text-gray-600">{c.tasa_entrega.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ChartCard>
  );
}

// \u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014
// Secci\u00f3n 7: Tabla — Productos con menor entrega (NUEVA)
// \u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014
function Section7Products({ data }: { data: ProductData[] }) {
  const sorted = [...data].sort((a, b) => a.tasa_entrega - b.tasa_entrega).slice(0, 15);

  return (
    <ChartCard title="Productos con menor entrega" className="overflow-hidden">
      <div className="flex items-center gap-2 mb-4 text-gray-500">
        <Package size={16} />
        <span className="text-xs">Ordenado por % de entrega (m\u00e1s bajo primero, top 15)</span>
      </div>
      {sorted.length === 0 ? (
        <EmptyChart msg="No hay datos de productos para este periodo" />
      ) : (
        <div className="overflow-x-auto -mx-6">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-gray-500 text-xs uppercase tracking-wide">
                <th className="text-left px-6 py-2 font-medium">#</th>
                <th className="text-left px-6 py-2 font-medium">Producto</th>
                <th className="text-right px-6 py-2 font-medium">Env\u00edos</th>
                <th className="text-right px-6 py-2 font-medium">Entreg</th>
                <th className="text-right px-6 py-2 font-medium">Devol</th>
                <th className="text-right px-6 py-2 font-medium">% Entreg</th>
                <th className="text-right px-6 py-2 font-medium">% Devol</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((p, i) => (
                <tr key={p.producto} className="border-b border-gray-50 hover:bg-gray-50/50 transition">
                  <td className="px-6 py-2.5 text-gray-400 tabular-nums">{i + 1}</td>
                  <td className="px-6 py-2.5 font-medium text-gray-800 max-w-[200px] truncate" title={p.producto}>{p.producto}</td>
                  <td className="px-6 py-2.5 text-right tabular-nums">{p.total_pedidos.toLocaleString('es-CO')}</td>
                  <td className="px-6 py-2.5 text-right tabular-nums text-green-600">{p.entregados.toLocaleString('es-CO')}</td>
                  <td className="px-6 py-2.5 text-right tabular-nums text-red-600">{p.devueltos.toLocaleString('es-CO')}</td>
                  <td className="px-6 py-2.5 text-right tabular-nums">
                    <span className={`inline-flex px-1.5 py-0.5 rounded text-xs font-semibold ${
                      p.tasa_entrega < 50 ? 'bg-red-100 text-red-700' :
                      p.tasa_entrega < 70 ? 'bg-orange-100 text-orange-700' :
                      'bg-green-100 text-green-700'
                    }`}>
                      {p.tasa_entrega.toFixed(1)}%
                    </span>
                  </td>
                  <td className="px-6 py-2.5 text-right tabular-nums text-gray-600">{p.tasa_devolucion.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ChartCard>
  );
}

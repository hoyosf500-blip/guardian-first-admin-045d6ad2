import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  PieChart, Pie, Cell, Tooltip as RTooltip, ResponsiveContainer,
  LineChart, Line, XAxis, YAxis, CartesianGrid, Legend,
  BarChart, Bar,
} from 'recharts';
import { supabase } from '@/integrations/supabase/client';
import { useLogisticsStats } from '@/hooks/useLogisticsStats';
import DateRangeFilter from '@/components/logistics/DateRangeFilter';
import CompactKpiGrid from '@/components/logistics/CompactKpiGrid';
import LogisticsHeroChart from '@/components/logistics/LogisticsHeroChart';
import GeoDistribution from '@/components/logistics/GeoDistribution';
import CarrierStatsTable from '@/components/logistics/CarrierStatsTable';
import CityReturnsTable from '@/components/logistics/CityReturnsTable';
import ProductFailuresTable from '@/components/logistics/ProductFailuresTable';
import TrazabilidadView from '@/components/logistics/TrazabilidadView';
import CityFilter from '@/components/logistics/CityFilter';
import CarrierCityMatrix from '@/components/logistics/CarrierCityMatrix';
import CarrierRecommendations from '@/components/logistics/CarrierRecommendations';
import ComparisonView from '@/components/logistics/ComparisonView';
import LogisticsSkeleton from '@/components/logistics/LogisticsSkeleton';
import LogisticsErrorState from '@/components/logistics/LogisticsErrorState';
import type { LogisticsFilters } from '@/lib/logistics.types';
import BilleteraTab from '@/components/logistics/BilleteraTab';
import { Truck, MapPin, Package, RefreshCw, Activity, Info, Lightbulb, GitCompare, Wallet } from 'lucide-react';

// ── Tipos del RPC `logistics_dashboard` (extra de Kimi) ────────────
interface DashboardData {
  kpis: { total: number; entregados: number; devueltos: number; en_transito: number };
  by_transportadora: { transportadora: string; total: number }[];
  by_transportadora_and_date: { fecha: string; transportadora: string; total: number }[];
  by_estado: { estado_agrupado: string; total: number }[];
  by_date_and_estado: { fecha: string; entregada: number; devolucion: number; transito: number; novedad: number; rechazada: number }[];
  by_transportadora_and_estado: { transportadora: string; entregada: number; devolucion: number; transito: number; novedad: number; rechazada: number; total: number }[];
}

// ── Paletas — tokens semánticos DS (dark/light mode automático) ────
const ESTADO_COLORS: Record<string, string> = {
  'Entregada a destino': 'hsl(var(--success))',
  'Devolucion a origen': 'hsl(var(--danger))',
  'En transito':         'hsl(var(--info))',
  'Novedad':             'hsl(var(--warning))',
  'Rechazada':           'hsl(var(--danger))',
  'En preparacion':      'hsl(var(--ai))',
  'Cancelada':           'hsl(var(--muted-foreground))',
  'Otro':                'hsl(var(--muted-foreground))',
};

const STACK_COLORS: Record<string, string> = {
  entregada:  'hsl(var(--success))',
  transito:   'hsl(var(--info))',
  novedad:    'hsl(var(--warning))',
  devolucion: 'hsl(var(--danger))',
  rechazada:  'hsl(var(--danger))',
};

const STACK_LABELS: Record<string, string> = {
  entregada:  'Entregada',
  transito:   'En tránsito',
  novedad:    'Novedad',
  devolucion: 'Devolución',
  rechazada:  'Rechazada',
};

const CARRIER_PALETTE = [
  'hsl(var(--info))',
  'hsl(var(--success))',
  'hsl(var(--warning))',
  'hsl(var(--ai))',
  'hsl(var(--accent))',
  'hsl(var(--danger))',
];
function carrierColorAt(index: number): string {
  return CARRIER_PALETTE[index % CARRIER_PALETTE.length];
}

// ── Helpers ─────────────────────────────────────────────────────
function fmtDate(s: string): string {
  const d = new Date(s);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function pct(n: number, total: number): string {
  if (!total) return '0%';
  return `${((n / total) * 100).toFixed(1)}%`;
}
function rangeKey(filters: LogisticsFilters): '7d' | '30d' | '90d' {
  const from = new Date(filters.fromDate).getTime();
  const to = new Date(filters.toDate).getTime();
  const days = Math.round((to - from) / (24 * 3600 * 1000));
  if (days <= 7) return '7d';
  if (days <= 30) return '30d';
  return '90d';
}

function useInteractiveLegend() {
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
  return { toggle, isVisible };
}

const TOOLTIP_STYLE = {
  background: 'hsl(var(--card) / 0.95)',
  border: '1px solid hsl(var(--border))',
  borderRadius: 8,
  color: 'hsl(var(--foreground))',
  fontSize: 12,
};

function ChartCard({ title, children, className = '' }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-border bg-card p-5 ${className}`}>
      <h3 className="text-sm font-bold text-foreground tracking-tight uppercase tracking-[0.06em] mb-3">
        {title}
      </h3>
      {children}
    </div>
  );
}

function EmptyChart({ msg = 'No hay datos suficientes para este periodo' }: { msg?: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-[280px] text-muted-foreground gap-2">
      <Info size={28} aria-hidden="true" />
      <p className="text-sm">{msg}</p>
    </div>
  );
}

function defaultRange(): LogisticsFilters {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 30);
  return {
    fromDate: from.toISOString().split('T')[0],
    toDate: to.toISOString().split('T')[0],
  };
}

function formatRange(filters: LogisticsFilters): string {
  const f = new Date(filters.fromDate);
  const t = new Date(filters.toDate);
  const fmt = (d: Date) => d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short' });
  return `${fmt(f)} → ${fmt(t)}`;
}

/**
 * Genera el período inmediatamente anterior al dado, con la misma duración.
 * Ej: si A = [01/04, 30/04], devuelve B = [02/03, 31/03].
 * Útil como default razonable cuando el admin activa el modo comparación.
 */
function prevPeriod(filters: LogisticsFilters): LogisticsFilters {
  const from = new Date(filters.fromDate);
  const to = new Date(filters.toDate);
  const days = Math.round((to.getTime() - from.getTime()) / (24 * 3600 * 1000));
  const newTo = new Date(from);
  newTo.setDate(newTo.getDate() - 1);
  const newFrom = new Date(newTo);
  newFrom.setDate(newFrom.getDate() - days);
  return {
    fromDate: newFrom.toISOString().split('T')[0],
    toDate: newTo.toISOString().split('T')[0],
  };
}

// ════════════════════════════════════════════════════════════════
// LogisticaTab — root
// ════════════════════════════════════════════════════════════════
export default function LogisticaTab() {
  const [filters, setFilters] = useState<LogisticsFilters>(defaultRange);

  // Modo comparación A vs B. Cuando está activo se reemplaza el body por la
  // vista lado-a-lado. Period A = filters principales, Period B se inicializa
  // con el período inmediatamente anterior (mismo número de días).
  const [compareMode, setCompareMode] = useState(false);
  const [periodB, setPeriodB] = useState<LogisticsFilters>(() => prevPeriod(defaultRange()));

  const { summary, carriers, cities, products, isLoading, isError } = useLogisticsStats(filters);

  // Query extra para los 4 gráficos nuevos (RPC `logistics_dashboard`).
  // Si el RPC no existe en DB, cae a EmptyChart y el resto sigue funcionando.
  const dashboardQuery = useQuery<DashboardData>({
    queryKey: ['logistics_dashboard', rangeKey(filters)],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('logistics_dashboard', { p_range: rangeKey(filters) });
      if (error) throw error;
      return data as unknown as DashboardData;
    },
    staleTime: 60_000,
    retry: false,
  });

  const errorMsg = useMemo(() => {
    if (summary.isError)  return summary.error?.message;
    if (carriers.isError) return carriers.error?.message;
    if (cities.isError)   return cities.error?.message;
    if (products.isError) return products.error?.message;
    return undefined;
  }, [summary, carriers, cities, products]);

  const refetchAll = () => {
    summary.refetch(); carriers.refetch(); cities.refetch(); products.refetch();
    dashboardQuery.refetch();
  };

  const lastUpdated = summary.dataUpdatedAt
    ? new Date(summary.dataUpdatedAt).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })
    : null;

  const carrierColorMap = useMemo(() => {
    const map = new Map<string, string>();
    const list = [...(dashboardQuery.data?.by_transportadora ?? [])]
      .sort((a, b) => a.transportadora.localeCompare(b.transportadora));
    list.forEach((c, i) => map.set(c.transportadora, carrierColorAt(i)));
    return map;
  }, [dashboardQuery.data?.by_transportadora]);

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          <div className="text-[11px] uppercase tracking-[0.12em] font-semibold text-muted-foreground">
            Análisis · Admin
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground leading-none">
            Logística
          </h1>
          <p className="text-sm text-muted-foreground">
            Rendimiento por transportadora, devoluciones por ciudad y productos con peor entrega.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          {!isLoading && !isError && summary.data && (
            <span className="pill pill-neutral whitespace-nowrap">
              {formatRange(filters)}
            </span>
          )}
          {/* Filtro por ciudad — Combobox con búsqueda. Si está seleccionado,
              todas las RPCs filtran por esa ciudad (usa p_ciudad). */}
          <CityFilter
            value={filters.ciudad}
            onChange={(ciudad) => setFilters((f) => ({ ...f, ciudad }))}
          />

          {/* Toggle modo comparación A vs B */}
          <button
            type="button"
            onClick={() => {
              if (!compareMode) {
                // Al activar, inicializa periodB como el período inmediatamente
                // anterior con la misma duración.
                setPeriodB(prevPeriod(filters));
              }
              setCompareMode(v => !v);
            }}
            className={`inline-flex items-center gap-1.5 h-9 rounded-lg border px-3 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${
              compareMode
                ? 'border-accent/40 bg-accent/12 text-accent ring-1 ring-accent/30'
                : 'border-border bg-card text-muted-foreground hover:bg-muted/40 hover:text-foreground'
            }`}
            aria-pressed={compareMode}
            title="Comparar dos períodos lado a lado"
          >
            <GitCompare size={13} aria-hidden="true" />
            Comparar
          </button>
          {lastUpdated && (
            <span className="text-[11px] text-muted-foreground tabular-nums hidden md:inline">
              Actualizado {lastUpdated}
            </span>
          )}
          <button
            type="button"
            onClick={refetchAll}
            disabled={isLoading}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-card transition-colors hover:border-border-strong hover:bg-muted/40 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            aria-label="Refrescar datos"
            title="Refrescar"
          >
            <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} aria-hidden="true" />
          </button>
        </div>
      </header>

      {/* Date range — solo visible cuando NO estamos en modo comparación
          (en modo comparación cada período tiene su propio picker dentro
          del ComparisonView). */}
      {!compareMode && (
        <div className="rounded-lg border border-border bg-card p-3">
          <DateRangeFilter
            value={filters}
            onChange={(next) => setFilters((f) => ({ ...next, ciudad: f.ciudad }))}
          />
        </div>
      )}

      {/* Modo comparación — vista alternativa que reemplaza hero+tabs */}
      {compareMode && (
        <ComparisonView
          periodA={filters}
          periodB={periodB}
          onPeriodAChange={(next) => setFilters((f) => ({ ...next, ciudad: f.ciudad }))}
          onPeriodBChange={setPeriodB}
        />
      )}

      {!compareMode && isError && <LogisticsErrorState message={errorMsg} onRetry={refetchAll} />}

      {!compareMode && !isError && isLoading && <LogisticsSkeleton />}

      {!compareMode && !isError && !isLoading && (
        <>
          {/* HERO ROW — chart de volumen (col-span-7) + KPIs 2×2 (col-span-5). */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
            <div className="lg:col-span-7">
              <LogisticsHeroChart rows={carriers.data ?? []} />
            </div>
            <div className="lg:col-span-5">
              <CompactKpiGrid data={summary.data ?? null} />
            </div>
          </div>

          <Tabs defaultValue="carriers" className="w-full">
            <TabsList>
              <TabsTrigger value="carriers"><Truck size={13} className="mr-1.5" /> Transportadoras</TabsTrigger>
              <TabsTrigger value="cities"><MapPin size={13} className="mr-1.5" /> Ciudades</TabsTrigger>
              <TabsTrigger value="products"><Package size={13} className="mr-1.5" /> Productos</TabsTrigger>
              <TabsTrigger value="decisiones"><Lightbulb size={13} className="mr-1.5" /> Decisiones</TabsTrigger>
              <TabsTrigger value="trazabilidad"><Activity size={13} className="mr-1.5" /> Trazabilidad</TabsTrigger>
              <TabsTrigger value="billetera"><Wallet size={13} className="mr-1.5" /> Billetera</TabsTrigger>
            </TabsList>

            <TabsContent value="carriers" className="mt-4 space-y-4">
              <CarrierStatsTable rows={carriers.data ?? []} />

              {dashboardQuery.data && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <CarrierDonut data={dashboardQuery.data.by_transportadora} colorMap={carrierColorMap} />
                  <CarrierTimeline data={dashboardQuery.data.by_transportadora_and_date} colorMap={carrierColorMap} />
                </div>
              )}

              {dashboardQuery.data && (
                <CarrierHorizontalStack data={dashboardQuery.data.by_transportadora_and_estado} />
              )}
            </TabsContent>

            <TabsContent value="cities" className="mt-4 space-y-4">
              <GeoDistribution rows={cities.data ?? []} />
              <CityReturnsTable rows={cities.data ?? []} />
            </TabsContent>

            <TabsContent value="products" className="mt-4">
              <ProductFailuresTable rows={products.data ?? []} />
            </TabsContent>

            {/* TAB: Decisiones — heatmap matriz + tabla recomendador.
                Las dos secciones leen de RPCs nuevas (logistics_by_city_carrier
                y logistics_recommendations). NO se filtran por ciudad porque
                es un análisis comparativo entre ciudades — el filtro ciudad
                no aplica acá. */}
            <TabsContent value="decisiones" className="mt-4 space-y-4">
              <CarrierRecommendations filters={filters} />
              <CarrierCityMatrix filters={filters} />
            </TabsContent>

            <TabsContent value="trazabilidad" className="mt-4 space-y-4">
              {dashboardQuery.data && (
                <EstadoDonutAndDailyStack
                  donut={dashboardQuery.data.by_estado}
                  stack={dashboardQuery.data.by_date_and_estado}
                />
              )}
              <TrazabilidadView
                summary={summary.data ?? null}
                range={filters}
                carriers={carriers.data ?? []}
              />
            </TabsContent>

            <TabsContent value="billetera" className="mt-4">
              <BilleteraTab filters={filters} />
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// Sub-componentes — gráficos extra del RPC `logistics_dashboard`
// (rescatados del trabajo de Kimi, refactor con tokens DS y unicode
// real para que funcionen en dark mode y se vean bien).
// ════════════════════════════════════════════════════════════════

function CarrierDonut({
  data,
  colorMap,
}: {
  data: DashboardData['by_transportadora'];
  colorMap: Map<string, string>;
}) {
  const total = data.reduce((s, x) => s + x.total, 0);
  const top = data[0];

  return (
    <ChartCard title="Distribución por transportadora">
      {data.length === 0 ? <EmptyChart /> : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-center">
          <div className="relative h-[260px]">
            <ResponsiveContainer>
              <PieChart>
                <Pie data={data} dataKey="total" nameKey="transportadora" innerRadius={55} outerRadius={95} paddingAngle={2}>
                  {data.map((d) => (
                    <Cell key={d.transportadora} fill={colorMap.get(d.transportadora) ?? 'hsl(var(--muted-foreground))'} />
                  ))}
                </Pie>
                <RTooltip
                  contentStyle={TOOLTIP_STYLE}
                  formatter={(v: number, n) => [`${v} (${pct(v, total)})`, n]}
                />
              </PieChart>
            </ResponsiveContainer>
            {top && (
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wide truncate max-w-[120px] text-center">
                  {top.transportadora}
                </div>
                <div className="text-2xl font-bold text-foreground tabular-nums">{pct(top.total, total)}</div>
              </div>
            )}
          </div>
          <ul className="space-y-2">
            {data.map((d) => (
              <li key={d.transportadora} className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-2 min-w-0">
                  <span
                    className="inline-block w-3 h-3 rounded-sm shrink-0"
                    style={{ background: colorMap.get(d.transportadora) }}
                    aria-hidden="true"
                  />
                  <span className="font-medium text-foreground truncate">{d.transportadora}</span>
                </span>
                <span className="text-muted-foreground tabular-nums shrink-0 ml-2">
                  {d.total} · {pct(d.total, total)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </ChartCard>
  );
}

function CarrierTimeline({
  data,
  colorMap,
}: {
  data: DashboardData['by_transportadora_and_date'];
  colorMap: Map<string, string>;
}) {
  const carriers = useMemo(() => Array.from(new Set(data.map((d) => d.transportadora))), [data]);
  const dates = useMemo(() => Array.from(new Set(data.map((d) => d.fecha))).sort(), [data]);
  const legend = useInteractiveLegend();

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
        <div className="h-[260px]">
          <ResponsiveContainer>
            <LineChart data={rows} margin={{ top: 5, right: 10, bottom: 5, left: -10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="fecha" stroke="hsl(var(--muted-foreground))" fontSize={11} />
              <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} />
              <RTooltip contentStyle={TOOLTIP_STYLE} />
              <Legend
                wrapperStyle={{ fontSize: 11, cursor: 'pointer' }}
                onClick={(e: { value: string }) => legend.toggle(e.value)}
                formatter={(value: string) => (
                  <span style={{ opacity: legend.isVisible(value) ? 1 : 0.4, color: 'hsl(var(--muted-foreground))' }}>
                    {value}
                  </span>
                )}
              />
              {legend.isVisible('TODAS') && (
                <Line type="monotone" dataKey="TODAS" stroke="hsl(var(--muted-foreground))" strokeWidth={2} strokeDasharray="5 5" dot={false} />
              )}
              {carriers.map((c) =>
                legend.isVisible(c) ? (
                  <Line
                    key={c}
                    type="monotone"
                    dataKey={c}
                    stroke={colorMap.get(c) ?? 'hsl(var(--muted-foreground))'}
                    strokeWidth={2}
                    dot={false}
                  />
                ) : null,
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </ChartCard>
  );
}

function EstadoDonutAndDailyStack({
  donut,
  stack,
}: {
  donut: DashboardData['by_estado'];
  stack: DashboardData['by_date_and_estado'];
}) {
  const total = donut.reduce((s, x) => s + x.total, 0);
  const top = donut[0];
  const stackRows = stack.map((s) => ({ ...s, fecha: fmtDate(s.fecha) }));
  const stackKeys = ['entregada', 'transito', 'novedad', 'devolucion', 'rechazada'];
  const legend = useInteractiveLegend();

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <ChartCard title="Estado global">
        {donut.length === 0 ? <EmptyChart /> : (
          <div className="relative h-[280px]">
            <ResponsiveContainer>
              <PieChart>
                <Pie data={donut} dataKey="total" nameKey="estado_agrupado" innerRadius={55} outerRadius={95} paddingAngle={2}>
                  {donut.map((d) => (
                    <Cell key={d.estado_agrupado} fill={ESTADO_COLORS[d.estado_agrupado] ?? 'hsl(var(--muted-foreground))'} />
                  ))}
                </Pie>
                <RTooltip
                  contentStyle={TOOLTIP_STYLE}
                  formatter={(v: number, n) => [`${v} (${pct(v, total)})`, n]}
                />
                <Legend wrapperStyle={{ fontSize: 10, color: 'hsl(var(--muted-foreground))' }} />
              </PieChart>
            </ResponsiveContainer>
            {top && (
              <div className="absolute inset-x-0 top-1/2 -translate-y-[60%] flex flex-col items-center pointer-events-none">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wide max-w-[140px] text-center truncate">
                  {top.estado_agrupado}
                </div>
                <div className="text-2xl font-bold text-foreground tabular-nums">{pct(top.total, total)}</div>
              </div>
            )}
          </div>
        )}
      </ChartCard>

      <ChartCard title="Estados por día">
        {stackRows.length === 0 ? <EmptyChart /> : (
          <div className="h-[280px]">
            <ResponsiveContainer>
              <BarChart data={stackRows} margin={{ top: 5, right: 10, bottom: 5, left: -10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="fecha" stroke="hsl(var(--muted-foreground))" fontSize={11} />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} />
                <RTooltip contentStyle={TOOLTIP_STYLE} />
                <Legend
                  wrapperStyle={{ fontSize: 11, cursor: 'pointer' }}
                  onClick={(e: { value: string }) => {
                    const key = Object.entries(STACK_LABELS).find(([, v]) => v === e.value)?.[0];
                    if (key) legend.toggle(key);
                  }}
                  formatter={(value: string) => {
                    const key = Object.entries(STACK_LABELS).find(([, v]) => v === value)?.[0] ?? value;
                    return (
                      <span style={{ opacity: legend.isVisible(key) ? 1 : 0.4, color: 'hsl(var(--muted-foreground))' }}>
                        {value}
                      </span>
                    );
                  }}
                />
                {stackKeys.map((key) =>
                  legend.isVisible(key) ? (
                    <Bar key={key} dataKey={key} stackId="a" fill={STACK_COLORS[key]} name={STACK_LABELS[key]} />
                  ) : null,
                )}
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </ChartCard>
    </div>
  );
}

function CarrierHorizontalStack({ data }: { data: DashboardData['by_transportadora_and_estado'] }) {
  const rows = data.map((d) => {
    const t = d.total || 1;
    return {
      transportadora: d.transportadora,
      Entregada:     +(d.entregada * 100 / t).toFixed(2),
      'En tránsito': +(d.transito * 100 / t).toFixed(2),
      Novedad:       +(d.novedad * 100 / t).toFixed(2),
      'Devolución':  +(d.devolucion * 100 / t).toFixed(2),
      Rechazada:     +(d.rechazada * 100 / t).toFixed(2),
      total: d.total,
    };
  });

  return (
    <ChartCard title="Desempeño por transportadora (% de estado)">
      {rows.length === 0 ? <EmptyChart /> : (
        <div style={{ height: Math.max(220, rows.length * 56) }}>
          <ResponsiveContainer>
            <BarChart data={rows} layout="vertical" margin={{ top: 5, right: 20, bottom: 5, left: 20 }} stackOffset="expand">
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis
                type="number"
                domain={[0, 100]}
                stroke="hsl(var(--muted-foreground))"
                fontSize={11}
                tickFormatter={(v) => `${v}%`}
              />
              <YAxis
                type="category"
                dataKey="transportadora"
                stroke="hsl(var(--foreground))"
                fontSize={12}
                width={130}
              />
              <RTooltip
                contentStyle={TOOLTIP_STYLE}
                formatter={(v: number, n: string, props: { payload?: { total?: number } }) => {
                  const total = props?.payload?.total ?? 0;
                  return [`${v.toFixed(1)}% (${Math.round(v * total / 100)} ped)`, n];
                }}
              />
              <Legend wrapperStyle={{ fontSize: 11, color: 'hsl(var(--muted-foreground))' }} />
              <Bar dataKey="Entregada"     stackId="b" fill="hsl(var(--success))" />
              <Bar dataKey="En tránsito"   stackId="b" fill="hsl(var(--info))" />
              <Bar dataKey="Novedad"       stackId="b" fill="hsl(var(--warning))" />
              <Bar dataKey="Devolución"    stackId="b" fill="hsl(var(--danger))" />
              <Bar dataKey="Rechazada"     stackId="b" fill="hsl(var(--danger))" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </ChartCard>
  );
}

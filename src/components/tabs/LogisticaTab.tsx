import { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useActiveStoreId } from '@/contexts/StoreContext';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useSessionState } from '@/hooks/useSessionState';
import {
  PieChart, Pie, Cell, Tooltip as RTooltip, ResponsiveContainer,
  LineChart, Line, XAxis, YAxis, CartesianGrid, Legend,
  BarChart, Bar,
} from 'recharts';
import { supabase } from '@/integrations/supabase/client';
import { useLogisticsStats } from '@/hooks/useLogisticsStats';
import DateRangeFilter from '@/components/logistics/DateRangeFilter';
import LogisticsHeroChart from '@/components/logistics/LogisticsHeroChart';
import GeoDistribution from '@/components/logistics/GeoDistribution';
import CarrierStatsTable from '@/components/logistics/CarrierStatsTable';
import CityReturnsTable from '@/components/logistics/CityReturnsTable';
import ProductFailuresTable from '@/components/logistics/ProductFailuresTable';
import ProductProfitabilityTable from '@/components/logistics/ProductProfitabilityTable';
import TrazabilidadView from '@/components/logistics/TrazabilidadView';
import CityFilter from '@/components/logistics/CityFilter';
import CarrierCityMatrix from '@/components/logistics/CarrierCityMatrix';
import CarrierRecommendations from '@/components/logistics/CarrierRecommendations';
import ComparisonView from '@/components/logistics/ComparisonView';
import LogisticsSkeleton from '@/components/logistics/LogisticsSkeleton';
import LogisticsErrorState from '@/components/logistics/LogisticsErrorState';
import type { LogisticsFilters } from '@/lib/logistics.types';
import BilleteraTab from '@/components/logistics/BilleteraTab';
import FinanzasTab from '@/components/logistics/FinanzasTab';
import MesActualResumen from '@/components/logistics/MesActualResumen';
import StoreAdSpendPanel from '@/components/logistics/StoreAdSpendPanel';
import {
  CHART_TOOLTIP_STYLE,
  CHART_GRID_PROPS,
  CHART_BAR_CURSOR,
} from '@/components/logistics/charts/chartTokens';
import { Truck, MapPin, Package, RefreshCw, Activity, Info, Lightbulb, GitCompare, LayoutDashboard, DollarSign, Wallet, Coins } from 'lucide-react';

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
  const d = parseLocalDate(s); // no new Date('YYYY-MM-DD'): eso es UTC y corre el label -1 día en Bogotá
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

// TOOLTIP_STYLE consolidado en chartTokens.ts (importado arriba como
// CHART_TOOLTIP_STYLE). Mantenemos esta const local como alias para no
// tener que renombrar todas las invocaciones en este archivo.
const TOOLTIP_STYLE = CHART_TOOLTIP_STYLE;

function ChartCard({ title, children, className = '' }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`card-elevated p-5 ${className}`}>
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

// Audit fix: usar componentes LOCALES en vez de toISOString().split('T')[0].
// Antes en Colombia (UTC-5), después de las 19:00 hora local, la conversión
// a UTC adelantaba la fecha un día — el rango por defecto era del día siguiente.
const pad2 = (n: number) => String(n).padStart(2, '0');
const localISODate = (d: Date) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

// Default = MES CALENDARIO ACTUAL (1ro → hoy), no 30d rolling. El dueño quiere
// abrir en "cómo voy este mes" y que los KPIs coincidan con la vista mensual de
// Dropi (el rolling 30d mostraba 253 vs los 181 del mes en Dropi → confundía).
// Los presets 7d/30d/90d/Histórico siguen disponibles para ampliar.
function defaultRange(): LogisticsFilters {
  const to = new Date();
  const from = new Date(to.getFullYear(), to.getMonth(), 1);
  return {
    fromDate: localISODate(from),
    toDate: localISODate(to),
  };
}

// new Date('YYYY-MM-DD') interpreta el string como MEDIANOCHE UTC; al renderizar
// en Bogotá (UTC-5) el label retrocedía un día ("01/06→30/06" se pintaba
// "31 may → 29 jun"). Parsear siempre con componentes locales.
function parseLocalDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

function formatRange(filters: LogisticsFilters): string {
  const f = parseLocalDate(filters.fromDate);
  const t = parseLocalDate(filters.toDate);
  const fmt = (d: Date) => d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short' });
  return `${fmt(f)} → ${fmt(t)}`;
}

/**
 * Genera el período inmediatamente anterior al dado, con la misma duración.
 * Ej: si A = [01/04, 30/04], devuelve B = [02/03, 31/03].
 * Útil como default razonable cuando el admin activa el modo comparación.
 */
function prevPeriod(filters: LogisticsFilters): LogisticsFilters {
  const from = parseLocalDate(filters.fromDate);
  const to = parseLocalDate(filters.toDate);
  const days = Math.round((to.getTime() - from.getTime()) / (24 * 3600 * 1000));
  const newTo = new Date(from);
  newTo.setDate(newTo.getDate() - 1);
  const newFrom = new Date(newTo);
  newFrom.setDate(newFrom.getDate() - days);
  return {
    fromDate: localISODate(newFrom),
    toDate: localISODate(newTo),
  };
}

// ════════════════════════════════════════════════════════════════
// LogisticaTab — root
// ════════════════════════════════════════════════════════════════
export default function LogisticaTab() {
  const [filters, setFilters] = useState<LogisticsFilters>(defaultRange);

  // Tab activa — persiste en sessionStorage para que F5 / cambio de tab del
  // navegador no resetee al usuario al "Resumen". Default: 'resumen' (KPIs +
  // gráfico de volumen, lo que el usuario ve al entrar por primera vez).
  const [activeTab, setActiveTab] = useSessionState<string>('logistica:tab', 'resumen');

  // Modo comparación A vs B. Cuando está activo se reemplaza el body por la
  // vista lado-a-lado. Period A = filters principales, Period B se inicializa
  // con el período inmediatamente anterior (mismo número de días).
  const [compareMode, setCompareMode] = useState(false);
  const [periodB, setPeriodB] = useState<LogisticsFilters>(() => prevPeriod(defaultRange()));

  const { summary, carriers, cities, products, isLoading, isError } = useLogisticsStats(filters);
  const activeStoreId = useActiveStoreId();
  const queryClient = useQueryClient();

  // Query extra para los 4 gráficos nuevos (RPC `logistics_dashboard`).
  // Si el RPC no existe en DB, cae a EmptyChart y el resto sigue funcionando.
  // storeId en la key: la RPC resuelve la tienda server-side (auditoría 2026-07-07).
  const dashboardQuery = useQuery<DashboardData>({
    queryKey: ['logistics_dashboard', activeStoreId ?? 'none', rangeKey(filters)],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('logistics_dashboard', { p_range: rangeKey(filters) });
      if (error) throw error;
      return data as unknown as DashboardData;
    },
    staleTime: 60_000,
    retry: false,
    enabled: Boolean(activeStoreId),
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
    // El botón decía "Refrescar" pero solo cubría 5 queries: en Finanzas /
    // Decisiones / Billetera el timestamp mentía sobre la frescura de la plata
    // (auditoría 2026-07-07). Invalidar por prefijo cubre el resto sin acoplar
    // este componente a cada hook.
    for (const key of [
      'financial-summary', 'ganancia-neta-dropi', 'operativo-cohorte',
      'orders-estado-breakdown', 'wallet_movements', 'wallet_saldo_hoy',
      'wallet_daily_series', 'wallet_sync_health', 'logistics-city-carrier-matrix',
      'logistics-cost-basis', 'product-profitability',
    ]) {
      void queryClient.invalidateQueries({ queryKey: [key] });
    }
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
        // ── Tabs arriba, contenido full-width abajo ─────────────────────
        // El header + filtros quedan ARRIBA (fuera del Tabs).
        // El bloque hero (KPIs + bar chart de volumen) se movió a la tab
        // "Resumen" para no desperdiciar espacio en las otras tabs.
        // TabsList horizontalmente scrollable en mobile (overflow-x-auto +
        // whitespace-nowrap en TabsList override + flex shrink-0 en cada
        // trigger). En desktop hace wrap y ocupa todo el ancho disponible.
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <div className="overflow-x-auto -mx-1 px-1">
            <TabsList
              className="inline-flex w-full justify-start gap-0.5 h-auto p-1"
              aria-label="Secciones de logística"
            >
              <TabsTrigger value="resumen" className="shrink-0"><LayoutDashboard size={13} className="mr-1.5" /> Resumen</TabsTrigger>
              <TabsTrigger value="carriers" className="shrink-0"><Truck size={13} className="mr-1.5" /> Transportadoras</TabsTrigger>
              <TabsTrigger value="cities" className="shrink-0"><MapPin size={13} className="mr-1.5" /> Ciudades</TabsTrigger>
              <TabsTrigger value="products" className="shrink-0"><Package size={13} className="mr-1.5" /> Productos</TabsTrigger>
              <TabsTrigger value="decisiones" className="shrink-0"><Lightbulb size={13} className="mr-1.5" /> Decisiones</TabsTrigger>
              <TabsTrigger value="trazabilidad" className="shrink-0"><Activity size={13} className="mr-1.5" /> Trazabilidad</TabsTrigger>
              <TabsTrigger value="finanzas" className="shrink-0"><DollarSign size={13} className="mr-1.5" /> Finanzas</TabsTrigger>
            </TabsList>
          </div>

          {/* TAB: Resumen — vista por defecto. KPIs globales + volumen por
              transportadora. Antes vivían fuera del sistema de tabs y se
              renderizaban siempre (espacio muerto en las otras tabs). */}
          <TabsContent value="resumen" className="mt-4 space-y-4">
            {/* "Cómo voy este mes": tiles Dropi-parity + embudo por estado (sin
                huecos) + conciliación (realizado vs pendiente vs perdido + wallet
                real). Reemplaza al CompactKpiGrid (sus KPIs quedan cubiertos). */}
            <MesActualResumen summary={summary.data ?? null} filters={filters} />

            {/* Pauta diaria por tienda — se resta de la Ganancia Neta de arriba. */}
            <StoreAdSpendPanel filters={filters} />

            {/* Composición por transportadora (complementa los tiles de arriba). */}
            <LogisticsHeroChart rows={carriers.data ?? []} />
          </TabsContent>

          <TabsContent value="carriers" className="mt-4 space-y-4">
            <CarrierStatsTable rows={carriers.data ?? []} />

            {/* Antes un error del RPC (retry:false) hacía DESAPARECER los charts
                en silencio — parecía "no hay datos" (auditoría 2026-07-07). */}
            {dashboardQuery.isError && (
              <div className="rounded-xl border border-warning/40 bg-warning/5 p-4 text-xs text-muted-foreground">
                No se pudieron cargar los gráficos de transportadoras — usá el botón Refrescar.
              </div>
            )}

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

          {/* TAB: Productos — solo tasa de entrega/falla por SKU. La
              rentabilidad por SKU se movió a la tab "Finanzas" porque es
              análisis de plata. */}
          <TabsContent value="products" className="mt-4 space-y-4">
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
            {dashboardQuery.isError && (
              <div className="rounded-xl border border-warning/40 bg-warning/5 p-4 text-xs text-muted-foreground">
                No se pudieron cargar los gráficos de estados — usá el botón Refrescar.
              </div>
            )}
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

          {/* TAB: Finanzas — vista unificada de TODA la plata operativa de
              la logística en una sola pantalla. Apila 3 secciones que antes
              eran tabs separadas (Finanzas / Billetera / Rentabilidad):
                1. Resumen financiero  → utilidad bruta + cash flow + composición
                2. Billetera Dropi     → KPIs + serie diaria + tabla movimientos
                3. Rentabilidad SKU    → ingresos − costos por producto

              El análisis "cómo voy" del dueño (P&L mensual + ROAS + alertas)
              vive en /cfo, no acá. /logistica = datos crudos de la operación. */}
          <TabsContent value="finanzas" className="mt-4 space-y-6">
            <section>
              <header className="flex items-center gap-2 mb-3">
                <DollarSign size={14} className="text-accent" />
                <h2 className="text-sm font-bold tracking-tight uppercase tracking-[0.06em]">
                  Resumen financiero
                </h2>
              </header>
              <FinanzasTab filters={filters} />
            </section>

            <section>
              <header className="flex items-center gap-2 mb-3">
                <Wallet size={14} className="text-accent" />
                <h2 className="text-sm font-bold tracking-tight uppercase tracking-[0.06em]">
                  Billetera Dropi
                </h2>
              </header>
              <BilleteraTab filters={filters} />
            </section>

            <section>
              <header className="flex items-center gap-2 mb-3">
                <Coins size={14} className="text-accent" />
                <h2 className="text-sm font-bold tracking-tight uppercase tracking-[0.06em]">
                  Rentabilidad por producto
                </h2>
              </header>
              <ProductProfitabilityTable filters={filters} />
            </section>
          </TabsContent>
        </Tabs>
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
                {/* innerRadius más grande (60 vs 55) + outerRadius (100 vs 95)
                    = anillo más grueso y legible. paddingAngle 3 separa
                    slices mejor cuando hay muchos carriers. */}
                <Pie data={data} dataKey="total" nameKey="transportadora"
                     innerRadius={60} outerRadius={100} paddingAngle={3}
                     stroke="hsl(var(--card))" strokeWidth={2}>
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
                <div className="text-3xl font-extrabold text-foreground tabular-nums leading-none">
                  {pct(top.total, total)}
                </div>
                <div className="text-[10px] text-muted-foreground uppercase tracking-[0.1em] font-semibold mt-1.5 truncate max-w-[140px] text-center">
                  {top.transportadora}
                </div>
              </div>
            )}
          </div>
          <ul className="space-y-2">
            {data.map((d) => (
              <li key={d.transportadora} className="flex items-center justify-between text-xs gap-2">
                <span className="flex items-center gap-2 min-w-0">
                  <span
                    className="h-2.5 w-2.5 rounded-full shrink-0"
                    style={{ background: colorMap.get(d.transportadora), boxShadow: `0 0 0 3px ${colorMap.get(d.transportadora)}22` }}
                    aria-hidden="true"
                  />
                  <span className="font-medium text-foreground truncate">{d.transportadora}</span>
                </span>
                <span className="tabular-nums shrink-0 ml-2 flex items-baseline gap-2">
                  <span className="text-muted-foreground">{d.total}</span>
                  <span className="font-bold text-foreground w-12 text-right">{pct(d.total, total)}</span>
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
            <LineChart data={rows} margin={{ top: 8, right: 10, bottom: 5, left: -10 }}>
              <CartesianGrid {...CHART_GRID_PROPS} />
              <XAxis dataKey="fecha" stroke="hsl(var(--muted-foreground))" fontSize={10} tickLine={false} axisLine={{ stroke: 'hsl(var(--border))' }} />
              <YAxis stroke="hsl(var(--muted-foreground))" fontSize={10} tickLine={false} axisLine={false} width={36} />
              <RTooltip contentStyle={TOOLTIP_STYLE} />
              <Legend
                wrapperStyle={{ fontSize: 11, cursor: 'pointer', paddingTop: 8 }}
                iconType="circle"
                iconSize={8}
                onClick={(e: { value: string }) => legend.toggle(e.value)}
                formatter={(value: string) => (
                  <span style={{ opacity: legend.isVisible(value) ? 1 : 0.4, color: 'hsl(var(--muted-foreground))' }}>
                    {value}
                  </span>
                )}
              />
              {legend.isVisible('TODAS') && (
                <Line type="monotone" dataKey="TODAS" stroke="hsl(var(--muted-foreground))" strokeWidth={2} strokeDasharray="5 5" dot={false} activeDot={{ r: 4 }} />
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
                    activeDot={{ r: 4, strokeWidth: 0 }}
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
                <Pie data={donut} dataKey="total" nameKey="estado_agrupado"
                     innerRadius={62} outerRadius={102} paddingAngle={3}
                     stroke="hsl(var(--card))" strokeWidth={2}>
                  {donut.map((d) => (
                    <Cell key={d.estado_agrupado} fill={ESTADO_COLORS[d.estado_agrupado] ?? 'hsl(var(--muted-foreground))'} />
                  ))}
                </Pie>
                <RTooltip
                  contentStyle={TOOLTIP_STYLE}
                  formatter={(v: number, n) => [`${v} (${pct(v, total)})`, n]}
                />
                <Legend wrapperStyle={{ fontSize: 10, color: 'hsl(var(--muted-foreground))', paddingTop: 8 }}
                        iconType="circle" iconSize={8} />
              </PieChart>
            </ResponsiveContainer>
            {top && (
              <div className="absolute inset-x-0 top-1/2 -translate-y-[60%] flex flex-col items-center pointer-events-none">
                <div className="text-3xl font-extrabold text-foreground tabular-nums leading-none">
                  {pct(top.total, total)}
                </div>
                <div className="text-[10px] text-muted-foreground uppercase tracking-[0.1em] font-semibold mt-1.5 max-w-[140px] text-center truncate">
                  {top.estado_agrupado}
                </div>
              </div>
            )}
          </div>
        )}
      </ChartCard>

      <ChartCard title="Estados por día de creación">
        {stackRows.length === 0 ? <EmptyChart /> : (
          <div className="h-[280px]">
            <ResponsiveContainer>
              <BarChart data={stackRows} margin={{ top: 8, right: 10, bottom: 5, left: -10 }}>
                <CartesianGrid {...CHART_GRID_PROPS} />
                <XAxis dataKey="fecha" stroke="hsl(var(--muted-foreground))" fontSize={10} tickLine={false} axisLine={{ stroke: 'hsl(var(--border))' }} />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={10} tickLine={false} axisLine={false} width={36} />
                <RTooltip contentStyle={TOOLTIP_STYLE} cursor={CHART_BAR_CURSOR} />
                <Legend
                  wrapperStyle={{ fontSize: 11, cursor: 'pointer', paddingTop: 8 }}
                  iconType="circle"
                  iconSize={8}
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
                {stackKeys.map((key, i) =>
                  legend.isVisible(key) ? (
                    <Bar
                      key={key}
                      dataKey={key}
                      stackId="a"
                      fill={STACK_COLORS[key]}
                      name={STACK_LABELS[key]}
                      // Última barra visible recibe radius arriba — efecto pill cleán.
                      radius={i === stackKeys.length - 1 ? [4, 4, 0, 0] : 0}
                    />
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
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border) / 0.5)" horizontal={false} />
              <XAxis
                type="number"
                domain={[0, 100]}
                stroke="hsl(var(--muted-foreground))"
                fontSize={10}
                tickLine={false}
                axisLine={{ stroke: 'hsl(var(--border))' }}
                tickFormatter={(v) => `${v}%`}
              />
              <YAxis
                type="category"
                dataKey="transportadora"
                stroke="hsl(var(--foreground))"
                fontSize={12}
                tickLine={false}
                axisLine={false}
                width={130}
              />
              <RTooltip
                contentStyle={TOOLTIP_STYLE}
                cursor={CHART_BAR_CURSOR}
                formatter={(v: number, n: string, props: { payload?: { total?: number } }) => {
                  const total = props?.payload?.total ?? 0;
                  return [`${v.toFixed(1)}% (${Math.round(v * total / 100)} ped)`, n];
                }}
              />
              <Legend wrapperStyle={{ fontSize: 11, color: 'hsl(var(--muted-foreground))', paddingTop: 8 }}
                      iconType="circle" iconSize={8} />
              <Bar dataKey="Entregada"     stackId="b" fill="hsl(var(--success))" />
              <Bar dataKey="En tránsito"   stackId="b" fill="hsl(var(--info))" />
              <Bar dataKey="Novedad"       stackId="b" fill="hsl(var(--warning))" />
              <Bar dataKey="Devolución"    stackId="b" fill="hsl(var(--danger))" />
              <Bar dataKey="Rechazada"     stackId="b" fill="hsl(var(--danger))" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </ChartCard>
  );
}

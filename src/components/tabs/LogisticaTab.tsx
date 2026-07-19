import { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useActiveStoreId } from '@/contexts/StoreContext';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useSessionState } from '@/hooks/useSessionState';
import {
  PieChart, Pie, Cell, Tooltip as RTooltip, ResponsiveContainer,
  ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Legend,
  BarChart, Bar,
} from 'recharts';
import { motion } from 'framer-motion';
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
import SemaforoSalud from '@/components/logistics/SemaforoSalud';
import {
  CHART_TOOLTIP_STYLE,
  CHART_GRID_PROPS,
  CHART_BAR_CURSOR,
  CHART_LINE_CURSOR,
} from '@/components/logistics/charts/chartTokens';
import { AuroraBackdrop } from '@/components/ui3d';
import { Truck, MapPin, Package, RefreshCw, Activity, Info, Lightbulb, GitCompare, LayoutDashboard, DollarSign, Wallet, Coins, PieChart as PieChartIcon, LineChart as LineChartIcon, BarChart3, Layers } from 'lucide-react';

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
// `Rechazada` va con el MISMO token que devolución pero al 60% — es el alpha que
// ya usa TONE_BAR.rechazado en MesActualResumen para este mismo estado. Antes
// ambas series se pintaban con el danger pleno: en la pila de 5 series quedaban
// indistinguibles y la barra mentía sobre su composición.
const ESTADO_COLORS: Record<string, string> = {
  'Entregada a destino': 'hsl(var(--success))',
  'Devolucion a origen': 'hsl(var(--danger))',
  'En transito':         'hsl(var(--info))',
  'Novedad':             'hsl(var(--warning))',
  'Rechazada':           'hsl(var(--danger) / 0.6)',
  'En preparacion':      'hsl(var(--ai))',
  'Cancelada':           'hsl(var(--muted-foreground))',
  'Otro':                'hsl(var(--muted-foreground))',
};

const STACK_COLORS: Record<string, string> = {
  entregada:  'hsl(var(--success))',
  transito:   'hsl(var(--info))',
  novedad:    'hsl(var(--warning))',
  devolucion: 'hsl(var(--danger))',
  rechazada:  'hsl(var(--danger) / 0.6)',
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
/** `hsl(var(--x))` → `hsl(var(--x) / 0.13)` para el aro suave del dot.
 *  El idiom `${color}22` sólo funciona con hex de 6 dígitos: sobre un
 *  string `hsl(...)` generaba CSS inválido y el boxShadow no se pintaba
 *  (ni en dark ni en light). */
function carrierRing(color: string | undefined, alpha = 0.13): string | undefined {
  return color ? color.replace(/\)$/, ` / ${alpha})`) : undefined;
}

// ── Lenguaje visual del Dashboard ───────────────────────────────
// Mismos tokens que DashboardTab: todo color de gráfico sale de una var HSL,
// así dark/light cambian solos y nadie hardcodea un hex.
const hsl = (v: string) => `hsl(var(${v}))`;
const CHART_ACCENT = hsl('--accent');
const CHART_CYAN   = hsl('--cyan');
const CHART_BG     = hsl('--background');

/** Glow del trazo: 8px para líneas/áreas, 6px para barras. Es la firma del DS. */
const lineGlow = (color: string) => ({ filter: `drop-shadow(0 0 8px ${color})` });
const barGlow  = (color: string) => ({ filter: `drop-shadow(0 0 6px ${color})` });

/** Entrada escalonada: la pantalla se arma de arriba abajo. */
const fadeUp = (delay = 0) => ({
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35, delay, ease: 'easeOut' as const },
});

/**
 * Degradado vertical para una barra (pleno arriba → apagado en la base).
 * Los ids de <defs> son GLOBALES al documento: si dos charts de esta pantalla
 * usan el mismo id, el segundo pisa al primero y las barras se pintan con el
 * degradado equivocado. De ahí el `prefix` obligatorio.
 */
function BarGradientDefs({ prefix, entries }: { prefix: string; entries: { key: string; color: string }[] }) {
  return (
    <defs>
      {entries.map(e => (
        <linearGradient key={e.key} id={`${prefix}-${e.key}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={e.color} stopOpacity={0.95} />
          <stop offset="100%" stopColor={e.color} stopOpacity={0.5} />
        </linearGradient>
      ))}
    </defs>
  );
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
// `rangeKey` se eliminó el 2026-07-18. Convertía un rango de fechas en un
// bucket ('7d'|'30d'|'90d') para `logistics_dashboard`, y ese bucket era el bug:
// junio y mayo colapsaban al mismo valor, así que el server devolvía una ventana
// rodante desde hoy y cambiar de mes no refetcheaba. No se reintroduce: si algo
// necesita agrupar por duración, que lo haga sin perder las fechas.

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

// Pastilla de sub-tab (patrón del handoff 3D): activa = acento + glow,
// inactiva = superficie translúcida con borde que sube en hover.
const TAB_PILL = [
  'shrink-0 px-4 py-2 rounded-xl text-sm font-medium transition-colors',
  'bg-card/40 border border-border text-muted-foreground',
  'hover:text-foreground hover:border-border-strong',
  'data-[state=active]:bg-accent/16 data-[state=active]:border-accent/40',
  'data-[state=active]:text-accent data-[state=active]:font-semibold',
  'data-[state=active]:shadow-glow3d',
].join(' ');

/**
 * Shell de card de gráfico, con la anatomía del Dashboard: ícono teñido +
 * título semibold a la izquierda, leyenda/nota a la derecha, gráfico abajo.
 */
function ChartCard({
  title, icon: Icon, iconClass = 'text-accent', right, children, className = '',
}: {
  title: string;
  icon: typeof Truck;
  iconClass?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    // Sin TiltCard a propósito: TiltCard aplica overflow-hidden y los tooltips
    // de recharts se recortarían contra el borde de la card.
    // h-full flex flex-col: lo traía la card vieja y se había perdido — sin eso
    // dos cards lado a lado en la misma fila del grid dejan de igualar alto.
    <div className={`hairline-top bg-card/40 border border-border rounded-2xl p-5 shadow-card3d transition-colors duration-200 hover:border-border-strong h-full flex flex-col ${className}`}>
      <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Icon size={14} className={iconClass} aria-hidden="true" />
          {title}
        </h3>
        {right}
      </div>
      {children}
    </div>
  );
}

/** Leyenda manual: swatch cuadrado de 10px (nunca círculos) + rótulo. */
function SwatchLegend({
  items, className = '',
}: {
  items: { color: string; label: string }[];
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-3 flex-wrap ${className}`}>
      {items.map(l => (
        <span key={l.label} className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: l.color }} aria-hidden="true" />
          {l.label}
        </span>
      ))}
    </div>
  );
}

/**
 * Aviso de que los gráficos del RPC no cargaron. Molde de banner del Dashboard:
 * barra lateral de color pleno + chip de ícono con glow. El texto NO cambia —
 * lo único que cambia es que ahora se ve como aviso y no como una caja más.
 */
function ChartsErrorBanner({ text }: { text: string }) {
  return (
    <div className="relative flex flex-col sm:flex-row sm:items-center gap-3 rounded-2xl border border-warning/30 bg-warning/10 px-4 pl-5 py-3 shadow-card3d">
      <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-warning" aria-hidden="true" />
      <div className="w-9 h-9 rounded-xl bg-warning/20 glow-warning flex items-center justify-center flex-shrink-0 text-warning">
        <Info size={17} aria-hidden="true" />
      </div>
      <div className="flex-1 min-w-0 text-xs font-semibold text-warning">{text}</div>
    </div>
  );
}

function EmptyChart({ msg = 'No hay datos suficientes para este periodo' }: { msg?: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-[280px] text-muted-foreground gap-3">
      <span className="w-9 h-9 rounded-xl border border-border bg-muted/60 flex items-center justify-center" aria-hidden="true">
        <Info size={17} />
      </span>
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
  //
  // FECHAS REALES (2026-07-18). Antes acá iba `rangeKey(filters)`, que tiraba
  // las fechas y mandaba solo la DURACIÓN ('7d'|'30d'|'90d'); la RPC la traducía
  // a `NOW() - INTERVAL`, o sea una ventana rodante pegada a hoy. Elegir junio
  // mostraba los últimos 30 días con el encabezado diciendo junio. Y como la
  // queryKey también usaba el bucket, junio y mayo eran la MISMA key: cambiar
  // de mes ni siquiera refetcheaba. Ahora van las fechas literales, así que la
  // key cambia con el filtro y el server recibe el rango que el usuario pidió.
  // La ciudad también viaja: antes este era el único bloque de /logistica que
  // ignoraba ese filtro.
  const dashboardQuery = useQuery<DashboardData>({
    queryKey: ['logistics_dashboard', activeStoreId ?? 'none', filters.fromDate, filters.toDate, filters.ciudad ?? ''],
    queryFn: async () => {
      // `.bind` no es opcional: guardar `supabase.rpc` en una variable suelta le
      // saca el `this` y revienta con "Cannot read properties of undefined".
      const rpcDashboard = supabase.rpc.bind(supabase) as unknown as (
        fn: 'logistics_dashboard',
        args: { p_from_date: string; p_to_date: string; p_ciudad: string | null },
      ) => Promise<{ data: unknown; error: { message: string } | null }>;
      const { data, error } = await rpcDashboard('logistics_dashboard', {
        p_from_date: filters.fromDate,
        p_to_date: filters.toDate,
        p_ciudad: filters.ciudad ?? null,
      });
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
    <div className="space-y-5">
      {/* Cabecera-hero: el fondo aurora la separa del contenido y le da el mismo
          peso de apertura que la card hero del Dashboard. Sin sheen ni brackets:
          esos son la firma de UNA sola card por pantalla y acá los lleva
          "Cómo voy" (MesActualResumen), que es la protagonista real. */}
      <motion.header
        {...fadeUp(0)}
        className="relative overflow-hidden rounded-3xl border border-border bg-card/40 p-5 shadow-card3d-lg hairline-top flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"
      >
        <AuroraBackdrop />
        <div className="relative min-w-0 space-y-1.5">
          <div className="hud-label mb-1 whitespace-nowrap truncate">
            Análisis · Admin
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-3">
            <span className="w-11 h-11 rounded-2xl bg-info/14 border border-info/30 text-info glow-info flex items-center justify-center shrink-0" aria-hidden="true">
              <Truck size={20} strokeWidth={2.25} />
            </span>
            Logística
          </h1>
          <p className="text-sm text-muted-foreground">
            Rendimiento por transportadora, devoluciones por ciudad y productos con peor entrega.
          </p>
        </div>

        <div className="relative flex items-center gap-2 shrink-0 flex-wrap">
          {!isLoading && !isError && summary.data && (
            <span className="inline-flex items-center px-2.5 py-1 rounded-lg text-[11px] font-semibold font-mono tabular-nums bg-card/40 border border-border text-muted-foreground whitespace-nowrap">
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
            className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${
              compareMode
                ? 'bg-accent/16 border-accent/40 text-accent font-semibold shadow-glow3d'
                : 'bg-card/40 border-border text-muted-foreground hover:text-foreground hover:border-border-strong'
            }`}
            aria-pressed={compareMode}
            title="Comparar dos períodos lado a lado"
          >
            <GitCompare size={13} aria-hidden="true" />
            Comparar
          </button>
          {lastUpdated && (
            <span className="text-[11px] text-muted-foreground font-mono tabular-nums hidden md:inline">
              Actualizado {lastUpdated}
            </span>
          )}
          <button
            type="button"
            onClick={refetchAll}
            disabled={isLoading}
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-card/40 text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            aria-label="Refrescar datos"
            title="Refrescar"
          >
            <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} aria-hidden="true" />
          </button>
        </div>
      </motion.header>

      {/* Date range — solo visible cuando NO estamos en modo comparación
          (en modo comparación cada período tiene su propio picker dentro
          del ComparisonView). */}
      {!compareMode && (
        <motion.div {...fadeUp(0.05)} className="rounded-2xl border border-border bg-card/40 p-3 shadow-card3d hairline-top">
          <DateRangeFilter
            value={filters}
            onChange={(next) => setFilters((f) => ({ ...next, ciudad: f.ciudad }))}
          />
        </motion.div>
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
        <motion.div {...fadeUp(0.1)}>
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <div className="overflow-x-auto -mx-1 px-1">
            <TabsList
              className="inline-flex w-full flex-wrap justify-start gap-2 h-auto p-0 bg-transparent"
              aria-label="Secciones de logística"
            >
              <TabsTrigger value="resumen" className={TAB_PILL}><LayoutDashboard size={13} className="mr-1.5" /> Resumen</TabsTrigger>
              <TabsTrigger value="carriers" className={TAB_PILL}><Truck size={13} className="mr-1.5" /> Transportadoras</TabsTrigger>
              <TabsTrigger value="cities" className={TAB_PILL}><MapPin size={13} className="mr-1.5" /> Ciudades</TabsTrigger>
              <TabsTrigger value="products" className={TAB_PILL}><Package size={13} className="mr-1.5" /> Productos</TabsTrigger>
              <TabsTrigger value="decisiones" className={TAB_PILL}><Lightbulb size={13} className="mr-1.5" /> Decisiones</TabsTrigger>
              <TabsTrigger value="trazabilidad" className={TAB_PILL}><Activity size={13} className="mr-1.5" /> Trazabilidad</TabsTrigger>
              <TabsTrigger value="finanzas" className={TAB_PILL}><DollarSign size={13} className="mr-1.5" /> Finanzas</TabsTrigger>
            </TabsList>
          </div>

          {/* TAB: Resumen — vista por defecto. KPIs globales + volumen por
              transportadora. Antes vivían fuera del sistema de tabs y se
              renderizaban siempre (espacio muerto en las otras tabs). */}
          {/* Cascada de entrada: cada bloque entra 30-60ms después del anterior,
              así la pestaña "se arma" de arriba abajo en vez de aparecer de golpe.
              Los delays son los mismos del Dashboard. */}
          <TabsContent value="resumen" className="mt-4 space-y-5">
            {/* "Cómo voy este mes": tiles Dropi-parity + embudo por estado (sin
                huecos) + conciliación (realizado vs pendiente vs perdido + wallet
                real). Es la card protagonista de la pantalla. */}
            <motion.div {...fadeUp(0.12)}>
              <MesActualResumen summary={summary.data ?? null} filters={filters} />
            </motion.div>

            {/* Semáforo de salud financiera (estándares de mercado, estilo Wintrack). */}
            <motion.div {...fadeUp(0.15)}>
              <SemaforoSalud from={filters.fromDate} to={filters.toDate} />
            </motion.div>

            {/* Pauta diaria por tienda — se resta de la Ganancia Neta de arriba. */}
            <motion.div {...fadeUp(0.18)}>
              <StoreAdSpendPanel filters={filters} />
            </motion.div>

            {/* Composición por transportadora (complementa los tiles de arriba). */}
            <motion.div {...fadeUp(0.24)}>
              <LogisticsHeroChart rows={carriers.data ?? []} />
            </motion.div>
          </TabsContent>

          <TabsContent value="carriers" className="mt-4 space-y-5">
            <motion.div {...fadeUp(0.05)}>
              <CarrierStatsTable rows={carriers.data ?? []} />
            </motion.div>

            {/* Antes un error del RPC (retry:false) hacía DESAPARECER los charts
                en silencio — parecía "no hay datos" (auditoría 2026-07-07). */}
            {dashboardQuery.isError && (
              <ChartsErrorBanner text="No se pudieron cargar los gráficos de transportadoras — usá el botón Refrescar." />
            )}

            {dashboardQuery.data && (
              <motion.div {...fadeUp(0.12)} className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <CarrierDonut data={dashboardQuery.data.by_transportadora} colorMap={carrierColorMap} />
                <CarrierTimeline data={dashboardQuery.data.by_transportadora_and_date} colorMap={carrierColorMap} />
              </motion.div>
            )}

            {dashboardQuery.data && (
              <motion.div {...fadeUp(0.18)}>
                <CarrierHorizontalStack data={dashboardQuery.data.by_transportadora_and_estado} />
              </motion.div>
            )}
          </TabsContent>

          <TabsContent value="cities" className="mt-4 space-y-5">
            <motion.div {...fadeUp(0.05)}>
              <GeoDistribution rows={cities.data ?? []} />
            </motion.div>
            <motion.div {...fadeUp(0.14)}>
              <CityReturnsTable rows={cities.data ?? []} />
            </motion.div>
          </TabsContent>

          {/* TAB: Productos — solo tasa de entrega/falla por SKU. La
              rentabilidad por SKU se movió a la tab "Finanzas" porque es
              análisis de plata. */}
          <TabsContent value="products" className="mt-4 space-y-5">
            <motion.div {...fadeUp(0.05)}>
              <ProductFailuresTable rows={products.data ?? []} />
            </motion.div>
          </TabsContent>

          {/* TAB: Decisiones — heatmap matriz + tabla recomendador.
              Las dos secciones leen de RPCs nuevas (logistics_by_city_carrier
              y logistics_recommendations). NO se filtran por ciudad porque
              es un análisis comparativo entre ciudades — el filtro ciudad
              no aplica acá. */}
          <TabsContent value="decisiones" className="mt-4 space-y-5">
            <motion.div {...fadeUp(0.05)}>
              <CarrierRecommendations filters={filters} />
            </motion.div>
            <motion.div {...fadeUp(0.14)}>
              <CarrierCityMatrix filters={filters} />
            </motion.div>
          </TabsContent>

          <TabsContent value="trazabilidad" className="mt-4 space-y-5">
            {dashboardQuery.isError && (
              <ChartsErrorBanner text="No se pudieron cargar los gráficos de estados — usá el botón Refrescar." />
            )}
            {dashboardQuery.data && (
              <motion.div {...fadeUp(0.05)}>
                <EstadoDonutAndDailyStack
                  donut={dashboardQuery.data.by_estado}
                  stack={dashboardQuery.data.by_date_and_estado}
                />
              </motion.div>
            )}
            <motion.div {...fadeUp(0.14)}>
              <TrazabilidadView
                summary={summary.data ?? null}
                range={filters}
                carriers={carriers.data ?? []}
              />
            </motion.div>
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
                <h2 className="hud-label text-foreground">
                  Resumen financiero
                </h2>
              </header>
              <FinanzasTab filters={filters} />
            </section>

            <section>
              <header className="flex items-center gap-2 mb-3">
                <Wallet size={14} className="text-accent" />
                <h2 className="hud-label text-foreground">
                  Billetera Dropi
                </h2>
              </header>
              <BilleteraTab filters={filters} />
            </section>

            <section>
              <header className="flex items-center gap-2 mb-3">
                <Coins size={14} className="text-accent" />
                <h2 className="hud-label text-foreground">
                  Rentabilidad por producto
                </h2>
              </header>
              <ProductProfitabilityTable filters={filters} />
            </section>
          </TabsContent>
        </Tabs>
        </motion.div>
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
    <ChartCard title="Distribución por transportadora" icon={PieChartIcon} iconClass="text-info">
      {data.length === 0 ? <EmptyChart /> : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-center">
          <div className="relative h-[260px]">
            <ResponsiveContainer>
              <PieChart>
                {/* Aro grueso con extremos redondeados (cornerRadius) y glow del
                    color de cada slice: el mismo tratamiento de "el dato brilla"
                    del Dashboard. stroke del color de la card = separación limpia
                    entre slices sin dibujar una línea ajena a la paleta. */}
                <Pie data={data} dataKey="total" nameKey="transportadora"
                     innerRadius={62} outerRadius={102} paddingAngle={2} cornerRadius={6}
                     stroke="hsl(var(--card))" strokeWidth={2}>
                  {data.map((d) => {
                    const color = colorMap.get(d.transportadora) ?? 'hsl(var(--muted-foreground))';
                    return <Cell key={d.transportadora} fill={color} style={barGlow(color)} />;
                  })}
                </Pie>
                <RTooltip
                  contentStyle={TOOLTIP_STYLE}
                  formatter={(v: number, n) => [`${v} (${pct(v, total)})`, n]}
                />
              </PieChart>
            </ResponsiveContainer>
            {top && (
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                <div className="text-[38px] font-bold text-foreground font-mono tabular-nums leading-none num-glow-accent">
                  {pct(top.total, total)}
                </div>
                {/* Sin `uppercase`: es el nombre que manda Dropi, no un rótulo
                    nuestro — mayusculizarlo es reescribir el dato. */}
                <div className="text-[11px] text-muted-foreground font-medium mt-2 truncate max-w-[150px] text-center">
                  {top.transportadora}
                </div>
              </div>
            )}
          </div>
          {/* Leyenda-ranking: cada carrier con su barra proporcional del color de
              su slice. El dot suelto sólo decía "existe"; la barra deja comparar
              volúmenes sin volver a la dona. */}
          <ul className="space-y-1.5">
            {data.map((d, i) => {
              const color = colorMap.get(d.transportadora) ?? 'hsl(var(--muted-foreground))';
              // total===0 (todos los carriers en cero) ⇒ barra vacía, igual que el
              // '0%' que devuelve pct(). No se inventa un ancho.
              const width = total > 0 ? (d.total / total) * 100 : 0;
              return (
                <li
                  key={d.transportadora}
                  className="flex flex-col gap-1.5 px-3 py-2 rounded-xl border border-transparent transition-colors duration-200 hover:bg-card/60 hover:border-border"
                >
                  <div className="flex items-center justify-between text-xs gap-2">
                    <span className="flex items-center gap-2 min-w-0">
                      <span className="font-mono tabular-nums text-[11px] text-muted-foreground w-4 shrink-0">{i + 1}</span>
                      <span
                        className="h-2.5 w-2.5 rounded-full shrink-0"
                        style={{ background: color, boxShadow: `0 0 0 3px ${carrierRing(color)}` }}
                        aria-hidden="true"
                      />
                      <span className="font-medium text-foreground truncate">{d.transportadora}</span>
                    </span>
                    <span className="font-mono tabular-nums shrink-0 ml-2 flex items-baseline gap-2">
                      <span className="text-muted-foreground">{d.total}</span>
                      <span className="font-bold text-foreground w-12 text-right">{pct(d.total, total)}</span>
                    </span>
                  </div>
                  <div className="h-1 rounded-full bg-foreground/10 overflow-hidden">
                    <div
                      className="h-full rounded-full transition-[width] duration-700"
                      style={{ width: `${width}%`, background: color }}
                    />
                  </div>
                </li>
              );
            })}
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
    <ChartCard
      title="Guías por fecha y transportadora"
      icon={LineChartIcon}
      iconClass="text-accent"
      right={<span className="text-[10px] text-muted-foreground">tocá la leyenda para ocultar una serie</span>}
    >
      {rows.length === 0 ? <EmptyChart /> : (
        <div className="h-[260px]">
          <ResponsiveContainer>
            {/* ComposedChart (antes LineChart): el TOTAL diario ahora es un ÁREA
                con degradado + trazo accent→cyan, y cada transportadora una línea
                con glow encima. Misma data (`TODAS` ya se calculaba); lo que cambia
                es que el volumen del día se lee como masa y las series como detalle
                sobre ella, en vez de 7 líneas planas compitiendo entre sí. */}
            <ComposedChart data={rows} margin={{ top: 8, right: 10, bottom: 5, left: -10 }}>
              <defs>
                <linearGradient id="carrierTotalGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%"   stopColor={CHART_ACCENT} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={CHART_ACCENT} stopOpacity={0} />
                </linearGradient>
                <linearGradient id="carrierTotalLine" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%"   stopColor={CHART_ACCENT} />
                  <stop offset="100%" stopColor={CHART_CYAN} />
                </linearGradient>
              </defs>
              <CartesianGrid {...CHART_GRID_PROPS} />
              <XAxis dataKey="fecha" stroke="hsl(var(--muted-foreground))" fontSize={10} tickLine={false} axisLine={false} />
              <YAxis stroke="hsl(var(--muted-foreground))" fontSize={10} tickLine={false} axisLine={false} width={36} />
              <RTooltip contentStyle={TOOLTIP_STYLE} cursor={CHART_LINE_CURSOR} />
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
                <Area
                  type="monotone"
                  dataKey="TODAS"
                  stroke="url(#carrierTotalLine)"
                  strokeWidth={3}
                  strokeLinecap="round"
                  strokeDasharray="5 5"
                  fill="url(#carrierTotalGrad)"
                  style={lineGlow(CHART_ACCENT)}
                  // Punto final destacado: ancla la vista en el día más reciente.
                  // El relleno va con --background (no #fff: en tema claro la card
                  // es casi blanca y el punto desaparecería).
                  dot={(p: { cx?: number; cy?: number; index?: number }) =>
                    p.index === rows.length - 1
                      ? <circle key={`tot-${p.index}`} cx={p.cx} cy={p.cy} r={5}
                                fill={CHART_BG} stroke={CHART_CYAN} strokeWidth={2}
                                style={lineGlow(CHART_CYAN)} />
                      : <g key={`tot-${p.index}`} />
                  }
                  activeDot={{ r: 4, strokeWidth: 2, stroke: CHART_BG }}
                />
              )}
              {carriers.map((c) =>
                legend.isVisible(c) ? (
                  <Line
                    key={c}
                    type="monotone"
                    dataKey={c}
                    stroke={colorMap.get(c) ?? 'hsl(var(--muted-foreground))'}
                    strokeWidth={2.5}
                    strokeLinecap="round"
                    style={lineGlow(colorMap.get(c) ?? 'hsl(var(--muted-foreground))')}
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 2, stroke: CHART_BG }}
                  />
                ) : null,
              )}
            </ComposedChart>
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
  // `esHoy` sale de la fecha CRUDA (antes de formatearla a DD/MM) comparada con
  // hoy en horario local — el mismo criterio que el resto del archivo, que no usa
  // toISOString() justo para no correrse un día en Bogotá.
  const hoyISO = localISODate(new Date());
  const stackRows = stack.map((s) => ({ ...s, esHoy: s.fecha === hoyISO, fecha: fmtDate(s.fecha) }));
  const stackKeys = ['entregada', 'transito', 'novedad', 'devolucion', 'rechazada'];
  const legend = useInteractiveLegend();
  const visibleKeys = stackKeys.filter((k) => legend.isVisible(k));

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <ChartCard title="Estado global" icon={PieChartIcon} iconClass="text-success">
        {donut.length === 0 ? <EmptyChart /> : (
          <>
            <div className="relative h-[240px]">
              <ResponsiveContainer>
                <PieChart>
                  {/* Mismo tratamiento que la dona de transportadoras: extremos
                      redondeados + glow del color del propio estado. El fallback
                      gris (estado nuevo de Dropi sin mapear) se conserva: se ve,
                      no se pierde ni se re-etiquetea. */}
                  <Pie data={donut} dataKey="total" nameKey="estado_agrupado"
                       innerRadius={58} outerRadius={96} paddingAngle={2} cornerRadius={6}
                       stroke="hsl(var(--card))" strokeWidth={2}>
                    {donut.map((d) => {
                      const color = ESTADO_COLORS[d.estado_agrupado] ?? 'hsl(var(--muted-foreground))';
                      return <Cell key={d.estado_agrupado} fill={color} style={barGlow(color)} />;
                    })}
                  </Pie>
                  <RTooltip
                    contentStyle={TOOLTIP_STYLE}
                    formatter={(v: number, n) => [`${v} (${pct(v, total)})`, n]}
                  />
                </PieChart>
              </ResponsiveContainer>
              {top && (
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                  <div className="text-[38px] font-bold text-foreground font-mono tabular-nums leading-none num-glow-accent">
                    {pct(top.total, total)}
                  </div>
                  {/* El nombre del estado viene de Dropi: se muestra tal cual. */}
                  <div className="text-[11px] text-muted-foreground font-medium mt-2 max-w-[150px] text-center truncate">
                    {top.estado_agrupado}
                  </div>
                </div>
              )}
            </div>
            {/* Leyenda propia (antes la <Legend> de recharts): swatches cuadrados
                de 10px, que es como rotula el Dashboard, y sin comerle alto al
                gráfico. */}
            <SwatchLegend
              className="mt-3 justify-center"
              items={donut.map((d) => ({
                color: ESTADO_COLORS[d.estado_agrupado] ?? 'hsl(var(--muted-foreground))',
                label: d.estado_agrupado,
              }))}
            />
          </>
        )}
      </ChartCard>

      <ChartCard title="Estados por día de creación" icon={Layers} iconClass="text-warning">
        {stackRows.length === 0 ? <EmptyChart /> : (
          <div className="h-[280px]">
            <ResponsiveContainer>
              <BarChart data={stackRows} margin={{ top: 8, right: 10, bottom: 5, left: -10 }}>
                <BarGradientDefs
                  prefix="estadoDia"
                  entries={stackKeys.map((k) => ({ key: k, color: STACK_COLORS[k] }))}
                />
                <CartesianGrid {...CHART_GRID_PROPS} />
                <XAxis dataKey="fecha" stroke="hsl(var(--muted-foreground))" fontSize={10} tickLine={false} axisLine={false} />
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
                {stackKeys.map((key) =>
                  legend.isVisible(key) ? (
                    <Bar
                      key={key}
                      dataKey={key}
                      stackId="a"
                      fill={`url(#estadoDia-${key})`}
                      name={STACK_LABELS[key]}
                      // Solo el segmento MÁS ALTO de la pila lleva radio; si se lo
                      // ponés a los de abajo aparecen muescas entre segmentos. Y
                      // "más alto" es el último VISIBLE, no el último del array:
                      // con series ocultas el tope cambia.
                      radius={key === visibleKeys[visibleKeys.length - 1] ? [6, 6, 0, 0] : [0, 0, 0, 0]}
                      style={key === 'entregada' ? barGlow(STACK_COLORS.entregada) : undefined}
                    >
                      {/* La columna de hoy se marca con contorno cian, nunca
                          cambiándole el relleno: el color es el estado. */}
                      {stackRows.map((d, idx) => (
                        <Cell
                          key={`${key}-${idx}`}
                          stroke={d.esHoy ? CHART_CYAN : 'transparent'}
                          strokeWidth={d.esHoy ? 1.5 : 0}
                        />
                      ))}
                    </Bar>
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

  // Los dataKey llevan espacios y tildes ("En tránsito"): no sirven como id de
  // <defs> (url(#…) los rompe), así que el degradado va con un slug propio.
  const PCT_SERIES = [
    { key: 'Entregada',   slug: 'entregada',  color: 'hsl(var(--success))' },
    { key: 'En tránsito', slug: 'transito',   color: 'hsl(var(--info))' },
    { key: 'Novedad',     slug: 'novedad',    color: 'hsl(var(--warning))' },
    { key: 'Devolución',  slug: 'devolucion', color: 'hsl(var(--danger))' },
    { key: 'Rechazada',   slug: 'rechazada',  color: 'hsl(var(--danger) / 0.6)' },
  ];

  return (
    <ChartCard
      title="Desempeño por transportadora (% de estado)"
      icon={BarChart3}
      iconClass="text-success"
      right={<SwatchLegend items={PCT_SERIES.map(s => ({ color: s.color, label: s.key }))} />}
    >
      {rows.length === 0 ? <EmptyChart /> : (
        <div style={{ height: Math.max(220, rows.length * 56) }}>
          <ResponsiveContainer>
            <BarChart data={rows} layout="vertical" margin={{ top: 5, right: 20, bottom: 5, left: 20 }} stackOffset="expand" barCategoryGap="28%">
              <BarGradientDefs prefix="carrierPct" entries={PCT_SERIES.map(s => ({ key: s.slug, color: s.color }))} />
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border) / 0.5)" horizontal={false} />
              <XAxis
                type="number"
                domain={[0, 100]}
                stroke="hsl(var(--muted-foreground))"
                fontSize={10}
                tickLine={false}
                axisLine={false}
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
              {/* La leyenda vive en el header de la card (SwatchLegend): acá abajo
                  le comía alto a barras que ya son finas. */}
              {PCT_SERIES.map((s, i) => (
                <Bar
                  key={s.key}
                  dataKey={s.key}
                  stackId="b"
                  fill={`url(#carrierPct-${s.slug})`}
                  // Extremos redondeados solo en las puntas de la pila (izquierda
                  // la primera, derecha la última); los del medio a 0 para que no
                  // queden muescas.
                  radius={i === 0 ? [6, 0, 0, 6] : i === PCT_SERIES.length - 1 ? [0, 6, 6, 0] : [0, 0, 0, 0]}
                  style={s.slug === 'entregada' ? barGlow(s.color) : undefined}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </ChartCard>
  );
}

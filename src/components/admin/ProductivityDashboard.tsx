import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import {
  Loader2, RefreshCw, TrendingUp, AlertTriangle, Trophy, Clock,
  CheckCircle2, Inbox, Users, PhoneCall, BarChart3, Activity,
} from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { motion } from 'framer-motion';
import { TiltCard, StatTile, GaugeRing, CountUp } from '@/components/ui3d';
import {
  CHART_TOOLTIP_STYLE, CHART_GRID_PROPS, CHART_BAR_CURSOR,
} from '@/components/logistics/charts/chartTokens';
import { confRateBySample, confRateByCohort, isBelowDailyTarget, CONF_TARGET_PCT, CONF_DIA_TARGET_PCT } from '@/lib/confirmationRate';
import { useActiveStoreId } from '@/contexts/StoreContext';
import { useShopifyPending } from '@/hooks/useShopifyPending';
import { ShoppingBag } from 'lucide-react';
import { formatTimeBogota, formatDateTimeBogota, formatDurationHM } from '@/lib/timeFormat';
import { shouldAlertSinConfirmar, asWorkedBlocks, sumWorkedSeconds, computeHorarioCompliance, UMBRAL_DESCONECTADA_MIN } from '@/lib/jornadaMath';
import { scheduleFromMinutes, DEFAULT_SCHEDULE } from '@/lib/inactivityWindow';
import { useStoreSchedule } from '@/hooks/useStoreSchedule';
import { gestionesPorHora, ritmoTone, MIN_INTENTOS_POR_HORA } from '@/lib/operatorThroughput';
import { bogotaToday } from '@/lib/utils';

interface ActivityRow {
  operator_id: string;
  display_name: string;
  first_action_at: string | null;
  last_active_at: string | null;
  active_seconds: number;
  idle_seconds: number;
}

/** Fila de operator_worked_blocks — HORAS REALES por evidencia de trabajo.
 *  `worked_seconds` = suma de los bloques (order_results + touchpoints agrupados
 *  con corte de 15 min). `blocks` es jsonb (array de {start,end,events,sec}). */
interface WorkedRow {
  operator_id: string;
  display_name: string;
  worked_seconds: number;
  block_count: number;
  first_event: string | null;
  last_event: string | null;
  blocks: unknown;
}

// Sin '24h' rodante: las ventanas se alinean a día-calendario Bogotá (igual que
// el cohorte de Reportes Diarios) para que "entrantes" reconcilie entre vistas.
type Range = 'today' | '7d' | '30d';

interface Row {
  operator_id: string;
  display_name: string;
  confirmados: number;
  cancelados: number;
  noresp: number;
  novedades_resueltas: number;
  seg_acciones: number;
  seg_resueltos: number;
  rescate_acciones: number;
  rescate_resueltos: number;
  total_atendidos: number;
  /** Total de pedidos que entraron al período (inflow global). Mismo valor
   *  para todas las filas — UI lo lee de rows[0]. Denominador de
   *  tasa_confirmacion desde la migration 20260505120000. */
  total_entrantes: number;
  tasa_contacto: number;
  /** % confirmados sobre total_entrantes (NO sobre gestionados). Refleja
   *  productividad real: penaliza dejar pedidos sin gestionar. */
  tasa_confirmacion: number;
  /** Conteos por PEDIDO DISTINTO (phone), no por acción. Base correcta de la
   *  tasa de resolución. Opcionales: si la migración 20260526140000 aún no se
   *  aplicó, vienen undefined y la UI cae al cálculo viejo sobre acciones. */
  seg_pedidos?: number;
  seg_resueltos_dist?: number;
  rescate_pedidos?: number;
  rescate_resueltos_dist?: number;
  /** Esfuerzo bruto de confirmar (v4 — migration 20260528220000).
   *  - intentos_noresp: pedidos distintos donde marcó "no contestó" al menos
   *    una vez, INCLUSO si después se confirmaron. Esto es lo que la columna
   *    `noresp` original esconde (porque allá un noresp con conf posterior se
   *    descuenta). Métrica de ESFUERZO.
   *  - intentos_total: COUNT(*) acciones de confirmar. Si llamó 3 veces al
   *    mismo pedido = 3.
   *  - pendientes_sin_tocar: GLOBAL del store (mismo valor para todos los rows)
   *    = entrantes − atendidos. Lo leemos de rows[0] para la fila TOTAL.
   *  Opcionales: si la migración aún no se aplicó, vienen undefined y la UI
   *  muestra '—'. */
  intentos_noresp?: number;
  intentos_total?: number;
  pendientes_sin_tocar?: number;
}

const RANGE_LABELS: Record<Range, string> = {
  'today': 'Hoy',
  '7d': 'Últimos 7 días',
  '30d': 'Últimos 30 días',
};

const hsl = (v: string) => `hsl(var(${v}))`;
const CHART_SUCCESS = hsl('--success');
const CHART_DANGER = hsl('--danger');

/** Glow del trazo de barra — firma del DS. */
const barGlow = (color: string) => ({ filter: `drop-shadow(0 0 6px ${color})` });

/**
 * Clases por tono, ESCRITAS COMPLETAS a propósito. Tailwind escanea el código
 * como texto plano: un `bg-${tone}/14` armado en runtime no existe para el
 * compilador y la clase se purga del CSS (el chip saldría transparente). Nada
 * de interpolar nombres de clase de Tailwind.
 */
const TONE_CHIP = {
  accent: 'bg-accent/14 border-accent/30 text-accent glow-accent',
  success: 'bg-success/14 border-success/30 text-success glow-success',
  warning: 'bg-warning/14 border-warning/30 text-warning glow-warning',
  info: 'bg-info/14 border-info/30 text-info glow-info',
} as const;

const TONE_TEXT = {
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
} as const;

/** Entrada escalonada: la pantalla se arma de arriba abajo. */
const fadeUp = (delay = 0) => ({
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35, delay, ease: 'easeOut' as const },
});

/**
 * Degradado vertical por serie. Los ids de `<defs>` son GLOBALES al documento:
 * de ahí el `prefix` obligatorio para no pisar los de otra card.
 */
function BarGradientDefs({ prefix, entries }: { prefix: string; entries: { key: string; color: string }[] }) {
  return (
    <defs>
      {entries.map(e => (
        <linearGradient key={e.key} id={`${prefix}-${e.key}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={e.color} stopOpacity={0.95} />
          <stop offset="100%" stopColor={e.color} stopOpacity={0.5} />
        </linearGradient>
      ))}
    </defs>
  );
}

/** Bullet-style data bar para tasas. Tono semántico vs `target`. Para la tasa de
 *  CONFIRMACIÓN el target es la meta oficial del dueño (CONF_TARGET_PCT = 85%); la
 *  tasa de RESOLUCIÓN (Seguimiento/Novedades) es otra métrica y pasa su propio
 *  benchmark operativo. Verde >= target; ámbar en la banda "cerca" (5 pts). */
function RateBar({ value, target = CONF_TARGET_PCT }: { value: number; target?: number }) {
  // El % del día se topa en 100%: una tasa no se muestra por encima de 100 (si
  // confirmó pedidos viejos además de los de hoy ya está "al día" — la columna
  // "faltan 0" de al lado lo indica). El dueño lo pidió explícito: nada de "140%".
  const pct = Math.max(0, Math.min(100, value));
  const tone: keyof typeof TONE_TEXT = pct >= target ? 'success' : pct >= target - 5 ? 'warning' : 'danger';
  return (
    <div className="inline-flex flex-col items-end gap-1 w-full min-w-[92px]">
      <span className={`font-mono tabular-nums text-xs font-bold ${TONE_TEXT[tone]}`}>{pct.toFixed(0)}%</span>
      {/* Riel + relleno con degradado y halo del tono. La marca de la meta va
          como tick sobre el riel: se ve de un vistazo si la barra la cruza. */}
      <div
        className="relative h-1.5 w-full rounded-full bg-foreground/10 overflow-hidden"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full rounded-full transition-[width] duration-700"
          style={{
            width: `${pct}%`,
            background: `linear-gradient(90deg, hsl(var(--${tone}) / 0.55), hsl(var(--${tone})))`,
            boxShadow: `0 0 6px hsl(var(--${tone}) / 0.55)`,
          }}
          aria-hidden="true"
        />
        <span
          className="absolute top-0 bottom-0 w-px bg-foreground/35"
          style={{ left: `${Math.max(0, Math.min(100, target))}%` }}
          aria-hidden="true"
        />
      </div>
    </div>
  );
}

export default function ProductivityDashboard() {
  const [range, setRange] = useState<Range>('today');
  const [rows, setRows] = useState<Row[]>([]);
  const [activityRows, setActivityRows] = useState<ActivityRow[]>([]);
  const [workedRows, setWorkedRows] = useState<WorkedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Antes solo console.error → la UI mostraba "Sin actividad" indistinguible
  // de un error silenciado vs cero filas reales. Ahora capturamos el mensaje
  // y lo renderizamos como banner visible para diagnóstico inmediato.
  const [error, setError] = useState<string | null>(null);
  // Acciones CRUDAS del período (sin excluir a nadie), solo para que el estado
  // vacío pueda distinguir "nadie trabajó" de "sí hubo trabajo pero no se
  // cuenta acá". null = todavía no se consultó.
  const [accionesPeriodo, setAccionesPeriodo] = useState<number | null>(null);

  // Fuga Shopify→Dropi: ventas que entraron a Shopify pero NUNCA pasaron a Dropi
  // (no entran al flujo de confirmación → plata que se pierde en silencio). Es
  // responsabilidad del turno dejarla en 0. Store-scoped, cacheado 60s. Si no hay
  // Shopify configurado, el hook devuelve configured:false → no mostramos nada.
  const activeStoreId = useActiveStoreId();
  const shopifyPending = useShopifyPending(activeStoreId);
  // Horario laboral de la tienda (excluye almuerzo) → base de "En su puesto".
  const { data: scheduleMin } = useStoreSchedule(activeStoreId);
  const schedule = scheduleMin ? scheduleFromMinutes(scheduleMin) : DEFAULT_SCHEDULE;

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    // El scope por tienda lo resuelve la RPC server-side vía
    // _resolve_scope_store() (admin → su tienda activa, profiles.active_store_id).
    // No pasamos p_store_id: así NO dependemos de que la migration del parámetro
    // esté aplicada (evita el PGRST202 "function ... does not exist").
    const [productivity, activity, worked] = await Promise.all([
      supabase.rpc('operator_productivity_stats' as never, { p_range: range } as never),
      // Jornada — heartbeat de entrada/salida (operator_activity_stats). Si la
      // migration no se aplicó, capturamos el PGRST202 silencioso y la sección
      // sigue con lo que haya de evidencia de trabajo.
      supabase.rpc('operator_activity_stats' as never, { p_range: range } as never),
      // Evidencia de trabajo (operator_worked_blocks): da primera/última acción
      // marcada, respaldo de entrada/salida cuando no hay heartbeat.
      supabase.rpc('operator_worked_blocks' as never, { p_range: range } as never),
    ]);
    const { data, error: rpcErr } = productivity;
    if (rpcErr) {
      console.error('[productivity] rpc error', rpcErr);
      const e = rpcErr as { code?: string; message?: string; hint?: string; details?: string };
      setError(`${e.code || 'ERR'}: ${e.message || 'Error desconocido'}${e.hint ? ` — ${e.hint}` : ''}${e.details ? ` (${e.details})` : ''}`);
      setRows([]);
    } else {
      const arr = (data as Row[] | null) ?? [];
      setRows(arr);
      setError(null);
    }
    // Conteo CRUDO de acciones del período — sin excluir admins ni nada.
    //
    // Existe por un caso real (2026-07-20): el dueño marcó un pedido, la tabla
    // siguió vacía y leyó "está roto". No lo estaba: `operator_productivity_stats`
    // excluye a los admin a propósito, y esa era la ÚNICA acción del día. El
    // cartel decía "Todavía sin gestiones" cuando la verdad era "hubo una, pero
    // no se cuenta acá". Con este número el estado vacío puede decir cuál de las
    // dos cosas pasó. Es best-effort: si falla, el cartel cae al texto genérico.
    try {
      const hoy = bogotaToday();
      const desde = range === 'today'
        ? hoy
        : new Date(Date.now() - (range === '7d' ? 6 : 29) * 86400000)
            .toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
      const { count } = await supabase
        .from('order_results')
        .select('id', { count: 'exact', head: true })
        .gte('result_date', desde)
        .lte('result_date', hoy);
      setAccionesPeriodo(count ?? 0);
    } catch {
      setAccionesPeriodo(null);
    }

    // Jornada: error silencioso (la migration puede no estar) pero LIMPIANDO
    // el estado — antes se retenían las filas del range anterior y, si solo
    // fallaba la RPC de un range, se cruzaba startedAt de 'today' contra
    // productividad de 7d (o al revés) en los chips.
    if (!activity.error) {
      setActivityRows((activity.data as ActivityRow[] | null) ?? []);
    } else {
      setActivityRows([]);
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[productivity] activity rpc error', activity.error);
      }
    }
    // Horas reales: idem trato silencioso + limpieza (si la migration no está,
    // el titular "Trabajó" cae a '—' pero la sección sigue con el heartbeat).
    if (!worked.error) {
      setWorkedRows((worked.data as WorkedRow[] | null) ?? []);
    } else {
      setWorkedRows([]);
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[productivity] worked rpc error', worked.error);
      }
    }
    setLoading(false);
    setRefreshing(false);
  }, [range]);

  useEffect(() => { load(); }, [load]);

  // Realtime debounced 1s: cualquier cambio en orders/order_results/touchpoints
  // dispara un refetch silencioso. Sin polling.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const debounced = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => load(true), 1000);
    };
    const channel = supabase
      .channel('admin-productivity')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, debounced)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'order_results' }, debounced)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'touchpoints' }, debounced)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'operator_activity_daily' }, debounced)
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [load]);

  // Cruce jornada ↔ productividad por operadora (para la alerta "sin confirmar"
  // en la tabla Confirmar). Si no hay fila de actividad, no se alerta.
  const activityByOp = new Map(activityRows.map(r => [r.operator_id, r]));
  const workedByOp = new Map(workedRows.map(r => [r.operator_id, r]));
  // Operadoras a mostrar en Jornada = las que aparecen por CUALQUIER señal:
  // trabajo real por evidencia (worked) Y/O heartbeat de CRM (activity). Una
  // operadora que trabajó por teléfono puede tener bloques de trabajo sin apenas
  // heartbeat (y viceversa); mostramos ambas fuentes por fila. Orden: primer
  // signo del día ascendente (mismo criterio que las RPCs).
  const jornadaOps = Array.from(
    new Set([...workedRows.map(r => r.operator_id), ...activityRows.map(r => r.operator_id)]),
  )
    .map(id => {
      const w = workedByOp.get(id);
      const a = activityByOp.get(id);
      return { id, w, a, name: w?.display_name ?? a?.display_name ?? 'Sin nombre' };
    })
    .sort((x, y) => {
      // Ordena por la señal MÁS TEMPRANA del día (acción de trabajo o mouse, la
      // que haya sido primero), no solo por la acción — así la fila no se
      // "adelanta" ni "atrasa" según qué fuente miremos.
      const key = (o: { w?: WorkedRow; a?: ActivityRow }) =>
        Math.min(
          Date.parse(o.w?.first_event ?? '') || Infinity,
          Date.parse(o.a?.first_action_at ?? '') || Infinity,
        );
      return key(x) - key(y);
    });
  // Un solo "ahora" por render: el realtime debounced re-renderiza cada ~1s,
  // así que "en línea / desconectada / sin confirmar" se mantienen frescos.
  const nowMs = Date.now();
  // "Cumplió el horario" (entró/salió/%) y shouldAlertSinConfirmar SOLO valen en
  // 'today': para 7d/30d la RPC operator_activity_stats devuelve MIN(first_action)
  // / MAX(last_active) sobre TODO el rango (migration 20260626233822), así que la
  // ventana cruzaría noches y días libres. En multi-día mostramos las horas
  // trabajadas del rango y ocultamos entrada/salida.
  const isToday = range === 'today';

  const chartData = rows.map(r => ({
    name: r.display_name,
    Confirmados: r.confirmados,
    Cancelados: r.cancelados,
  }));

  // Líder del día — para el callout de "Top operadora"
  const leader = rows.length > 0
    ? [...rows].sort((a, b) => b.confirmados - a.confirmados)[0]
    : null;

  // Embudo del DÍA a nivel EQUIPO (el header de la sección). `entrantes` es global
  // del store (cola compartida, no hay inflow por-operadora). El número que el
  // dueño quiere ver ("cómo va el día") es teamTasaDia = confirmados ÷ lo que
  // entró — NO ÷resueltos (eso es efectividad de cierre, va en el tooltip de cada
  // celda). Cobertura = lo GESTIONADO ÷ entró (¿trabajó todo o dejó pedidos?).
  const entrantes = rows[0]?.total_entrantes ?? 0;
  const teamConf = rows.reduce((a, r) => a + r.confirmados, 0);
  const teamCanc = rows.reduce((a, r) => a + r.cancelados, 0);
  const teamContactados = rows.reduce((a, r) => a + r.confirmados + r.cancelados, 0);
  const teamAtendidos = rows.reduce((a, r) => a + r.total_atendidos, 0);
  const teamTasaDia = entrantes > 0 ? Math.round((teamConf / entrantes) * 100) : 0;
  // Meta POR OPERADORA = la meta del equipo repartida entre las que trabajaron.
  // La fila de cada una divide SUS confirmados por el inflow GLOBAL (la cola es
  // compartida, no hay inflow por-operadora), así que con 2+ operadoras que se
  // reparten el día TODAS quedaban "en rojo" vs 55% aunque el equipo estuviera
  // encima (auditoría 2026-07-07). Con 1 operadora activa no cambia nada.
  const opsActivas = Math.max(1, rows.filter((r) => (r.total_atendidos ?? 0) > 0).length);
  const metaPorOperadora = Math.max(1, Math.round(CONF_DIA_TARGET_PCT / opsActivas));
  // Madurez del embudo del equipo — MISMA fuente y umbral que la fila TOTAL de la
  // tabla (confRateByCohort). Solo se usa para rotular el hero como provisional:
  // el número que se dibuja sigue siendo teamTasaDia, sin recalcular nada.
  const cdHero = confRateByCohort(teamConf, teamCanc, entrantes);
  const heroEnCurso = isToday && cdHero.inmaduro;
  const heroTone = heroEnCurso || cdHero.tasaDia == null
    ? 'brand'
    : isBelowDailyTarget(teamTasaDia)
      ? (teamTasaDia >= CONF_DIA_TARGET_PCT - 5 ? 'warning' : 'danger')
      : 'success';

  return (
    <div className="space-y-5">
      {/* Page sub-header — eyebrow + título + meta + actions */}
      <motion.header {...fadeUp(0)} className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          <div className="hud-label">
            Productividad · Equipo
          </div>
          <h2 className="text-xl font-bold tracking-tight text-foreground leading-none flex items-center gap-2">
            <TrendingUp size={18} className="text-accent" aria-hidden="true" strokeWidth={2.25} />
            Por operadora
          </h2>
          <p className="text-sm text-muted-foreground">
            {RANGE_LABELS[range]} · auto-refresh activo
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Segmented control — mismo patrón que el Dashboard */}
          <div className="inline-flex flex-wrap gap-[2px] p-[3px] rounded-xl bg-card/40 border border-border">
            {(['today', '7d', '30d'] as Range[]).map(r => (
              <button
                key={r}
                onClick={() => setRange(r)}
                aria-pressed={range === r}
                className={`px-4 py-2 rounded-[9px] text-sm transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ${
                  range === r
                    ? 'font-semibold bg-accent/16 border border-accent/40 text-accent shadow-glow3d'
                    : 'font-medium border border-transparent text-muted-foreground hover:text-foreground hover:bg-muted'
                }`}
              >
                {r}
              </button>
            ))}
          </div>
          <button
            onClick={() => load(true)}
            disabled={refreshing}
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-card/40 transition-colors hover:border-border-strong hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            aria-label="Refrescar"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} aria-hidden="true" />
          </button>
        </div>
      </motion.header>

      {error && (
        <div className="rounded-2xl border border-danger/30 bg-danger/5 p-4 shadow-card3d">
          <div className="flex items-start gap-3">
            <AlertTriangle size={16} className="text-danger mt-0.5 shrink-0" aria-hidden="true" strokeWidth={2.25} />
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-bold text-danger">Error cargando productividad</p>
              <p className="text-xs text-foreground/80 font-mono break-all">{error}</p>
              <p className="text-[11px] text-muted-foreground">
                Si dice <code className="px-1 rounded bg-muted/40">function … does not exist</code>: la migration de la RPC no se aplicó.
                Si dice <code className="px-1 rounded bg-muted/40">42501</code> o <code className="px-1 rounded bg-muted/40">Solo administradores</code>: tu usuario no tiene rol admin en <code className="px-1 rounded bg-muted/40">user_roles</code>.
              </p>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="rounded-2xl border border-border bg-card/40 shadow-card3d hairline-top p-10 flex items-center justify-center">
          <Loader2 className="animate-spin text-accent" size={20} aria-hidden="true" />
        </div>
      ) : !error ? (
        <>
          {/* Embudo del equipo, dibujado. Son EXACTAMENTE los mismos números del
              rótulo de la sección Confirmar (entraron → gestionó → contactó →
              confirmó = % del día); acá se ven como aro + tarjetas en vez de una
              línea de texto. Se muestra solo con inflow real (entrantes > 0): sin
              eso no hay denominador y un 0% sería inventado. */}
          {rows.length > 0 && entrantes > 0 && (
            <motion.div {...fadeUp(0.06)} className="grid grid-cols-1 md:grid-cols-12 gap-4">
              <TiltCard
                sheen
                brackets
                wrapperClassName="md:col-span-5"
                className="bg-card/40 border border-border rounded-3xl p-6 shadow-card3d-lg h-full flex flex-col justify-between"
              >
                <div className="flex items-center justify-between gap-3 tilt-layer-2">
                  <div className="hud-label" title="Confirmados ÷ lo que ENTRÓ en el período.">
                    Confirmación del día
                  </div>
                  {heroEnCurso && (
                    <span
                      className="inline-flex items-center px-2 py-0.5 rounded-lg border border-border bg-muted/50 text-[10px] font-semibold text-muted-foreground whitespace-nowrap"
                      title={`Día en curso (${cdHero.pctProcesado}% trabajado) — provisional.`}
                    >
                      · en curso
                    </span>
                  )}
                </div>

                <div className="flex justify-center py-4 tilt-layer-3">
                  <GaugeRing value={teamTasaDia} label="del día" size={190} tone={heroTone} />
                </div>

                <div className="tilt-layer-1">
                  <div className="flex items-center justify-between text-xs text-muted-foreground mb-1.5">
                    <span>Meta del día</span>
                    <span className="font-mono tabular-nums text-foreground">
                      <b>{teamConf}</b> / {entrantes}
                    </span>
                  </div>
                  <div className="relative h-2 rounded-full bg-foreground/10 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-accent-gradient transition-[width] duration-700"
                      style={{ width: `${Math.max(0, Math.min(100, teamTasaDia))}%` }}
                      aria-hidden="true"
                    />
                    <span
                      className="absolute top-0 bottom-0 w-px bg-foreground/40"
                      style={{ left: `${CONF_DIA_TARGET_PCT}%` }}
                      aria-hidden="true"
                      title={`Meta del día ~${CONF_DIA_TARGET_PCT}%`}
                    />
                  </div>
                </div>
              </TiltCard>

              {/* El embudo, tarjeta por tarjeta: cada paso pierde volumen contra
                  el anterior — la caída se ve sin leer. */}
              <div className="md:col-span-7 grid grid-cols-1 min-[390px]:grid-cols-2 gap-4">
                <StatTile
                  icon={Inbox}
                  label="Entraron"
                  value={entrantes}
                  tone="accent"
                  title="Pedidos que entraron al período (inflow del store)."
                />
                <StatTile
                  icon={Users}
                  label="Gestionó"
                  value={teamAtendidos}
                  tone="info"
                  title="Pedidos distintos que el equipo gestionó."
                  extra={
                    <span className="font-mono tabular-nums text-[11px] font-medium text-muted-foreground">
                      {Math.max(0, entrantes - teamAtendidos)} sin tocar
                    </span>
                  }
                />
                <StatTile
                  icon={PhoneCall}
                  label="Contactó"
                  value={teamContactados}
                  tone="warning"
                  title="Clientes que contestaron y decidieron (confirmaron o cancelaron)."
                />
                <StatTile
                  icon={CheckCircle2}
                  label="Confirmó"
                  value={teamConf}
                  tone="success"
                  title="Pedidos confirmados por el equipo en el período."
                />
              </div>
            </motion.div>
          )}

          {/* Jornada SIEMPRE arriba si hay activityRows — métrica de presencia
              (cuándo empezó / cuánto activa). Va separada de las secciones de
              resultado (Confirmar/Seguimiento/Rescate) porque pueden coexistir:
              una operadora puede tener jornada larga y 0 confirmados (o al
              revés). Si activityRows está vacía la sección no se renderiza.
              Bug del primer release: estaba DENTRO del branch
              `rows.length > 0`, así que con 0 confirmados se ocultaba aunque
              hubiera pings — ahora vive fuera. */}
          {jornadaOps.length > 0 && (
            <Section
              title="Jornada"
              tone="info"
              icon={Clock}
              note={isToday
                ? '¿Cumplió el horario? Hora de ENTRADA y SALIDA (primera y última señal del día) y cuánto del horario cubrió. NO se descuenta el estar quieta — puede estar en una llamada.'
                : 'Horas trabajadas del rango, tiempo conectada al CRM, y la primera y última señal de cada operadora en el período.'}
            >
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="w-10">#</th>
                      <th>Operadora</th>
                      {/* El encabezado CAMBIA con el rango: en un período de
                          varios días esta columna no muestra "cumplimiento"
                          sino horas trabajadas, y llamarla igual que en Hoy
                          hacía leer una cosa por otra. */}
                      <th className="text-right" title={isToday
                        ? '¿Cuánto del horario pactado cubrió? = desde que entró hasta que salió, dentro del horario de la tienda, menos el almuerzo. NO se descuenta el estar quieta (una llamada no mueve el mouse).'
                        : 'Suma de las horas con evidencia de trabajo (pedidos marcados) en todos los días del rango. NO es lo mismo que el tiempo conectada: eso está en la columna de al lado.'}>
                        {isToday ? 'Cumplió horario' : 'Horas trabajadas'}
                      </th>
                      {/* Tiempo conectada / fuera. El dato venía del servidor
                          desde siempre (active_seconds / idle_seconds), estaba
                          declarado en el tipo y NO SE DIBUJABA en ningún lado:
                          llegaba a la pantalla y se tiraba. */}
                      <th className="text-right" title="Tiempo con el CRM abierto y en uso (mouse/teclado) vs. tiempo sin señal. Estar quieta NO es estar ausente: en una llamada no se mueve el mouse. Sirve para ver de un vistazo cuánto estuvo fuera del CRM, no para castigar.">
                        En el CRM
                      </th>
                      <th className="text-right" title={isToday
                        ? "Hora de la PRIMERA señal del día (cuándo se conectó), zona Bogotá. 'puntual' si llegó a tiempo; rojo si llegó tarde respecto al horario."
                        : 'Primera señal de la operadora en todo el rango, con su fecha. Zona Bogotá.'}>Entró</th>
                      <th className="text-right" title={isToday
                        ? "Hora de la ÚLTIMA señal del día, zona Bogotá. 'en línea' = sigue activa ahora; rojo si se fue antes del fin del horario."
                        : 'Última señal de la operadora en todo el rango, con su fecha. Zona Bogotá.'}>Salió</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jornadaOps.map((op, idx) => {
                      const a = op.a;
                      const w = op.w;
                      // worked_seconds (evidencia de marcado) — respaldo para 7d/30d y
                      // para la entrada/salida cuando no hay heartbeat.
                      const blocks = w ? asWorkedBlocks(w.blocks) : [];
                      const wsNum = w ? Number(w.worked_seconds) : NaN;
                      const workedSec = w
                        ? (Number.isFinite(wsNum) && wsNum > 0 ? wsNum : sumWorkedSeconds(blocks))
                        : null;
                      // Entró = primera señal del día (mouse o marcado, la más temprana);
                      // Salió = última señal. El heartbeat da la ENTRADA real (cuándo se
                      // conectó), no la del primer pedido marcado — clave para "llegó a tiempo".
                      const firstSignalMs = Math.min(
                        Date.parse(w?.first_event ?? '') || Infinity,
                        Date.parse(a?.first_action_at ?? '') || Infinity,
                      );
                      const lastSignalMs = Math.max(
                        Date.parse(w?.last_event ?? '') || 0,
                        Date.parse(a?.last_active_at ?? '') || 0,
                      );
                      const turnoStart = Number.isFinite(firstSignalMs) ? new Date(firstSignalMs).toISOString() : null;
                      const turnoEnd = lastSignalMs > 0 ? new Date(lastSignalMs).toISOString() : null;
                      // ¿Cumplió el horario? Solo por-día; en 7d/30d cae a las horas del rango.
                      const comp = isToday ? computeHorarioCompliance({ turnoStart, turnoEnd, schedule }) : null;
                      const pct = comp?.cumplimientoPct ?? null;
                      const cumpleTone = pct == null ? 'muted-foreground' : pct >= 90 ? 'success' : pct >= 70 ? 'warning' : 'danger';
                      // ¿Sigue en línea ahora? (última señal hace poco → no marca "salió antes").
                      const desconectadaMin = isToday && lastSignalMs > 0
                        ? Math.max(0, Math.floor((nowMs - lastSignalMs) / 60000))
                        : null;
                      const enLinea = desconectadaMin != null && desconectadaMin < UMBRAL_DESCONECTADA_MIN;
                      return (
                        <tr key={op.id}>
                          <td>
                            <span className="font-mono text-[11px] font-bold tabular-nums text-muted-foreground">
                              {String(idx + 1).padStart(2, '0')}
                            </span>
                          </td>
                          <td className="font-semibold text-foreground">{op.name}</td>
                          {/* CUMPLIÓ HORARIO — % del horario cubierto (hoy) o horas del rango. */}
                          <td className="text-right">
                            {isToday ? (
                              pct == null ? (
                                // computeHorarioCompliance devuelve null cuando
                                // salida <= entrada, y eso pasa en DOS casos muy
                                // distintos: sin ninguna señal, o con UNA sola
                                // (recién se conectó). Antes ambos mostraban "—"
                                // con el tooltip "Sin señales del día todavía",
                                // que MIENTE cuando la fila ya muestra la hora
                                // de entrada.
                                lastSignalMs > 0 ? (
                                  <span
                                    className="font-mono text-xs text-muted-foreground"
                                    title="Se conectó pero todavía no hay un tramo de trabajo medible (entrada y última señal coinciden). El porcentaje aparece cuando pase más tiempo."
                                  >
                                    recién entró
                                  </span>
                                ) : (
                                  <span className="font-mono text-muted-foreground text-xs" title="Sin señales del día todavía.">—</span>
                                )
                              ) : (
                                <div className="inline-flex flex-col items-end gap-0.5">
                                  <span
                                    className={`font-mono tabular-nums font-bold text-sm text-${cumpleTone}`}
                                    title={`Cubrió ${formatDurationHM(comp!.cubiertoSec ?? 0)} de ${formatDurationHM(comp!.horarioNetoSec)} de horario. NO se descuenta el estar quieta (puede estar en una llamada).`}
                                  >
                                    {pct}%
                                  </span>
                                  <span className="text-[10px] text-muted-foreground tabular-nums">
                                    cubrió {formatDurationHM(comp!.cubiertoSec ?? 0)} de {formatDurationHM(comp!.horarioNetoSec)}
                                  </span>
                                </div>
                              )
                            ) : (
                              <span
                                className={`font-mono tabular-nums font-bold text-sm ${workedSec == null ? 'text-muted-foreground' : 'text-success'}`}
                                title="Horas trabajadas del rango (evidencia de acciones)."
                              >
                                {workedSec == null ? '—' : formatDurationHM(workedSec)}
                              </span>
                            )}
                          </td>
                          {/* EN EL CRM — conectada vs. sin señal. */}
                          <td className="text-right">
                            {a == null || (!a.active_seconds && !a.idle_seconds) ? (
                              <span className="font-mono text-muted-foreground text-xs" title="Sin registro de conexión en este rango.">—</span>
                            ) : (
                              <div className="inline-flex flex-col items-end gap-0.5">
                                <span
                                  className="font-mono tabular-nums text-xs font-bold text-foreground"
                                  title="Tiempo con el CRM abierto y con actividad de mouse o teclado."
                                >
                                  {formatDurationHM(a.active_seconds)}
                                </span>
                                {a.idle_seconds > 0 && (
                                  <span
                                    className="text-[10px] text-muted-foreground tabular-nums"
                                    title="Tiempo con el CRM abierto pero sin mouse ni teclado. OJO: en una llamada no se mueve el mouse, así que esto NO es tiempo perdido por sí solo."
                                  >
                                    {formatDurationHM(a.idle_seconds)} sin señal
                                  </span>
                                )}
                              </div>
                            )}
                          </td>
                          {/* ENTRÓ — hora + puntual / tarde. */}
                          <td className="text-right">
                            {isToday && turnoStart ? (
                              <span className="inline-flex items-center justify-end gap-1.5 flex-wrap font-mono tabular-nums text-xs">
                                <span className="inline-flex items-center gap-1 whitespace-nowrap text-foreground">
                                  <Clock size={11} className="text-muted-foreground" aria-hidden="true" />
                                  {formatTimeBogota(turnoStart)}
                                </span>
                                {comp && (comp.tardeMin ?? 0) > 0 ? (
                                  <span
                                    className="inline-flex items-center rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5 text-[10px] font-bold text-danger whitespace-nowrap"
                                    title={`Llegó ${formatDurationHM((comp.tardeMin ?? 0) * 60)} tarde respecto al inicio del horario.`}
                                  >
                                    {formatDurationHM((comp.tardeMin ?? 0) * 60)} tarde
                                  </span>
                                ) : (
                                  <span className="text-[10px] text-success font-semibold">puntual</span>
                                )}
                              </span>
                            ) : turnoStart ? (
                              // En rangos de varios días SÍ hay dato: es la primera
                              // señal del período. Antes se bloqueaba a Hoy y la
                              // columna quedaba muerta en 7d/30d aunque el servidor
                              // mandara el valor. Va con fecha, porque una hora
                              // suelta en un rango no dice de qué día es. No se
                              // emite juicio de puntualidad: eso necesita el horario
                              // de UN día concreto.
                              <span className="font-mono tabular-nums text-xs text-foreground whitespace-nowrap">
                                {formatDateTimeBogota(turnoStart)}
                              </span>
                            ) : (
                              <span className="font-mono text-muted-foreground text-xs" title="Sin ninguna señal en este rango.">—</span>
                            )}
                          </td>
                          {/* SALIÓ — hora + en línea / salió antes. */}
                          <td className="text-right">
                            {isToday && turnoEnd ? (
                              <span className="inline-flex items-center justify-end gap-1.5 flex-wrap font-mono tabular-nums text-xs">
                                <span className="inline-flex items-center gap-1 whitespace-nowrap text-foreground">
                                  <Clock size={11} className="text-muted-foreground" aria-hidden="true" />
                                  {formatTimeBogota(turnoEnd)}
                                </span>
                                {enLinea ? (
                                  <span
                                    className="inline-flex items-center rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-[10px] font-bold text-success whitespace-nowrap"
                                    title="Sigue activa ahora (señal hace menos de 10 min)."
                                  >
                                    en línea
                                  </span>
                                ) : comp && (comp.tempranoMin ?? 0) > 0 ? (
                                  <span
                                    className="inline-flex items-center rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5 text-[10px] font-bold text-danger whitespace-nowrap"
                                    title={`Se fue ${formatDurationHM((comp.tempranoMin ?? 0) * 60)} antes del fin del horario.`}
                                  >
                                    {formatDurationHM((comp.tempranoMin ?? 0) * 60)} antes
                                  </span>
                                ) : null}
                              </span>
                            ) : turnoEnd ? (
                              // Última señal del período, con fecha. Sin juicio de
                              // "se fue antes": comparar contra el horario solo
                              // tiene sentido dentro de un día.
                              <span className="font-mono tabular-nums text-xs text-foreground whitespace-nowrap">
                                {formatDateTimeBogota(turnoEnd)}
                              </span>
                            ) : (
                              <span className="font-mono text-muted-foreground text-xs" title="Sin ninguna señal en este rango.">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          {/* "Sin actividad" — solo cuando NI hay productividad NI hay jornada.
              Antes mostraba este mensaje con rows=0 aunque hubiera pings,
              ocultando la sección Jornada. Ahora cubre solo el verdadero
              cero-y-cero. */}
          {rows.length === 0 && jornadaOps.length === 0 && (
            <div className="rounded-2xl border border-dashed border-border bg-card/40 p-10 text-center">
              <p className="text-sm font-semibold text-foreground mb-1">Sin actividad</p>
              <p className="text-xs text-muted-foreground">Nadie ha registrado acciones en {RANGE_LABELS[range].toLowerCase()}.</p>
            </div>
          )}

          {/* Top performer callout */}
          {leader && leader.confirmados > 0 && (
            <motion.div
              {...fadeUp(0.1)}
              className="relative overflow-hidden rounded-2xl border border-accent/32 bg-accent/12 glow-accent shadow-card3d px-4 py-3 flex items-center gap-3"
            >
              <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-accent-gradient" aria-hidden="true" />
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-accent/30 bg-accent/20 glow-accent">
                <Trophy size={17} className="text-accent" aria-hidden="true" strokeWidth={2.25} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="hud-label">
                  Top operadora — {RANGE_LABELS[range].toLowerCase()}
                </div>
                {/* El nombre de la operadora es DATO, no rótulo: va sin hud-label
                    (que mayusculiza). */}
                <div className="text-sm font-bold text-foreground truncate mt-0.5">{leader.display_name}</div>
              </div>
              {/* La cifra manda: cuenta al entrar, como en el Dashboard. */}
              <div className="shrink-0 text-right">
                <div className="text-2xl font-bold leading-none text-accent num-glow-accent">
                  <CountUp value={leader.confirmados} />
                </div>
                <div className="hud-label mt-1.5">confirmados</div>
              </div>
              <div className="shrink-0 text-right border-l border-accent/25 pl-3">
                <div className="text-2xl font-bold leading-none text-foreground font-mono tabular-nums">
                  {(() => {
                    const t = confRateBySample(leader.confirmados, leader.cancelados).tasa;
                    return t == null ? '—' : `${t}%`;
                  })()}
                </div>
                <div className="hud-label mt-1.5">confirmación</div>
              </div>
            </motion.div>
          )}

          {/* Las secciones de outcome (Confirmar / Seguimiento / Rescate /
              Novedades) se muestran SIEMPRE que haya alguien en el período.

              Antes se ocultaban enteras con `rows.length > 0` para no dibujar
              tablas vacías. El efecto real era peor: el dueño abría
              Productividad un día tranquilo, veía solo la Jornada y creía que
              las secciones se habían perdido. Ahora se muestran con un estado
              vacío explícito — "existe y hoy no hay datos" se lee distinto de
              "ya no está". */}
          {rows.length === 0 && jornadaOps.length > 0 && (
            <div className="rounded-2xl border border-dashed border-border bg-card/40 p-6 text-center">
              {/* Dos situaciones MUY distintas que antes se leían igual. El
                  cartel viejo decía siempre "Todavía sin gestiones", así que un
                  día en que sí hubo trabajo (pero de un admin, que no se cuenta
                  acá) se leía como "el CRM está roto". Ahora se dicen aparte. */}
              {accionesPeriodo != null && accionesPeriodo > 0 ? (
                <>
                  <p className="text-sm font-semibold text-foreground mb-1">
                    Hubo {accionesPeriodo} {accionesPeriodo === 1 ? 'gestión' : 'gestiones'} en{' '}
                    {RANGE_LABELS[range].toLowerCase()}, pero ninguna de una operadora
                  </p>
                  <p className="text-xs text-muted-foreground">
                    El CRM sí está registrando. Esta tabla mide solo a las operadoras: las
                    acciones de administradores (las tuyas) quedan afuera a propósito, para
                    no mezclarlas con la productividad del equipo.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm font-semibold text-foreground mb-1">
                    Ninguna gestión registrada en {RANGE_LABELS[range].toLowerCase()}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {accionesPeriodo === 0
                      ? 'Nadie marcó pedidos en el CRM en este período — ni operadoras ni administradores. La Jornada de arriba muestra quién entró.'
                      : 'Las tablas de Confirmar, Seguimiento y Novedades aparecen acá apenas el equipo registre la primera acción. La Jornada de arriba ya muestra quién entró.'}
                  </p>
                </>
              )}
            </div>
          )}

          {rows.length > 0 && <>

          {/* Confirmar — el `note` muestra la COBERTURA DEL EQUIPO (cuánto del
              inflow del período alcanzó a resolver el equipo). La tasa POR
              OPERADORA de la tabla es la MADURA (conf ÷ resueltos), separada del
              volumen del equipo — antes se mezclaba (conf ÷ entrantes = 83%) y
              confundía. Ver src/lib/confirmationRate.ts. */}
          <Section
            title="Confirmar"
            tone="success"
            icon={CheckCircle2}
            note={
              entrantes > 0
                ? `Entraron ${entrantes} → gestionó ${teamAtendidos} → contactó ${teamContactados} → confirmó ${teamConf} = ${teamTasaDia}% del día`
                : 'Resultados del flujo de confirmación de pedidos'
            }
          >
            {/* Mini-glosario: que se entienda cada KPI de un vistazo. Se
                amplió en v4 (2026-05-28) con "Intentos N/R" y "Faltan" — el
                operador veía 0 en N/R y creía que no estaba registrando, pero
                la N/R original solo cuenta los que SIGUEN sin contestar.
                Intentos N/R muestra el esfuerzo real (incluye los que después
                confirmaron) y Faltan dice cuántos pedidos del período NADIE
                tocó todavía. */}
            <div className="px-4 py-2.5 border-b border-border/60 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
              <span><strong className="text-foreground">Atendidos</strong>: pedidos distintos que gestionó</span>
              <span><strong className="text-foreground">Intentos N/R</strong>: no contestaron al menos 1 vez (aunque después confirmó)</span>
              <span><strong className="text-foreground">N/R abiertos</strong>: sigue sin contestar al cierre del período</span>
              <span><strong className="text-foreground">Contactó del día</strong>: de lo que entró, a cuántos contactó · faltan = por contactar</span>
              <span><strong className="text-foreground">Confirmación del día</strong>: confirmados ÷ lo que entró · meta ~{CONF_DIA_TARGET_PCT}%</span>
              <span><strong className="text-foreground">Clientes/h</strong>: clientes reales (contestaron) ÷ horas trabajadas · producción</span>
              <span><strong className="text-foreground">Intentos/h</strong>: TODAS las marcadas (incl. no-contestó) ÷ horas · esfuerzo · 🔴 debajo de {MIN_INTENTOS_POR_HORA}/h</span>
              <span className="opacity-70">gris "· en curso" = el día aún no se trabajó completo, provisional</span>
            </div>

            {/* Alerta de FUGA Shopify→Dropi: ventas que nunca entraron al flujo de
                confirmación. Es un llamado de atención del turno (debería ser 0). */}
            {shopifyPending.data?.configured !== false && (shopifyPending.data?.pendingCount ?? 0) > 0 && (
              <div className="px-4 py-2.5 border-b border-danger/30 bg-danger/8 flex items-center gap-3">
                <ShoppingBag size={16} className="text-danger shrink-0" aria-hidden="true" />
                <div className="flex-1 min-w-0 text-xs">
                  <span className="font-bold text-danger tabular-nums">{shopifyPending.data!.pendingCount}</span>
                  <span className="text-foreground font-semibold"> venta{shopifyPending.data!.pendingCount === 1 ? '' : 's'} sin pasar a Dropi</span>
                  <span className="text-muted-foreground">
                    {' '}(últimos {shopifyPending.data!.days ?? 7}d
                    {typeof shopifyPending.data!.todayPending === 'number' ? ` · ${shopifyPending.data!.todayPending} hoy` : ''})
                    {' '}— entraron a Shopify pero nunca llegaron al flujo de confirmación. Deberían estar en 0: subilas desde <strong className="text-foreground">Confirmar → "Subir todos"</strong>.
                  </span>
                </div>
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="w-10">#</th>
                    <th>Operadora</th>
                    <th className="text-right">Conf.</th>
                    <th className="text-right">Canc.</th>
                    <th
                      className="text-right"
                      title="Clientes DISTINTOS que no contestaron en el período, aunque después se cerraran. Es la MISMA métrica de 'no respondió' que muestra el banner de Confirmar y el cierre de la operadora (todos cuadran)."
                    >
                      No contestó
                    </th>
                    <th
                      className="text-right"
                      title="Detalle admin: de los que no contestaron, cuántos AÚN quedan sin cerrar (sin conf/canc posterior). Métrica de estado actual, distinta de 'No contestó' (esfuerzo)."
                    >
                      Sin cerrar aún
                    </th>
                    <th className="text-right">Atendidos</th>
                    <th
                      className="text-right"
                      title="De TODO lo que entró en el período, a cuántos logró contactar (contestaron: confirmaron o cancelaron). El resto son los que faltan por contactar (no contestaron + sin tocar). Sobre lo que entró, no sobre lo que atendió."
                    >
                      Contactó del día
                    </th>
                    <th
                      className="text-right"
                      title="Confirmados ÷ lo que ENTRÓ en el período — cómo va el día. Meta ~55% (confirmar 85 de cada 100 que entran es imposible: los que no contestan bajan el techo). Gris '· en curso' = el día aún no se trabajó completo, no concluyente. La efectividad de cierre (÷ resueltos, meta 85%) está en el tooltip de cada celda."
                    >
                      Confirmación del día
                    </th>
                    <th
                      className="text-right"
                      title="Clientes REALES atendidos por hora trabajada (confirmados + cancelados ÷ horas). Es la PRODUCCIÓN real — los que sí contestaron. No cuenta los 'no contestó' (llamadas en frío, rápidas). Informativo: un día malo de no-contesta baja esto sin ser su culpa, por eso no se pinta rojo."
                    >
                      Clientes/h
                    </th>
                    <th
                      className="text-right"
                      title={`Intentos de marcado por hora trabajada (TODAS las llamadas, incl. 'no contestó'). Es el ESFUERZO: aunque no le contesten, si sigue marcando el número se mantiene alto. 🔴 solo si baja de ${MIN_INTENTOS_POR_HORA}/hora = casi no marca. '—' si trabajó menos de 30 min.`}
                    >
                      Intentos/h
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, idx) => (
                    <tr key={r.operator_id}>
                      <td>
                        <span className="font-mono text-[11px] font-bold tabular-nums text-muted-foreground">
                          {String(idx + 1).padStart(2, '0')}
                        </span>
                      </td>
                      <td className="font-semibold text-foreground">
                        <span className="inline-flex items-center gap-1.5 flex-wrap">
                          {r.display_name}
                          {/* Alerta de gestión: lleva 2h+ de jornada con CERO
                              confirmaciones y hay cola. Cruza con la fila de
                              actividad (startedAt) — sin dato de jornada para
                              esta operadora, no se alerta. SOLO en 'today':
                              en 7d/30d startedAt es MIN() del rango y conf es
                              multi-día → daría "⚠ 167h sin confirmar". */}
                          {(() => {
                            if (!isToday) return null;
                            const act = activityByOp.get(r.operator_id);
                            const started = act?.first_action_at ?? null;
                            if (!shouldAlertSinConfirmar({
                              conf: r.confirmados,
                              entrantes,
                              pendientesSinTocar: r.pendientes_sin_tocar,
                              startedAt: started,
                              nowMs,
                            })) return null;
                            const horas = Math.floor((nowMs - Date.parse(started as string)) / 3600000);
                            return (
                              <span
                                className="inline-flex items-center rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5 text-[10px] font-bold text-danger tabular-nums whitespace-nowrap"
                                title="0 confirmaciones desde que empezó, con pedidos en cola"
                              >
                                ⚠ {horas}h sin confirmar
                              </span>
                            );
                          })()}
                        </span>
                      </td>
                      <td className="text-right font-mono tabular-nums text-success font-semibold">{r.confirmados}</td>
                      <td className="text-right font-mono tabular-nums text-danger font-semibold">{r.cancelados}</td>
                      {/* Intentos N/R — si la migration v4 no se aplicó vendrá
                          undefined → mostramos '—' en gris para no engañar. */}
                      <td className="text-right font-mono tabular-nums text-warning font-semibold">
                        {r.intentos_noresp == null
                          ? <span className="text-muted-foreground">—</span>
                          : r.intentos_noresp}
                      </td>
                      <td className="text-right font-mono tabular-nums text-muted-foreground">{r.noresp}</td>
                      <td className="text-right font-mono tabular-nums">{r.total_atendidos}</td>
                      <td className="text-right">{(() => {
                        // "Contactó del día" = contactados ÷ lo que ENTRÓ (÷inflow), no
                        // ÷atendidos. Contactados = confirmados + cancelados (contestaron
                        // y decidieron). Faltan por contactar = entrantes − contactados
                        // (= no contestaron + sin tocar). Misma lógica que confirmación.
                        const contactados = r.confirmados + r.cancelados;
                        // Topado en 100%: si contactó pedidos viejos además de los de hoy,
                        // "faltan 0" ya dice que terminó lo que entró (nada de 140%).
                        const pct = entrantes > 0 ? Math.min(100, Math.round((contactados / entrantes) * 100)) : null;
                        const faltan = Math.max(0, entrantes - contactados);
                        const sinTocar = Math.max(0, entrantes - r.total_atendidos);
                        const tip = `Contactó a ${contactados} de ${entrantes} que entraron · faltan ${faltan} por contactar (${r.noresp} no contestaron + ${sinTocar} sin tocar)`;
                        if (pct == null) return <span className="font-mono tabular-nums text-xs text-muted-foreground">—</span>;
                        return (
                          <span className="font-mono tabular-nums text-xs text-muted-foreground" title={tip}>
                            {pct}% <span className="opacity-70">· faltan {faltan}</span>
                          </span>
                        );
                      })()}</td>
                      <td className="text-right">{(() => {
                        // "Confirmación del día" = confirmados ÷ lo que ENTRÓ (÷inflow),
                        // NO ÷resueltos. Es "cómo va el día" y no infla: los que no
                        // contestó / no tocó tiran la tasa abajo. La efectividad de
                        // cierre (÷resueltos, la vieja) queda en el tooltip.
                        const cd = confRateByCohort(r.confirmados, r.cancelados, entrantes);
                        const ef = confRateBySample(r.confirmados, r.cancelados);
                        const metaTip = opsActivas > 1
                          ? ` Meta individual: ${metaPorOperadora}% (${CONF_DIA_TARGET_PCT}% del equipo ÷ ${opsActivas} operadoras activas).`
                          : '';
                        const tip = ef.tasa != null
                          ? `Efectividad de cierre: ${ef.tasa}% (${r.confirmados} de ${ef.resueltos} que decidieron). ${cd.pctProcesado}% del día trabajado.${metaTip}`
                          : `Sin pedidos resueltos aún.${metaTip}`;
                        if (cd.tasaDia == null) return <span className="font-mono tabular-nums text-xs text-muted-foreground" title={tip}>—</span>;
                        // SOLO en 'today' (día vivo) y con < 90% trabajado → provisional
                        // gris, NUNCA rojo: temprano en la jornada la tasa ÷inflow es baja
                        // solo porque falta trabajar. En 7d/30d es una ventana ya cerrada
                        // (la cola reciente pendiente es normal) → número firme vs meta.
                        if (isToday && cd.inmaduro) return (
                          <span className="font-mono tabular-nums text-xs text-muted-foreground" title={`Día en curso (${cd.pctProcesado}% trabajado) — provisional. ${tip}`}>
                            {Math.min(100, cd.tasaDia)}% <span className="opacity-70">· en curso</span>
                          </span>
                        );
                        return <span title={tip}><RateBar value={cd.tasaDia} target={metaPorOperadora} /></span>;
                      })()}</td>
                      {/* Clientes REALES por hora (conf+canc ÷ horas) — producción,
                          informativo (sin rojo: un día malo de no-contesta no es su culpa). */}
                      <td className="text-right">{(() => {
                        const worked = workedByOp.get(r.operator_id)?.worked_seconds;
                        const clientes = r.confirmados + r.cancelados;
                        const cph = gestionesPorHora(clientes, worked);
                        if (cph == null) {
                          return <span className="font-mono tabular-nums text-xs text-muted-foreground" title="Sin suficiente trabajo (30 min+) para medir">—</span>;
                        }
                        return (
                          <span className="font-mono tabular-nums text-xs text-foreground"
                            title={`${clientes} clientes atendidos (contestaron) ÷ ${formatDurationHM(worked)} trabajadas`}>
                            {cph.toFixed(1)}/h
                          </span>
                        );
                      })()}</td>
                      {/* Intentos por hora (esfuerzo, incl. no-contestó) — acá vive el 🔴. */}
                      <td className="text-right">{(() => {
                        const worked = workedByOp.get(r.operator_id)?.worked_seconds;
                        const intentos = r.intentos_total ?? r.total_atendidos;
                        const iph = gestionesPorHora(intentos, worked);
                        if (iph == null) {
                          return <span className="font-mono tabular-nums text-xs text-muted-foreground" title="Sin suficiente trabajo (30 min+) para medir el ritmo">—</span>;
                        }
                        const tone = ritmoTone(iph, MIN_INTENTOS_POR_HORA);
                        const toneClass = tone === 'muted' ? 'text-muted-foreground' : `text-${tone}`;
                        return (
                          <span className={`font-mono tabular-nums text-xs font-semibold ${toneClass}`}
                            title={`${intentos} intentos de marcado ÷ ${formatDurationHM(worked)} trabajadas. 🔴 debajo de ${MIN_INTENTOS_POR_HORA}/hora (casi no marca). Incluye los 'no contestó', así un día duro no te castiga.`}>
                            {iph.toFixed(1)}/h
                          </span>
                        );
                      })()}</td>
                    </tr>
                  ))}
                  {/* Fila TOTAL del equipo. `pendientes_sin_tocar` es GLOBAL
                      del store — vale lo mismo para todos los rows (entrantes
                      − atendidos del operador, pero el dato que importa al
                      Manager es cuántos no tocó NADIE). Lo leemos como el
                      máximo entre rows: si todos los operadores tienen el
                      mismo inflow, el max == min == el valor real. */}
                  {(() => {
                    const totConf = rows.reduce((a, r) => a + r.confirmados, 0);
                    const totCanc = rows.reduce((a, r) => a + r.cancelados, 0);
                    const totNoresp = rows.reduce((a, r) => a + r.noresp, 0);
                    const totAt = rows.reduce((a, r) => a + r.total_atendidos, 0);
                    const intentosDefined = rows.some(r => r.intentos_noresp != null);
                    const totIntentos = rows.reduce((a, r) => a + (r.intentos_noresp ?? 0), 0);
                    // Faltan = entrantes globales − atendidos POR EL EQUIPO.
                    // pendientes_sin_tocar de v4 es por-operador, así que
                    // usamos la fórmula directa: entrantes − sum(atendidos).
                    // Si total_entrantes está disponible y > 0, mostramos.
                    const faltan = Math.max(0, entrantes - totAt);
                    // Contactó del día del EQUIPO = contactados ÷ entrantes.
                    const totContactados = totConf + totCanc;
                    const pctContactoTeam = entrantes > 0 ? Math.min(100, Math.round((totContactados / entrantes) * 100)) : null;
                    const faltanContactar = Math.max(0, entrantes - totContactados);
                    const contactoTone = faltanContactar === 0 ? 'success' : faltanContactar < entrantes / 2 ? 'warning' : 'danger';
                    // Ritmo del EQUIPO sobre horas TRABAJADAS (evidencia): clientes
                    // reales (info) + intentos (esfuerzo, donde vive el 🔴).
                    const totWorked = rows.reduce((a, r) => a + (workedByOp.get(r.operator_id)?.worked_seconds ?? 0), 0);
                    const totClientes = totConf + totCanc;
                    const totIntentosMarcado = rows.reduce((a, r) => a + (r.intentos_total ?? r.total_atendidos), 0);
                    const cphTeam = gestionesPorHora(totClientes, totWorked);
                    const iphTeam = gestionesPorHora(totIntentosMarcado, totWorked);
                    const iphTeamTone = iphTeam == null ? 'muted-foreground' : ritmoTone(iphTeam, MIN_INTENTOS_POR_HORA) === 'muted' ? 'muted-foreground' : ritmoTone(iphTeam, MIN_INTENTOS_POR_HORA);
                    // Confirmación del día del EQUIPO = confirmados ÷ entrantes,
                    // con la misma madurez que las filas (día en curso → provisional).
                    const cdTeam = confRateByCohort(totConf, totCanc, entrantes);
                    // "en curso" gris solo en 'today' (día vivo); en 7d/30d firme.
                    const teamEnCurso = isToday && cdTeam.inmaduro;
                    const diaTone = teamEnCurso ? 'muted-foreground'
                      : cdTeam.tasaDia == null ? 'muted-foreground'
                      : isBelowDailyTarget(cdTeam.tasaDia) ? (cdTeam.tasaDia >= CONF_DIA_TARGET_PCT - 5 ? 'warning' : 'danger')
                      : 'success';
                    return (
                      <tr className="border-t-2 border-border bg-muted/30 font-bold">
                        <td></td>
                        <td className="text-foreground uppercase text-[11px] tracking-wider">Total equipo</td>
                        <td className="text-right font-mono tabular-nums text-success">{totConf}</td>
                        <td className="text-right font-mono tabular-nums text-danger">{totCanc}</td>
                        <td className="text-right font-mono tabular-nums text-warning">
                          {intentosDefined ? totIntentos : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="text-right font-mono tabular-nums text-muted-foreground">{totNoresp}</td>
                        <td className="text-right font-mono tabular-nums">{totAt}</td>
                        {/* Contactó del día del equipo = contactados ÷ entrantes + faltan por contactar. */}
                        <td className="text-right">
                          {pctContactoTeam == null
                            ? <span className="font-mono tabular-nums text-xs text-muted-foreground">—</span>
                            : (
                              <span
                                className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-bold tabular-nums border-${contactoTone}/30 bg-${contactoTone}/10 text-${contactoTone}`}
                                title={`Contactó a ${totContactados} de ${entrantes} que entraron · faltan ${faltanContactar} por contactar (${faltan} de ellos sin tocar todavía).`}
                              >
                                {pctContactoTeam}% · faltan {faltanContactar}
                              </span>
                            )}
                        </td>
                        {/* Confirmación del día del equipo = confirmados ÷ entrantes vs meta ~55% */}
                        <td className="text-right">
                          {cdTeam.tasaDia == null
                            ? <span className="font-mono tabular-nums text-xs text-muted-foreground">—</span>
                            : (
                              <span
                                className={`font-mono tabular-nums text-sm text-${diaTone}`}
                                title={teamEnCurso
                                  ? `Día en curso (${cdTeam.pctProcesado}% trabajado) — provisional. Meta del día ~${CONF_DIA_TARGET_PCT}%.`
                                  : `${totConf} confirmados de ${entrantes} que entraron. Meta del día ~${CONF_DIA_TARGET_PCT}%.`}
                              >
                                {Math.min(100, cdTeam.tasaDia)}%{teamEnCurso ? ' ·en curso' : ''}
                              </span>
                            )}
                        </td>
                        {/* Clientes reales/hora del equipo (info). */}
                        <td className="text-right">
                          {cphTeam == null
                            ? <span className="font-mono tabular-nums text-xs text-muted-foreground">—</span>
                            : <span className="font-mono tabular-nums text-sm text-foreground"
                                title={`${totClientes} clientes atendidos del equipo ÷ ${formatDurationHM(totWorked)} trabajadas`}>
                                {cphTeam.toFixed(1)}/h
                              </span>}
                        </td>
                        {/* Intentos/hora del equipo (esfuerzo, donde vive el 🔴). */}
                        <td className="text-right">
                          {iphTeam == null
                            ? <span className="font-mono tabular-nums text-xs text-muted-foreground">—</span>
                            : <span className={`font-mono tabular-nums text-sm font-semibold text-${iphTeamTone}`}
                                title={`${totIntentosMarcado} intentos del equipo ÷ ${formatDurationHM(totWorked)} trabajadas. 🔴 debajo de ${MIN_INTENTOS_POR_HORA}/hora.`}>
                                {iphTeam.toFixed(1)}/h
                              </span>}
                        </td>
                      </tr>
                    );
                  })()}
                </tbody>
              </table>
            </div>
          </Section>

          {/* Seguimiento */}
          <Section title="Seguimiento" tone="info" icon={Activity} note="Touchpoints marcados sobre pedidos en seguimiento">
            <ResolutionTable
              rows={rows}
              acciones={r => r.seg_acciones}
              resueltos={r => r.seg_resueltos}
              pedidos={r => r.seg_pedidos}
              resueltosDist={r => r.seg_resueltos_dist}
              actionTone="info"
            />
          </Section>

          {/* Novedades — ocupa el lugar de la vieja sección "Rescate" (módulo
              eliminado del CRM). Siempre visible; si nadie resolvió, empty state. */}
          <Section title="Novedades" tone="warning" icon={AlertTriangle} note="Novedades de transportadora resueltas">
            {rows.some(r => r.novedades_resueltas > 0) ? (
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="w-10">#</th>
                      <th>Operadora</th>
                      <th className="text-right">Resueltas</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.filter(r => r.novedades_resueltas > 0).map((r, idx) => (
                      <tr key={r.operator_id}>
                        <td>
                          <span className="font-mono text-[11px] font-bold tabular-nums text-muted-foreground">
                            {String(idx + 1).padStart(2, '0')}
                          </span>
                        </td>
                        <td className="font-semibold text-foreground">{r.display_name}</td>
                        <td className="text-right font-mono tabular-nums text-warning font-semibold">{r.novedades_resueltas}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                Nadie resolvió novedades en {RANGE_LABELS[range].toLowerCase()}.
              </div>
            )}
          </Section>

          </>}
        </>
      ) : null}

      {/* Bar chart comparativo — recharts con HSL vars del DS */}
      {!loading && rows.length > 0 && (
        <Section title="Comparativo Confirmados vs Cancelados" tone="accent" icon={BarChart3}>
          <div className="p-4">
            {/* Leyenda manual: swatch cuadrado, no le come alto al gráfico. */}
            <div className="flex items-center gap-3 flex-wrap mb-3">
              {[
                { color: CHART_SUCCESS, label: 'Confirmados' },
                { color: CHART_DANGER, label: 'Cancelados' },
              ].map(l => (
                <span key={l.label} className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: l.color }} aria-hidden="true" />
                  {l.label}
                </span>
              ))}
            </div>
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 8, right: 10, bottom: 5, left: -10 }}>
                  <BarGradientDefs
                    prefix="prodComp"
                    entries={[
                      { key: 'conf', color: CHART_SUCCESS },
                      { key: 'canc', color: CHART_DANGER },
                    ]}
                  />
                  <CartesianGrid {...CHART_GRID_PROPS} />
                  <XAxis
                    dataKey="name"
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={10}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={10}
                    allowDecimals={false}
                    tickLine={false}
                    axisLine={false}
                    width={36}
                  />
                  <Tooltip contentStyle={CHART_TOOLTIP_STYLE} cursor={CHART_BAR_CURSOR} />
                  {/* Solo la serie "buena" lleva glow — la lectura es inmediata. */}
                  <Bar dataKey="Confirmados" fill="url(#prodComp-conf)" radius={[6, 6, 0, 0]} style={barGlow(CHART_SUCCESS)} />
                  <Bar dataKey="Cancelados" fill="url(#prodComp-canc)" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </Section>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// Sub-components
// ──────────────────────────────────────────────────────────────

type SectionTone = keyof typeof TONE_CHIP;

/** Bloque de la pantalla. El punto de color de antes era la única señal de tono;
 *  ahora el tono vive en un chip de ícono con halo (misma anatomía que las cards
 *  del Dashboard) y el título va sobre un rótulo HUD. */
function Section({
  title, tone, icon: Icon, note, children,
}: {
  title: string;
  tone: SectionTone;
  icon: typeof Clock;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border bg-card/40 shadow-card3d hairline-top overflow-hidden transition-colors duration-200 hover:border-border-strong">
      <header className="px-4 py-3.5 border-b border-border/60 flex items-start gap-3">
        <span
          className={`w-9 h-9 rounded-xl border flex items-center justify-center shrink-0 ${TONE_CHIP[tone]}`}
          aria-hidden="true"
        >
          <Icon size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">{title}</h3>
          {note && <p className="text-[11px] text-muted-foreground mt-0.5">{note}</p>}
        </div>
      </header>
      {children}
    </section>
  );
}

function ResolutionTable({
  rows, acciones, resueltos, pedidos, resueltosDist, actionTone,
}: {
  rows: Row[];
  acciones: (r: Row) => number;
  resueltos: (r: Row) => number;
  /** Pedidos distintos tocados (base correcta de la tasa). Si no viene → fallback. */
  pedidos?: (r: Row) => number | undefined;
  /** Pedidos distintos resueltos. Si no viene → fallback. */
  resueltosDist?: (r: Row) => number | undefined;
  actionTone: 'info' | 'danger';
}) {
  return (
    <div className="overflow-x-auto">
      <table className="data-table">
        <thead>
          <tr>
            <th className="w-10">#</th>
            <th>Operadora</th>
            <th className="text-right" title="Touchpoints totales (esfuerzo). Un pedido gestionado varios días suma varias acciones.">Acciones</th>
            <th className="text-right">Resueltos</th>
            <th className="text-right" title="Pedidos distintos tocados que aún no se cierran (Resuelto/Devolución).">Pendientes</th>
            <th className="text-right" title="Resueltos ÷ pedidos distintos tocados (NO sobre acciones — los reintentos no inflan el denominador).">Tasa de resolución</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => {
            const acc = acciones(r);
            // Base de la tasa = pedidos DISTINTOS si la RPC los devuelve; si no
            // (migración sin aplicar), fallback al conteo de acciones (comportamiento viejo).
            const pedDist = pedidos?.(r);
            const resDist = resueltosDist?.(r);
            const hasDistinct = pedDist != null && resDist != null;
            const denom = hasDistinct ? (pedDist as number) : acc;
            const res = hasDistinct ? (resDist as number) : resueltos(r);
            const pendientes = Math.max(0, denom - res);
            const tasa = denom > 0 ? Math.round((res / denom) * 100) : 0;
            return (
              <tr key={r.operator_id}>
                <td>
                  <span className="font-mono text-[11px] font-bold tabular-nums text-muted-foreground">
                    {String(idx + 1).padStart(2, '0')}
                  </span>
                </td>
                <td className="font-semibold text-foreground">{r.display_name}</td>
                <td className={`text-right font-mono tabular-nums font-semibold ${actionTone === 'info' ? 'text-info' : 'text-danger'}`}>
                  {acc}
                </td>
                <td className="text-right font-mono tabular-nums text-success font-semibold">{res}</td>
                <td className="text-right font-mono tabular-nums text-muted-foreground">{pendientes}</td>
                {/* Tasa de RESOLUCIÓN (Seguimiento/Novedades) — NO es la
                    confirmación; mantiene su benchmark operativo (70%), no la
                    meta oficial de confirmación (CONF_TARGET_PCT). */}
                <td className="text-right"><RateBar value={tasa} target={70} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

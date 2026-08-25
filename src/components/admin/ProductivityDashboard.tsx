import { useEffect, useState, useCallback, useRef } from 'react';
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
import { confRateBySample, CONF_TARGET_PCT } from '@/lib/confirmationRate';
import { useActiveStoreId } from '@/contexts/StoreContext';
import { useShopifyPending } from '@/hooks/useShopifyPending';
import { ShoppingBag } from 'lucide-react';
import { formatTimeBogota, formatDateTimeBogota, formatDurationHM } from '@/lib/timeFormat';
import { shouldAlertSinConfirmar, asWorkedBlocks, sumWorkedSeconds, computeHorarioCompliance, UMBRAL_DESCONECTADA_MIN } from '@/lib/jornadaMath';
import { scheduleFromMinutes, DEFAULT_SCHEDULE, bogotaSecondsOfDay } from '@/lib/inactivityWindow';
import { minutosSinGestion, mayorHuecoEntreBloques, UMBRAL_SIN_GESTION_MIN } from '@/lib/huecosGestion';
import InactivityDetailModal from '@/components/admin/InactivityDetailModal';
import TeamNowStrip from '@/components/admin/TeamNowStrip';
import { useStoreSchedule } from '@/hooks/useStoreSchedule';
import { gestionesPorHora, ritmoTone, MIN_INTENTOS_POR_HORA } from '@/lib/operatorThroughput';
import { bogotaToday } from '@/lib/utils';
import { isRpcMissing } from '@/lib/rpcError';

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

/** Fila de operator_inactivity_stats — avisos de inactividad de la operadora en
 *  el período (cuántas veces se quedó +6 min quieta CON pedidos en cola, dentro
 *  de su horario, y cuántos minutos sumó eso). Es la señal de "tiempo perdido"
 *  que el dueño pidió ver. Se restauró tras quitarse el 18-jul (commit 5dd1db9). */
interface InactivityRow {
  operator_id: string;
  display_name: string;
  warnings_count: number;
  total_lost_seconds: number;
  last_warning_at: string | null;
}

// Sin '24h' rodante: las ventanas se alinean a día-calendario Bogotá (igual que
// el cohorte de Reportes Diarios) para que "entrantes" reconcilie entre vistas.
type Range = 'today' | '7d' | '30d';

interface Row {
  operator_id: string;
  display_name: string;
  confirmados: number;
  /** Confirmados SOLO de pedidos que entraron en el período (mismo cohorte que
   *  total_entrantes). Es el numerador correcto del aro "confirmación del día":
   *  así nunca pasa de 100%. Opcional: si la RPC desplegada aún no lo devuelve,
   *  el cliente cae a `confirmados` (crudo) y el tope de 100% protege la vista. */
  confirmados_cohorte?: number;
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

/** Etiquetas CORTAS de los botones del selector. Antes se renderizaba la clave
 *  interna ('today'/'7d') — inglés técnico en la pantalla con la que el dueño
 *  paga. Las largas de RANGE_LABELS quedan para el subtítulo. */
const RANGE_BTN: Record<Range, string> = {
  'today': 'Hoy',
  '7d': '7 días',
  '30d': '30 días',
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
  const [inactivityRows, setInactivityRows] = useState<InactivityRow[]>([]);
  // Operadora cuyo detalle de avisos está abierto. Va con el operator_id (no
  // solo el nombre): la tabla contó los avisos por id, y buscar el detalle por
  // display_name se rompía con perfiles sin nombre u homónimas.
  const [inactivityDetail, setInactivityDetail] = useState<{ id: string; name: string } | null>(null);
  // Aviso visible si falló alguna consulta de Jornada (actividad/horas/inactividad).
  const [jornadaWarn, setJornadaWarn] = useState<string | null>(null);
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
  // Cierre de turno por operadora (el ÚLTIMO del período). El dueño pidió que
  // "SALIÓ" sea el cierre de turno y no la última señal: una asesora que sigue
  // trabajando por teléfono con el navegador cerrado no "salió" a esa hora.
  // Sin cierre se muestra vacío + etiqueta — decisión suya: prefiere ver quién
  // no cerró antes que un número estimado.
  const [closingByOp, setClosingByOp] = useState<Record<string, string>>({});
  // La consulta de cierres FALLÓ (≠ "nadie cerró"). Sin esta distinción, un blip
  // de red/RLS pintaba "sin cierre" a TODAS las operadoras como si fuera un dato
  // medido — acusación falsa en la pantalla con la que el dueño evalúa al equipo.
  const [closingError, setClosingError] = useState(false);

  // Fuga Shopify→Dropi: ventas que entraron a Shopify pero NUNCA pasaron a Dropi
  // (no entran al flujo de confirmación → plata que se pierde en silencio). Es
  // responsabilidad del turno dejarla en 0. Store-scoped, cacheado 60s. Si no hay
  // Shopify configurado, el hook devuelve configured:false → no mostramos nada.
  const activeStoreId = useActiveStoreId();
  const shopifyPending = useShopifyPending(activeStoreId);
  // Horario laboral de la tienda (excluye almuerzo) → base de "En su puesto".
  const { data: scheduleMin } = useStoreSchedule(activeStoreId);
  const schedule = scheduleMin ? scheduleFromMinutes(scheduleMin) : DEFAULT_SCHEDULE;

  // Tienda de la corrida MÁS RECIENTE de load(). Las 4 RPCs de abajo resuelven
  // su alcance server-side: una respuesta en vuelo de la tienda anterior NO se
  // puede aterrizar bajo el encabezado de la nueva (mezclar países está
  // prohibido) — mismo guard que useDataLoader.
  const runStoreRef = useRef<string | null>(null);
  // Última tienda para la que ya se confirmó profiles.active_store_id.
  const scopeStoreRef = useRef<string | null>(null);

  const load = useCallback(async (silent = false) => {
    const runStore = activeStoreId;
    runStoreRef.current = runStore;
    if (!silent) setLoading(true);
    else setRefreshing(true);

    // _resolve_scope_store() lee profiles.active_store_id, y StoreContext dispara
    // ese UPDATE en un async que NO espera: al cambiar de tienda las RPCs podían
    // contestar con los números de la tienda ANTERIOR bajo el encabezado de la
    // nueva. Acá se confirma el scope ANTES de preguntar (una sola vez por
    // tienda); si no se puede fijar, no se muestran números.
    if (runStore && scopeStoreRef.current !== runStore) {
      const { error: scopeErr } = await supabase.rpc('set_active_store' as never, { p_store_id: runStore } as never);
      if (runStoreRef.current !== runStore) return;
      // Si la RPC no está desplegada, degradamos como antes (best-effort): la
      // pantalla en blanco sería peor que el riesgo que veníamos corriendo. Un
      // error REAL (red, permisos) sí corta.
      if (scopeErr && !isRpcMissing(scopeErr)) {
        console.error('[productivity] set_active_store error', scopeErr);
        setError('No se pudo fijar la tienda activa en el servidor. No mostramos números para no mezclar tiendas — reintentá.');
        setRows([]); setActivityRows([]); setWorkedRows([]); setInactivityRows([]);
        setAccionesPeriodo(null); setClosingByOp({}); setClosingError(false); setJornadaWarn(null);
        setLoading(false); setRefreshing(false);
        return;
      }
      scopeStoreRef.current = runStore;
    }

    // El scope por tienda lo resuelve la RPC server-side vía
    // _resolve_scope_store() (admin → su tienda activa, profiles.active_store_id).
    // No pasamos p_store_id: así NO dependemos de que la migration del parámetro
    // esté aplicada (evita el PGRST202 "function ... does not exist").
    const [productivity, activity, worked, inactivity] = await Promise.all([
      supabase.rpc('operator_productivity_stats' as never, { p_range: range } as never),
      // Jornada — heartbeat de entrada/salida (operator_activity_stats). Si la
      // migration no se aplicó, capturamos el PGRST202 silencioso y la sección
      // sigue con lo que haya de evidencia de trabajo.
      supabase.rpc('operator_activity_stats' as never, { p_range: range } as never),
      // Evidencia de trabajo (operator_worked_blocks): da primera/última acción
      // marcada, respaldo de entrada/salida cuando no hay heartbeat.
      supabase.rpc('operator_worked_blocks' as never, { p_range: range } as never),
      // Avisos de inactividad (operator_inactivity_stats): cuántas veces cada
      // operadora se quedó +6 min quieta CON cola, dentro de su horario. Es el
      // "cuánto tiempo perdió" que pidió el dueño. Error silencioso como los otros.
      supabase.rpc('operator_inactivity_stats' as never, { p_range: range } as never),
    ]);
    if (runStoreRef.current !== runStore) return;
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
    let cierresFallo = false;
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
      const { count, error: cntErr } = await supabase
        .from('order_results')
        .select('id', { count: 'exact', head: true })
        .eq('store_id', activeStoreId ?? '')
        .gte('result_date', desde)
        .lte('result_date', hoy);
      // supabase-js NO lanza en un SELECT fallido (resuelve con error en el
      // objeto), así que el try/catch no lo atrapa: sin este check un fallo de
      // red/RLS se mostraba como "0 medido" y el estado vacío afirmaba "Nadie
      // marcó pedidos" — el cero falso que este contador vino a evitar. Con
      // null, el cartel cae al texto genérico que no afirma nada.
      setAccionesPeriodo(cntErr ? null : (count ?? 0));
      if (runStoreRef.current !== runStore) return;

      // Cierres de turno del período. Nos quedamos con el MÁS RECIENTE por
      // operadora: en un rango de varios días la columna muestra el último.
      // Filtrado por tienda ACTIVA: un supervisor con membresía en CO y EC ve
      // por RLS los cierres de ambas — sin este filtro, su "SALIÓ" acá podía
      // ser el cierre del otro país (mezclar países está prohibido).
      const { data: cierres, error: cierresErr } = await supabase
        .from('operator_daily_reports')
        .select('user_id, closing_at')
        .eq('store_id', activeStoreId ?? '')
        .gte('report_date', desde)
        .lte('report_date', hoy)
        .not('closing_at', 'is', null)
        .order('closing_at', { ascending: false });
      if (runStoreRef.current !== runStore) return;
      // Mismo criterio que el contador de acciones de arriba: supabase-js no
      // lanza en un SELECT fallido, y sin este check el mapa vacío hacía que la
      // columna SALIÓ dijera "sin cierre" para TODAS — dato falso, no medición.
      if (cierresErr) {
        console.warn('[productivity] cierres query error', cierresErr);
        cierresFallo = true;
        setClosingByOp({});
      } else {
        const mapa: Record<string, string> = {};
        for (const c of (cierres ?? []) as { user_id: string; closing_at: string }[]) {
          if (!mapa[c.user_id]) mapa[c.user_id] = c.closing_at;
        }
        setClosingByOp(mapa);
      }
    } catch {
      setAccionesPeriodo(null);
      setClosingByOp({});
      cierresFallo = true;
    }
    setClosingError(cierresFallo);

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
    // Avisos de inactividad: mismo trato silencioso + limpieza. Si la RPC no está
    // (o falla), la columna "Sin trabajar" cae a '—' y el resto sigue.
    if (!inactivity.error) {
      setInactivityRows((inactivity.data as InactivityRow[] | null) ?? []);
    } else {
      setInactivityRows([]);
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[productivity] inactivity rpc error', inactivity.error);
      }
    }
    // Aviso VISIBLE cuando una consulta de jornada falla: antes se limpiaba en
    // silencio y, si fallaban las tres, la sección Jornada desaparecía sin decir
    // por qué → el dueño no distinguía "falló la consulta" de "nadie trabajó".
    const fallosJornada = [
      activity.error ? 'actividad' : null,
      worked.error ? 'horas trabajadas' : null,
      inactivity.error ? 'inactividad' : null,
      cierresFallo ? 'cierres de turno' : null,
    ].filter(Boolean);
    setJornadaWarn(fallosJornada.length
      ? `No se pudo leer: ${fallosJornada.join(', ')}. La Jornada puede salir incompleta — NO significa que no trabajaron.`
      : null);
    setLoading(false);
    setRefreshing(false);
  }, [range, activeStoreId]);

  useEffect(() => { load(); }, [load]);

  // Realtime debounced 1s: cambios en orders/order_results/touchpoints de LA
  // TIENDA ACTIVA disparan un refetch silencioso. El filtro por store_id no es
  // solo ruido: sin él, el payload completo de las filas de OTRAS tiendas
  // (teléfonos, acciones) llegaba a este navegador por el socket.
  useEffect(() => {
    if (!activeStoreId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const debounced = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => load(true), 1000);
    };
    const storeFilter = `store_id=eq.${activeStoreId}`;
    const channel = supabase
      .channel(`admin-productivity-${activeStoreId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter: storeFilter }, debounced)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'order_results', filter: storeFilter }, debounced)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'touchpoints', filter: storeFilter }, debounced)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'operator_activity_daily', filter: storeFilter }, debounced)
      // Un aviso de inactividad nuevo aparece en vivo en la columna "Sin trabajar".
      .on('postgres_changes', { event: '*', schema: 'public', table: 'operator_inactivity_warnings', filter: storeFilter }, debounced)
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [load, activeStoreId]);

  // Cruce jornada ↔ productividad por operadora (para la alerta "sin confirmar"
  // en la tabla Confirmar). Si no hay fila de actividad, no se alerta.
  const activityByOp = new Map(activityRows.map(r => [r.operator_id, r]));
  const workedByOp = new Map(workedRows.map(r => [r.operator_id, r]));
  const inactivityByOp = new Map(inactivityRows.map(r => [r.operator_id, r]));
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
  // ── Números del DÍA a nivel EQUIPO ────────────────────────────────────────
  // "Confirmación del día" = lo que el equipo CONFIRMÓ ÷ lo que TRABAJÓ hoy
  // (gestionados = conf+canc+noresp, distintos). Es el número que el dueño quiere
  // ver: refleja los 71 que confirmó DE VERDAD (incluye pedidos viejos que estaban
  // pendientes), no solo los del cohorte que entró hoy. Denominador = trabajados,
  // NO "entraron": el equipo confirma más de lo que entra cuando limpia backlog,
  // así que ÷entraron daba un número más chico (26) que confundía al dueño.
  const entrantes = rows[0]?.total_entrantes ?? 0;                        // demanda del día (contexto)
  const teamConf = rows.reduce((a, r) => a + r.confirmados, 0);           // 71 — TODO lo confirmado hoy
  const teamCanc = rows.reduce((a, r) => a + r.cancelados, 0);            // 1
  const teamNoresp = rows.reduce((a, r) => a + r.noresp, 0);             // 35
  const teamAtendidos = rows.reduce((a, r) => a + r.total_atendidos, 0);  // 107 — trabajados hoy
  const teamContactados = rows.reduce((a, r) => a + r.confirmados + r.cancelados, 0); // 72 — contestaron
  const teamSinTocar = Math.max(0, entrantes - teamAtendidos);           // demanda sin trabajar aún
  const teamTasaDia = teamAtendidos > 0 ? Math.round((teamConf / teamAtendidos) * 100) : 0; // 66%
  const teamTasaDiaGauge = Math.min(100, teamTasaDia);
  const heroTone = teamAtendidos === 0
    ? 'brand'
    : teamTasaDia >= CONF_TARGET_PCT
      ? 'success'
      : teamTasaDia >= CONF_TARGET_PCT - 5 ? 'warning' : 'danger';

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
                {RANGE_BTN[r]}
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

      {/* Pulso EN VIVO del equipo — reemplaza la vieja página /en-vivo, ahora
          embebida acá. Solo en 'Hoy': el "quién trabaja ahora" no tiene sentido
          mirando un rango pasado. Monta su propio hook (useLiveTeam) únicamente
          cuando se renderiza, así no dispara consultas en 7d/30d. */}
      {isToday && <TeamNowStrip />}

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
                  <div className="hud-label" title="Confirmados ÷ lo que el equipo TRABAJÓ (gestionados = contestaron + no contestaron), incluidos pedidos viejos que estaban pendientes. Es la misma Confirmación del día del Dashboard y del cierre del equipo (una sola matemática, meta 85%).">
                    Confirmación del día
                  </div>
                </div>

                <div className="flex justify-center py-4 tilt-layer-3">
                  <GaugeRing value={teamTasaDiaGauge} label="del día" size={190} tone={heroTone} />
                </div>

                <div className="tilt-layer-1">
                  <div className="flex items-center justify-between text-xs text-muted-foreground mb-1.5">
                    <span>Confirmó de lo que trabajó</span>
                    <span className="font-mono tabular-nums text-foreground">
                      <b>{teamConf}</b> / {teamAtendidos}
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
                      style={{ left: `${CONF_TARGET_PCT}%` }}
                      aria-hidden="true"
                      title={`Meta del día ~${CONF_TARGET_PCT}%`}
                    />
                  </div>
                </div>
              </TiltCard>

              {/* El embudo, tarjeta por tarjeta: cada paso pierde volumen contra
                  el anterior — la caída se ve sin leer. */}
              <div className="md:col-span-7 grid grid-cols-1 min-[390px]:grid-cols-2 gap-4">
                <StatTile
                  icon={Users}
                  label="Trabajó"
                  value={teamAtendidos}
                  tone="info"
                  title="Pedidos que el equipo GESTIONÓ hoy (confirmó + canceló + no contestó), incluidos los de días anteriores. Es la base del % del día."
                />
                <StatTile
                  icon={PhoneCall}
                  label="Contestaron"
                  value={teamContactados}
                  tone="warning"
                  title="De los que trabajó, cuántos contestaron y decidieron (confirmaron o cancelaron). El resto no contestó."
                />
                <StatTile
                  icon={CheckCircle2}
                  label="Confirmó"
                  value={teamConf}
                  tone="success"
                  title="TODO lo que el equipo confirmó hoy (incluye pedidos viejos que estaban pendientes). Es el mismo número que ves en Confirmar."
                />
                <StatTile
                  icon={Inbox}
                  label="Entraron hoy"
                  value={entrantes}
                  tone="accent"
                  title="Pedidos nuevos que entraron hoy (la demanda del día). Va aparte del %: el equipo también trabaja pedidos de días anteriores, por eso puede confirmar más de lo que entró."
                  extra={
                    <span className="font-mono tabular-nums text-[11px] font-medium text-muted-foreground">
                      {teamSinTocar} sin trabajar
                    </span>
                  }
                />
              </div>

              <p className="md:col-span-12 -mt-1 text-[11px] leading-relaxed text-muted-foreground">
                <strong className="text-foreground/80">Confirmación del día</strong> = de lo que el equipo
                gestionó hoy ({teamAtendidos}), cuánto confirmó ({teamConf}) = {teamTasaDiaGauge}% · meta {CONF_TARGET_PCT}%.
                Cuenta TODO lo confirmado hoy, sea el pedido nuevo o viejo (una sola matemática — la misma del
                Dashboard y del cierre del equipo). Para subirla, la palanca es recuperar los "no contestó".
              </p>
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
          {jornadaWarn && (
            <div className="rounded-2xl border border-warning/30 bg-warning/8 px-4 py-2.5 flex items-start gap-2.5 shadow-card3d" role="status">
              <AlertTriangle size={15} className="text-warning mt-0.5 shrink-0" aria-hidden="true" />
              <p className="text-xs text-foreground/90">{jornadaWarn}</p>
            </div>
          )}
          {jornadaOps.length > 0 && (
            <Section
              title="Jornada"
              tone="info"
              icon={Clock}
              note={isToday
                ? 'ENTRÓ = primera señal del día. SALIÓ = el CIERRE DE TURNO (si no cerró, dice "sin cierre" — no se inventa la hora). EN EL CRM = tiempo con el CRM abierto, y debajo cuánto del horario estuvo con el CRM cerrado. TRABAJANDO = horas con pedidos marcados (es un PISO: una llamada larga sin clic no cuenta). NO se descuenta el estar quieta — puede estar en una llamada.'
                : 'Del rango: tiempo con el CRM abierto, horas con evidencia de trabajo, promedio por pedido, y el último cierre de turno de cada operadora.'}
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
                        ? '¿Cuánto del horario cubrió? = desde que entró hasta que salió, dentro del horario de la tienda, menos el almuerzo. Mientras el día corre se mide contra el horario TRANSCURRIDO (no se le cobra la tarde que aún no llega); al terminar, contra el horario completo. NO se descuenta el estar quieta (una llamada no mueve el mouse).'
                        : 'Suma de las horas con evidencia de trabajo (pedidos marcados) en todos los días del rango. NO es lo mismo que el tiempo conectada: eso está en la columna de al lado.'}>
                        {isToday ? 'Cumplió horario' : 'Horas trabajadas'}
                      </th>
                      {/* Tiempo conectada / fuera. El dato venía del servidor
                          desde siempre (active_seconds / idle_seconds), estaba
                          declarado en el tipo y NO SE DIBUJABA en ningún lado:
                          llegaba a la pantalla y se tiraba. */}
                      <th className="text-right" title="Tiempo con el CRM ABIERTO (esté moviendo el mouse o no), y debajo cuánto del turno estuvo con el CRM cerrado. Estar quieta NO es estar ausente: en una llamada no se mueve el mouse.">
                        En el CRM
                      </th>
                      {/* TRABAJANDO — evidencia de marcado, no presencia. Es el
                          contrapeso de "En el CRM": una cosa es tener la pestaña
                          abierta y otra es estar gestionando pedidos. */}
                      <th className="text-right" title="Horas con evidencia de trabajo: bloques de pedidos marcados, cortando cuando pasan más de 15 minutos sin ninguna acción. OJO: es un PISO, no una medida exacta — una llamada larga que no termina en un clic no aparece acá.">
                        Trabajando
                      </th>
                      {/* SIN TRABAJAR — avisos de inactividad. Cuántas veces la
                          operadora se quedó +6 min quieta CON pedidos en cola,
                          dentro de su horario. Es el "cuánto me pierde" del dueño.
                          Clickeable → detalle por aviso. */}
                      <th className="text-right" title="Avisos de inactividad: cuántas veces se quedó más de 6 minutos sin ninguna acción TENIENDO pedidos en cola, dentro de su horario. Debajo, el total de minutos. Tocá el número para ver cada aviso con su hora. OJO: un rato quieta puede ser una llamada — es una señal para revisar, no una condena.">
                        Sin trabajar
                      </th>
                      {/* SIN GESTIONAR — huecos REALES sin marcar pedidos, no por
                          mouse. Arriba: hace cuánto no marca nada (en vivo).
                          Abajo: el peor hueco del día. Solo tiene sentido HOY.
                          Nació del reclamo del dueño (25-ago): "Sin trabajar"
                          mira el mouse y marcaba 0 con huecos de 30 min. */}
                      <th className="text-right" title="Basado en PEDIDOS marcados (no en el mouse). Arriba: hace cuánto no gestiona ningún pedido, en vivo. Abajo: el peor hueco del día (el rato más largo sin marcar nada, descontando almuerzo). OJO: una llamada larga también se ve como hueco — es para revisar, no para condenar.">
                        Sin gestionar
                      </th>
                      {/* MIN/INTENTO — sobre TODOS los intentos (incl. no
                          contestó), por decisión del dueño. */}
                      <th className="text-right" title="Promedio de minutos por pedido marcado = horas trabajando ÷ total de intentos (incluye los 'no contestó', que son rápidos). Sirve para comparar ritmo entre operadoras, no como estándar absoluto.">
                        Min/pedido
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
                      // Huecos SIN GESTIONAR (por pedidos marcados, no por mouse).
                      // Solo HOY: en 7d/30d los bloques cruzan días y el "hueco"
                      // sería la noche. `last_event` = última gestión real.
                      const sinGestionMin = isToday
                        ? minutosSinGestion(Date.parse(w?.last_event ?? '') || null, nowMs, schedule)
                        : null;
                      const peorHuecoMin = isToday
                        ? mayorHuecoEntreBloques(
                            blocks
                              .map((b) => ({ startMs: Date.parse(b.start), endMs: Date.parse(b.end) }))
                              .filter((b) => Number.isFinite(b.startMs) && Number.isFinite(b.endMs)),
                            schedule,
                          )
                        : null;
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
                      const comp = isToday ? computeHorarioCompliance({ turnoStart, turnoEnd, schedule, nowMs }) : null;
                      // % PRORRATEADO al horario TRANSCURRIDO (min(ahora, fin de
                      // horario)): este dashboard se mira EN VIVO y medir contra el
                      // día COMPLETO pintaba a operadoras puntuales en rojo (~21%)
                      // toda la mañana. Al terminar el horario, transcurrido = neto
                      // y el número coincide con la definición de fin de día.
                      const pct = comp?.cumplimientoPctTranscurrido ?? null;
                      const transcurridoSec = comp?.horarioTranscurridoSec ?? comp?.horarioNetoSec ?? null;
                      const horarioEnCurso = comp?.horarioTranscurridoSec != null
                        && comp.horarioTranscurridoSec < comp.horarioNetoSec;
                      // HORAS EXTRA por EVIDENCIA DE TRABAJO, no por presencia. El
                      // dueño lo pidió explícito: si dejó el CRM abierto y volvió 2h
                      // después solo a cerrarlo, eso NO es trabajo. Por eso el extra
                      // sale del ÚLTIMO PEDIDO MARCADO (w.last_event), no de la última
                      // señal (que incluye la pestaña abierta ociosa). Solo cuenta si
                      // marcó algo DESPUÉS del fin del horario pactado.
                      const lastWorkEventMs = Date.parse(w?.last_event ?? '') || 0;
                      const trabajoExtraMin = isToday && lastWorkEventMs > 0
                        ? Math.max(0, Math.round((bogotaSecondsOfDay(new Date(lastWorkEventMs)) - schedule.workEndSec) / 60))
                        : 0;
                      const cumpleTone = pct == null ? 'muted-foreground' : pct >= 90 ? 'success' : pct >= 70 ? 'warning' : 'danger';
                      // ¿Sigue en línea ahora? (última señal hace poco → no marca "salió antes").
                      const desconectadaMin = isToday && lastSignalMs > 0
                        ? Math.max(0, Math.floor((nowMs - lastSignalMs) / 60000))
                        : null;
                      const enLinea = desconectadaMin != null && desconectadaMin < UMBRAL_DESCONECTADA_MIN;
                      // EN EL CRM = pestaña abierta, MUEVA O NO el mouse. Antes
                      // esta columna mostraba solo `active_seconds` (mouse), que
                      // para una asesora telefónica es una fracción del tiempo
                      // que de verdad estuvo en el CRM.
                      const enCrmSec = a ? (Number(a.active_seconds) || 0) + (Number(a.idle_seconds) || 0) : null;
                      // FUERA DEL CRM = horario TRANSCURRIDO − tiempo con el CRM
                      // abierto. Contra el horario completo mostraba a media mañana
                      // "5:30 fuera" de horas que ni siquiera habían pasado. Solo
                      // tiene sentido contra un horario, así que es por-día.
                      const fueraSec = comp && enCrmSec != null
                        ? Math.max(0, (comp.horarioTranscurridoSec ?? comp.horarioNetoSec) - enCrmSec)
                        : null;
                      // MIN/PEDIDO sobre TODOS los intentos (incl. "no contestó"),
                      // por decisión del dueño. Denominador desde la RPC de
                      // productividad, emparejada por operator_id.
                      const prod = rows.find(r => r.operator_id === op.id);
                      const intentos = prod
                        ? (Number(prod.intentos_total) || Number(prod.total_atendidos) || 0)
                        : 0;
                      const minPorPedido = workedSec != null && workedSec > 0 && intentos > 0
                        ? workedSec / 60 / intentos
                        : null;
                      // SALIÓ = CIERRE DE TURNO. Sin cierre no se estima: se
                      // muestra vacío con etiqueta, para que se vea quién no cerró.
                      const cierreAt = closingByOp[op.id] ?? null;
                      // "Cerró X antes" se mide desde el CIERRE DE TURNO real, NO
                      // desde la última señal del CRM (comp.tempranoMin): puede
                      // pasar su última hora al teléfono sin tocar el CRM y sellar
                      // el cierre a las 17:01 — acusarla por la última señal era un
                      // falso positivo (y dejar la pestaña abierta lo escondía).
                      const cierreTempranoMin = isToday && cierreAt
                        ? Math.max(0, Math.round((schedule.workEndSec - bogotaSecondsOfDay(new Date(cierreAt))) / 60))
                        : 0;
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
                                    title={`Cubrió ${formatDurationHM(comp!.cubiertoSec ?? 0)} de ${formatDurationHM(transcurridoSec ?? comp!.horarioNetoSec)} de horario ${horarioEnCurso ? 'TRANSCURRIDO (el día sigue en curso — no se le cobra lo que aún no pasa)' : 'pactado'}. NO se descuenta el estar quieta (puede estar en una llamada).`}
                                  >
                                    {pct}%
                                  </span>
                                  <span className="text-[10px] text-muted-foreground tabular-nums">
                                    cubrió {formatDurationHM(comp!.cubiertoSec ?? 0)} de {formatDurationHM(transcurridoSec ?? comp!.horarioNetoSec)}{horarioEnCurso ? ' · en curso' : ''}
                                  </span>
                                  {/* Horas extra por TRABAJO REAL (marcó pedidos
                                      después del horario), no por dejar el CRM abierto.
                                      El % se topa en 100; el extra se muestra aparte. */}
                                  {trabajoExtraMin > 0 && (
                                    <span
                                      className="text-[10px] text-success tabular-nums font-semibold"
                                      title={`Marcó pedidos hasta ${formatDurationHM(trabajoExtraMin * 60)} después del fin del horario (trabajo real, no solo la pestaña abierta).`}
                                    >
                                      +{formatDurationHM(trabajoExtraMin * 60)} trabajó
                                    </span>
                                  )}
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
                          {/* EN EL CRM — pestaña abierta (mueva o no el mouse),
                              con el tiempo FUERA del CRM debajo. */}
                          <td className="text-right">
                            {enCrmSec == null || enCrmSec === 0 ? (
                              <span className="font-mono text-muted-foreground text-xs" title="Sin registro de conexión en este rango.">—</span>
                            ) : (
                              <div className="inline-flex flex-col items-end gap-0.5">
                                <span
                                  className="font-mono tabular-nums text-xs font-bold text-foreground"
                                  title={`Tiempo con el CRM abierto. De eso, ${formatDurationHM(a?.active_seconds ?? 0)} con mouse o teclado y ${formatDurationHM(a?.idle_seconds ?? 0)} quieta (puede estar en una llamada).`}
                                >
                                  {formatDurationHM(enCrmSec)}
                                </span>
                                {fueraSec != null && fueraSec > 0 && (
                                  <span
                                    className="text-[10px] text-warning tabular-nums"
                                    title="Parte del horario YA TRANSCURRIDO en la que el CRM NO estuvo abierto (navegador cerrado, PC apagado o sin internet). No cuenta horas que aún no pasan. No prueba que no trabajara — puede haber estado en Dropi o en el teléfono."
                                  >
                                    {formatDurationHM(fueraSec)} fuera
                                  </span>
                                )}
                              </div>
                            )}
                          </td>
                          {/* TRABAJANDO — evidencia de marcado (piso, no exacto). */}
                          <td className="text-right">
                            <span
                              className={`font-mono tabular-nums text-xs font-bold ${workedSec == null || workedSec === 0 ? 'text-muted-foreground' : 'text-success'}`}
                              title={workedSec == null || workedSec === 0
                                ? 'Sin pedidos marcados en este período.'
                                : `Bloques de trabajo con evidencia (${formatDurationHM(workedSec)}). Es un PISO: una llamada larga sin clic no cuenta.`}
                            >
                              {workedSec == null || workedSec === 0 ? '—' : formatDurationHM(workedSec)}
                            </span>
                          </td>
                          {/* SIN TRABAJAR — avisos de inactividad (clickeable). */}
                          <td className="text-right">
                            {(() => {
                              const inact = inactivityByOp.get(op.id);
                              const avisos = inact ? Number(inact.warnings_count) || 0 : 0;
                              if (avisos === 0) {
                                return (
                                  <span
                                    className="font-mono tabular-nums text-xs font-bold text-success"
                                    title="Sin avisos de inactividad en este período — no se quedó quieta con pedidos en cola."
                                  >
                                    0
                                  </span>
                                );
                              }
                              const perdidoMin = Math.round((Number(inact!.total_lost_seconds) || 0) / 60);
                              const tone = avisos >= 3 ? 'danger' : 'warning';
                              return (
                                <button
                                  onClick={() => setInactivityDetail({ id: op.id, name: op.name })}
                                  className="inline-flex flex-col items-end gap-0.5 cursor-pointer group focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none rounded-md px-1"
                                  title={`${avisos} aviso(s) de inactividad · ${perdidoMin} min en total. Tocá para ver cada uno con su hora.`}
                                >
                                  <span className={`font-mono tabular-nums text-xs font-bold text-${tone} group-hover:underline`}>
                                    {avisos} {avisos === 1 ? 'aviso' : 'avisos'}
                                  </span>
                                  <span className="text-[10px] text-muted-foreground tabular-nums">
                                    {perdidoMin} min
                                  </span>
                                </button>
                              );
                            })()}
                          </td>
                          {/* SIN GESTIONAR — huecos por pedidos marcados, no mouse. */}
                          <td className="text-right">
                            {(() => {
                              if (!isToday) {
                                return <span className="font-mono text-muted-foreground text-xs" title="El hueco en vivo solo se mide en el día de hoy.">—</span>;
                              }
                              if (sinGestionMin == null) {
                                return <span className="font-mono text-muted-foreground text-xs" title="Todavía no marcó ningún pedido hoy.">sin marcar</span>;
                              }
                              const tone = sinGestionMin >= UMBRAL_SIN_GESTION_MIN ? 'danger' : sinGestionMin >= 12 ? 'warning' : 'muted-foreground';
                              const mostrarPeor = peorHuecoMin != null && peorHuecoMin >= 15;
                              return (
                                <span className="inline-flex flex-col items-end gap-0.5"
                                  title={`Hace ${sinGestionMin} min que no marca un pedido${mostrarPeor ? ` · el peor hueco de hoy fue de ${peorHuecoMin} min` : ''}. Se descuenta el almuerzo. Ojo: una llamada larga también se ve así.`}>
                                  <span className={`font-mono tabular-nums text-xs font-bold text-${tone}`}>
                                    {sinGestionMin < 1 ? '<1' : sinGestionMin} min
                                  </span>
                                  {mostrarPeor && (
                                    <span className={`text-[10px] tabular-nums ${peorHuecoMin >= UMBRAL_SIN_GESTION_MIN ? 'text-danger' : 'text-muted-foreground'}`}>
                                      peor: {peorHuecoMin} min
                                    </span>
                                  )}
                                </span>
                              );
                            })()}
                          </td>
                          {/* MIN/PEDIDO — trabajado ÷ TODOS los intentos. */}
                          <td className="text-right">
                            {minPorPedido == null ? (
                              <span className="font-mono text-muted-foreground text-xs" title="Hace falta tiempo trabajado y pedidos marcados para promediar.">—</span>
                            ) : (
                              <span
                                className="font-mono tabular-nums text-xs font-bold text-foreground"
                                title={`${formatDurationHM(workedSec!)} trabajando ÷ ${intentos} pedido(s) marcado(s), incluyendo los "no contestó".`}
                              >
                                {minPorPedido < 1 ? '<1' : Math.round(minPorPedido)} min
                              </span>
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
                          {/* SALIÓ — el CIERRE DE TURNO, no la última señal.
                              Pedido del dueño (2026-07-20): una asesora que sigue
                              trabajando por teléfono con el navegador cerrado NO
                              "salió" a la hora del último clic. Sin cierre no se
                              estima nada: se marca "sin cierre" — eligió ver quién
                              no cerró antes que un número inventado. */}
                          <td className="text-right">
                            {closingError ? (
                              <span
                                className="font-mono text-muted-foreground text-xs"
                                title="No se pudo leer los cierres de turno. NO significa que no cerró."
                              >
                                —
                              </span>
                            ) : cierreAt ? (
                              <span className="inline-flex items-center justify-end gap-1.5 flex-wrap font-mono tabular-nums text-xs">
                                <span className="inline-flex items-center gap-1 whitespace-nowrap text-foreground">
                                  <Clock size={11} className="text-muted-foreground" aria-hidden="true" />
                                  {isToday ? formatTimeBogota(cierreAt) : formatDateTimeBogota(cierreAt)}
                                </span>
                                {cierreTempranoMin > 0 && (
                                  <span
                                    className="inline-flex items-center rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5 text-[10px] font-bold text-danger whitespace-nowrap"
                                    title={`Cerró el turno ${formatDurationHM(cierreTempranoMin * 60)} antes del fin del horario (medido desde su cierre real, no desde la última señal del CRM).`}
                                  >
                                    {formatDurationHM(cierreTempranoMin * 60)} antes
                                  </span>
                                )}
                                {/* Trabajó DESPUÉS del fin del horario (marcó pedidos,
                                    no solo tuvo la pestaña abierta) → crédito real. */}
                                {trabajoExtraMin > 0 && (
                                  <span
                                    className="inline-flex items-center rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-[10px] font-bold text-success whitespace-nowrap"
                                    title={`Marcó pedidos hasta ${formatDurationHM(trabajoExtraMin * 60)} después del fin del horario (trabajo real).`}
                                  >
                                    {formatDurationHM(trabajoExtraMin * 60)} más
                                  </span>
                                )}
                              </span>
                            ) : enLinea ? (
                              <span
                                className="inline-flex items-center rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-[10px] font-bold text-success whitespace-nowrap"
                                title="Todavía no cerró turno, pero sigue conectada (señal hace menos de 10 min)."
                              >
                                en línea
                              </span>
                            ) : (
                              <span
                                className="inline-flex items-center rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[10px] font-bold text-warning whitespace-nowrap"
                                title={turnoEnd
                                  ? `No hizo el cierre de turno. La última señal que dio el CRM fue ${isToday ? formatTimeBogota(turnoEnd) : formatDateTimeBogota(turnoEnd)}, pero eso NO es su hora de salida: pudo seguir trabajando fuera del CRM.`
                                  : 'No hizo el cierre de turno y no hay ninguna señal en el período.'}
                              >
                                sin cierre
                              </span>
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
              {/* Segunda cifra = MISMO "% del día" de la tabla: lo que confirmó
                  ÷ lo que trabajó (gestionados). Es el mismo criterio del aro del
                  equipo, así el recuadro y la fila de la operadora coinciden. */}
              <div
                className="shrink-0 text-right border-l border-accent/25 pl-3"
                title="De lo que esta operadora TRABAJÓ hoy (gestionó), qué parte confirmó. Es el mismo número que su fila en la tabla."
              >
                <div className="text-2xl font-bold leading-none text-foreground font-mono tabular-nums">
                  {(() => {
                    const at = Number(leader.total_atendidos) || 0;
                    const t = at > 0 ? Math.min(100, Math.round((leader.confirmados / at) * 100)) : null;
                    return t == null ? '—' : `${t}%`;
                  })()}
                </div>
                <div className="hud-label mt-1.5">del día</div>
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
                ? `Trabajó ${teamAtendidos} → confirmó ${teamConf} = ${teamTasaDiaGauge}% del día · entraron ${entrantes} hoy`
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
              <span><strong className="text-foreground">Conf. / Canc.</strong>: cuántos confirmó / canceló</span>
              <span><strong className="text-foreground">No contestó</strong>: no le contestaron al menos 1 vez (aunque después sí confirmara)</span>
              <span><strong className="text-foreground">Sin cerrar aún</strong>: sigue sin contestar — todavía nadie lo cerró</span>
              <span><strong className="text-foreground">Atendidos</strong>: pedidos distintos que trabajó</span>
              <span><strong className="text-foreground">Contactó</strong>: de los que ENTRARON hoy, a cuántos les habló (faltan = por contactar)</span>
              <span><strong className="text-foreground">Confirmó</strong>: de los pedidos que gestionó, cuántos confirmó (nuevos y viejos por igual) · meta {CONF_TARGET_PCT}%</span>
              <span><strong className="text-foreground">Clientes por hora</strong>: clientes reales atendidos por cada hora trabajada (producción)</span>
              <span><strong className="text-foreground">Llamadas por hora</strong>: cuántas veces marcó por cada hora, incl. las que no contestaron (esfuerzo) · 🔴 menos de {MIN_INTENTOS_POR_HORA}</span>
              <span className="opacity-70">gris "· en curso" = el día todavía no termina, número provisional</span>
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
                      <span className="block">Contactó</span>
                      <span className="block text-[9px] font-normal normal-case text-muted-foreground/70">de lo que entró hoy</span>
                    </th>
                    <th
                      className="text-right"
                      title="Confirmados ÷ lo que TRABAJÓ (gestionados: contestaron + no contestaron, pedidos nuevos y viejos por igual) — la matemática única del CRM, la misma del Dashboard y del cierre. Meta 85%. Gris '· en curso' = el día aún no termina, número provisional. El cierre de llamada (÷ los que contestaron) está en el tooltip de cada celda."
                    >
                      <span className="block">Confirmó</span>
                      <span className="block text-[9px] font-normal normal-case text-muted-foreground/70">de lo que trabajó</span>
                    </th>
                    <th
                      className="text-right"
                      title="Clientes REALES atendidos por hora trabajada (confirmados + cancelados ÷ horas). Es la PRODUCCIÓN real — los que sí contestaron. No cuenta los 'no contestó' (llamadas en frío, rápidas). Informativo: un día malo de no-contesta baja esto sin ser su culpa, por eso no se pinta rojo."
                    >
                      <span className="block">Clientes / hora</span>
                      <span className="block text-[9px] font-normal normal-case text-muted-foreground/70">producción</span>
                    </th>
                    <th
                      className="text-right"
                      title={`Cuántas veces marcó por cada hora trabajada (TODAS las llamadas, incl. 'no contestó'). Es el ESFUERZO: aunque no le contesten, si sigue marcando el número se mantiene alto. 🔴 solo si baja de ${MIN_INTENTOS_POR_HORA} por hora = casi no marca. '—' si trabajó menos de 30 min.`}
                    >
                      <span className="block">Llamadas / hora</span>
                      <span className="block text-[9px] font-normal normal-case text-muted-foreground/70">esfuerzo</span>
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
                        // % del día = lo que confirmó ÷ lo que trabajó (gestionados),
                        // igual que el aro del equipo. La efectividad de cierre
                        // (÷ los que decidieron) queda en el tooltip.
                        const ef = confRateBySample(r.confirmados, r.cancelados);
                        const atendidos = Number(r.total_atendidos) || 0;
                        const tasaDia = atendidos > 0 ? Math.min(100, Math.round((r.confirmados / atendidos) * 100)) : null;
                        const tip = ef.tasa != null
                          ? `Confirmó ${r.confirmados} de ${atendidos} que trabajó = ${tasaDia}%. Efectividad de cierre: ${ef.tasa}% (${r.confirmados} de ${ef.resueltos} que contestaron).`
                          : `Confirmó ${r.confirmados} de ${atendidos} que trabajó.`;
                        if (tasaDia == null) return <span className="font-mono tabular-nums text-xs text-muted-foreground" title="Sin pedidos trabajados aún.">—</span>;
                        return <span title={tip}><RateBar value={tasaDia} target={CONF_TARGET_PCT} /></span>;
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
                            title={`${clientes} clientes atendidos (contestaron) ÷ ${formatDurationHM(worked)} trabajadas = ${cph.toFixed(1)} clientes por hora`}>
                            {cph.toFixed(1)}
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
                            title={`${intentos} veces que marcó ÷ ${formatDurationHM(worked)} trabajadas = ${iph.toFixed(1)} llamadas por hora. 🔴 debajo de ${MIN_INTENTOS_POR_HORA} por hora (casi no marca). Incluye los 'no contestó', así un día duro no te castiga.`}>
                            {iph.toFixed(1)}
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
                    // % del día del equipo = confirmó ÷ trabajó (gestionados),
                    // igual que el aro y las filas. Antes era ÷entrantes (cohorte).
                    const tasaDiaTeam = totAt > 0 ? Math.min(100, Math.round((totConf / totAt) * 100)) : null;
                    const diaToneTeam = tasaDiaTeam == null ? 'muted-foreground'
                      : tasaDiaTeam >= CONF_TARGET_PCT ? 'success'
                      : tasaDiaTeam >= CONF_TARGET_PCT - 5 ? 'warning' : 'danger';
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
                        {/* Confirmación del día del equipo = confirmó ÷ trabajó (gestionados) */}
                        <td className="text-right">
                          {tasaDiaTeam == null
                            ? <span className="font-mono tabular-nums text-xs text-muted-foreground">—</span>
                            : (
                              <span
                                className={`font-mono tabular-nums text-sm text-${diaToneTeam}`}
                                title={`${totConf} confirmados de los ${totAt} que el equipo trabajó hoy = ${tasaDiaTeam}%. Meta del día ~${CONF_TARGET_PCT}%.`}
                              >
                                {tasaDiaTeam}%
                              </span>
                            )}
                        </td>
                        {/* Clientes reales/hora del equipo (info). */}
                        <td className="text-right">
                          {cphTeam == null
                            ? <span className="font-mono tabular-nums text-xs text-muted-foreground">—</span>
                            : <span className="font-mono tabular-nums text-sm text-foreground"
                                title={`${totClientes} clientes atendidos del equipo ÷ ${formatDurationHM(totWorked)} trabajadas = ${cphTeam.toFixed(1)} clientes por hora`}>
                                {cphTeam.toFixed(1)}
                              </span>}
                        </td>
                        {/* Intentos/hora del equipo (esfuerzo, donde vive el 🔴). */}
                        <td className="text-right">
                          {iphTeam == null
                            ? <span className="font-mono tabular-nums text-xs text-muted-foreground">—</span>
                            : <span className={`font-mono tabular-nums text-sm font-semibold text-${iphTeamTone}`}
                                title={`${totIntentosMarcado} veces que marcó el equipo ÷ ${formatDurationHM(totWorked)} trabajadas = ${iphTeam.toFixed(1)} llamadas por hora. 🔴 debajo de ${MIN_INTENTOS_POR_HORA} por hora.`}>
                                {iphTeam.toFixed(1)}
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

      {/* Detalle de avisos de inactividad de una operadora (abre desde la celda
          "Sin trabajar" de la Jornada). Restaurado tras quitarse el 18-jul. */}
      {inactivityDetail && (
        <InactivityDetailModal
          operadora={inactivityDetail.name}
          operatorId={inactivityDetail.id}
          range={range}
          onClose={() => setInactivityDetail(null)}
        />
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
            // null y no 0: sin pedidos tocados en este modulo NO hay tasa que
            // medir. El 0% en rojo era un veredicto reprobatorio sobre una
            // operadora que nadie midio — identico al de alguien que toco 20
            // y no resolvio ninguno. Regla de todo el archivo: sin denominador
            // se muestra "—".
            const tasa = denom > 0 ? Math.round((res / denom) * 100) : null;
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
                <td className="text-right">
                  {tasa == null
                    ? <span className="font-mono tabular-nums text-xs text-muted-foreground" title="Sin pedidos tocados en este módulo — no hay tasa que medir.">—</span>
                    : <RateBar value={tasa} target={70} />}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

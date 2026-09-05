import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { crearRefetchConPiso } from '@/lib/refetchConPiso';

/** Piso entre recargas del panel disparadas por realtime. Ver el efecto del canal. */
const PISO_REALTIME_MS = 30_000;
import {
  Loader2, RefreshCw, TrendingUp, AlertTriangle, Clock, CheckCircle2,
  Inbox, Users, PhoneCall, BarChart3, ShoppingBag, Radio,
} from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { motion } from 'framer-motion';
import { TiltCard, StatTile, GaugeRing } from '@/components/ui3d';
import {
  CHART_TOOLTIP_STYLE, CHART_GRID_PROPS, CHART_BAR_CURSOR,
} from '@/components/logistics/charts/chartTokens';
import { CONF_TARGET_PCT } from '@/lib/confirmationRate';
import { useActiveStoreId } from '@/contexts/StoreContext';
import { useShopifyPending } from '@/hooks/useShopifyPending';
import { shouldAlertSinConfirmar } from '@/lib/jornadaMath';
import { scheduleFromMinutes, DEFAULT_SCHEDULE, bogotaSecondsOfDay } from '@/lib/inactivityWindow';
import { useMezclaAsesor } from '@/hooks/useMezclaAsesor';
import InactivityDetailModal from '@/components/admin/InactivityDetailModal';
import { useStoreSchedule } from '@/hooks/useStoreSchedule';
import { bogotaToday } from '@/lib/utils';
import { isRpcMissing } from '@/lib/rpcError';
import AdvisorCard from '@/components/admin/AdvisorCard';
import AlertaEquipoStrip from '@/components/admin/AlertaEquipoStrip';
import MapaCalorEquipo from '@/components/admin/MapaCalorEquipo';
import PausasDelDiaPanel from '@/components/admin/PausasDelDiaPanel';
import { useInboxEsperando } from '@/hooks/useInboxEsperando';
import { useSelloGestion } from '@/hooks/useSelloGestion';
import { resumirSinVuelta } from '@/lib/plantillasSinVuelta';
import { buildAdvisorVMs } from '@/lib/advisorCardVM';
import { useLiveTeam } from '@/hooks/useLiveTeam';
import { useResponsabilidadAsesor } from '@/hooks/useResponsabilidadAsesor';
import { useAdvisorRoster } from '@/hooks/useAdvisorRoster';
import { metaGestionesDelRango } from '@/lib/responsabilidadAsesor';

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

export default function ProductivityDashboard() {
  const [range, setRange] = useState<Range>('today');
  const [rows, setRows] = useState<Row[]>([]);
  const [activityRows, setActivityRows] = useState<ActivityRow[]>([]);
  const [workedRows, setWorkedRows] = useState<WorkedRow[]>([]);
  const [inactivityRows, setInactivityRows] = useState<InactivityRow[]>([]);
  // false = la RPC de avisos falló: "Avisos sin trabajar: 0 en verde" sería
  // un cero afirmado sobre algo que no se midió (4-sep-2026).
  const [inactivityOk, setInactivityOk] = useState(true);
  // Cada aviso de realtime también refresca el mapa de calor (ver `debounced`).
  const [mapaTick, setMapaTick] = useState(0);
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
  // Mezcla de trabajo por asesor (anti-descreme) — solo HOY (query liviana).
  const { mezcla: mezclaAsesor, loading: mezclaLoading, error: mezclaError } = useMezclaAsesor(activeStoreId, range === 'today');
  // Horario laboral de la tienda (excluye almuerzo) → base de "En su puesto".
  const { data: scheduleMin } = useStoreSchedule(activeStoreId);
  const schedule = scheduleMin ? scheduleFromMinutes(scheduleMin) : DEFAULT_SCHEDULE;

  // Rediseño 26-ago (tarjeta por asesor): datos EN VIVO (hoy) + scores de
  // responsabilidad, para armar el VM de cada tarjeta. useLiveTeam trae estado,
  // ritmo, entró/tarde y barritas por hora; useResponsabilidadAsesor trae
  // devoluciones + % en rojo + el semáforo. Ambos store-scoped.
  const liveTeam = useLiveTeam();
  // Roster completo de la tienda → mostrar SIEMPRE a los asesores, incluidos los
  // inactivos (dejaron de trabajar) que la RPC de productividad esconde.
  const { roster: advisorRoster } = useAdvisorRoster(activeStoreId);

  // ── «Les escribió y no volvió a mirar», por persona ────────────────────────
  // El caso que reportó el dueño del supervisor. Se cruzan dos cosas que ya
  // existen: los clientes colgados (la segunda canasta de la bandeja) y el
  // sello de gestión, que es lo único que dice QUIÉN tocó cada teléfono.
  //
  // ⛔ La atribución NO sale de `chat_saliente_tipo`: esa columna dice si el
  // mensaje fue plantilla o directo, no quién lo mandó, y el bot manda
  // plantillas todo el día. Ver `plantillasSinVuelta.ts`.
  const { sinRespuesta: colgados } = useInboxEsperando(activeStoreId);
  const telefonosColgados = useMemo(
    () => colgados.map((c) => c.phone).filter(Boolean),
    [colgados],
  );
  const { selloDe, estado: estadoSelloColgados } = useSelloGestion(activeStoreId, telefonosColgados);
  const sinVuelta = useMemo(
    () => resumirSinVuelta(colgados, selloDe, estadoSelloColgados === 'ok'),
    [colgados, selloDe, estadoSelloColgados],
  );
  const fraccionTurnoHoy = (() => {
    const tot = schedule.workEndSec - schedule.workStartSec;
    if (tot <= 0) return 1;
    const s = bogotaSecondsOfDay(new Date());
    return Math.max(0, Math.min(1, (s - schedule.workStartSec) / tot));
  })();
  const metaGestionesInput = metaGestionesDelRango(range, range === 'today' ? fraccionTurnoHoy : 1);
  const { scores: respScores, status: respStatus } = useResponsabilidadAsesor(range, rows, metaGestionesInput);

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
    //
    // Las fechas del contador de acciones y de los cierres se calculan ANTES,
    // porque esas dos consultas van en el mismo viaje que las RPCs (ver abajo).
    const hoy = bogotaToday();
    const desde = range === 'today'
      ? hoy
      : new Date(Date.now() - (range === '7d' ? 6 : 29) * 86400000)
          .toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    // ⛔ SEIS consultas, UN viaje (5-sep-2026). Antes eran cuatro esperas en
    // fila: set_active_store → las 4 RPCs → el contador de order_results → los
    // cierres de turno. Las dos últimas no dependen de nada de lo anterior; con
    // la base lenta cada eslabón de más era otro segundo de spinner bajo «Hoy».
    const [productivity, activity, worked, inactivity, acciones, cierresRes] = await Promise.all([
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
      // Conteo CRUDO de acciones del período — sin excluir admins ni nada.
      //
      // Existe por un caso real (2026-07-20): el dueño marcó un pedido, la tabla
      // siguió vacía y leyó "está roto". No lo estaba: `operator_productivity_stats`
      // excluye a los admin a propósito, y esa era la ÚNICA acción del día. El
      // cartel decía "Todavía sin gestiones" cuando la verdad era "hubo una, pero
      // no se cuenta acá". Con este número el estado vacío puede decir cuál de las
      // dos cosas pasó. Es best-effort: si falla, el cartel cae al texto genérico.
      supabase
        .from('order_results')
        .select('id', { count: 'exact', head: true })
        .eq('store_id', activeStoreId ?? '')
        .gte('result_date', desde)
        .lte('result_date', hoy),
      // Cierres de turno del período. Nos quedamos con el MÁS RECIENTE por
      // operadora: en un rango de varios días la columna muestra el último.
      // Filtrado por tienda ACTIVA: un supervisor con membresía en CO y EC ve
      // por RLS los cierres de ambas — sin este filtro, su "SALIÓ" acá podía
      // ser el cierre del otro país (mezclar países está prohibido).
      supabase
        .from('operator_daily_reports')
        .select('user_id, closing_at')
        .eq('store_id', activeStoreId ?? '')
        .gte('report_date', desde)
        .lte('report_date', hoy)
        .not('closing_at', 'is', null)
        .order('closing_at', { ascending: false }),
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
    // supabase-js NO lanza en un SELECT fallido (resuelve con error en el
    // objeto), así que un try/catch no lo atrapa: sin este check un fallo de
    // red/RLS se mostraba como "0 medido" y el estado vacío afirmaba "Nadie
    // marcó pedidos" — el cero falso que este contador vino a evitar. Con
    // null, el cartel cae al texto genérico que no afirma nada.
    setAccionesPeriodo(acciones.error ? null : (acciones.count ?? 0));
    // Mismo criterio para los cierres: sin el check, el mapa vacío hacía que la
    // columna SALIÓ dijera "sin cierre" para TODAS — dato falso, no medición.
    if (cierresRes.error) {
      console.warn('[productivity] cierres query error', cierresRes.error);
      cierresFallo = true;
      setClosingByOp({});
    } else {
      const mapa: Record<string, string> = {};
      for (const c of (cierresRes.data ?? []) as { user_id: string; closing_at: string }[]) {
        if (!mapa[c.user_id]) mapa[c.user_id] = c.closing_at;
      }
      setClosingByOp(mapa);
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
      setInactivityOk(true);
    } else {
      setInactivityRows([]);
      setInactivityOk(false);
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

  /**
   * ⛔ El canal NO puede depender de `load`.
   *
   * `load` se rehace cada vez que cambia el rango (`useCallback(..., [range,
   * activeStoreId])`), así que tenerlo en las deps del efecto de realtime hacía
   * que tocar «7 días» desuscribiera el canal y suscribiera uno nuevo **con el
   * mismo nombre** (`admin-productivity-<tienda>`, fijo). `removeChannel` es
   * asincrónico: el `subscribe()` nuevo llega mientras el viejo todavía se está
   * yendo, con el mismo topic. Es exactamente el choque que tumbó `/seguimiento`
   * entera el 22-ago («cannot add postgres_changes callbacks after subscribe()»)
   * y que vigila `canalRealtimeUnico` — que solo mira `src/hooks`, así que a un
   * componente no lo alcanzaba.
   *
   * Acá no se veía como pantalla caída sino como algo peor de detectar: el panel
   * se quedaba mudo y el rótulo seguía diciendo «auto-refresh activo».
   *
   * Con el ref, el canal se abre UNA vez por tienda y no se entera de los
   * cambios de rango; adentro siempre llama a la versión más fresca. Es el
   * mismo patrón de `refreshFnsRef` en OrderContext.
   */
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; });

  /** ¿El canal está de verdad escuchando? El rótulo lo dice, así que no puede
   *  ser una suposición. */
  const [enVivo, setEnVivo] = useState(false);

  // Realtime debounced 1s: cambios en orders/order_results/touchpoints de LA
  // TIENDA ACTIVA disparan un refetch silencioso. El filtro por store_id no es
  // solo ruido: sin él, el payload completo de las filas de OTRAS tiendas
  // (teléfonos, acciones) llegaba a este navegador por el socket.
  useEffect(() => {
    if (!activeStoreId) return;
    let mapaPendiente = false;
    // ⛔ Piso de 30 s, no debounce de 1 s (5-sep-2026). Cada recarga son
    // `set_active_store` + CUATRO RPCs de agregación + el mapa de calor (dos
    // tablas paginadas del día). Salía por cada gestión de cualquier asesora:
    // en la pestaña del dueño, quieta, se midieron 13 recargas en 20 minutos
    // —65 consultas pesadas— mientras la base se ahogaba. Un panel de
    // agregados del día no necesita reflejar cada clic al segundo. Y con el
    // freno: si la base está ahogada, espera. Ver `refetchConPiso`.
    const recarga = crearRefetchConPiso(() => {
      loadRef.current(true);
      // El mapa de calor comparte este mismo canal (no abre otro): sin esto
      // era una foto del momento en que se montó, y a las 15:00 seguía
      // mostrando las gestiones de hasta las 9:10 (4-sep-2026). Pero SOLO
      // se relee con una gestión nueva: el mapa sale de order_results y
      // touchpoints, y releer el día entero (dos tablas paginadas) por cada
      // heartbeat de 5 min de cada asesora era una recarga por minuto que no
      // cambiaba nada (revisión 3-sep-2026).
      if (mapaPendiente) { mapaPendiente = false; setMapaTick((t) => t + 1); }
    }, PISO_REALTIME_MS);
    const recargar = (conMapa: boolean) => () => {
      if (conMapa) mapaPendiente = true;
      recarga.pedir();
    };
    const debounced = recargar(false);
    const conGestion = recargar(true);
    const storeFilter = `store_id=eq.${activeStoreId}`;
    // OJO: NO nos suscribimos a `orders`. El sync la reescribe sin parar (cientos de
    // filas por corrida cada ~10 min) → cada cambio disparaba un refetch de las 4
    // RPCs + cierres, y con useLiveTeam haciendo lo mismo, el panel recargaba en
    // bucle (la lentitud que reportó el dueño, 26-ago). Las gestiones (lo que este
    // panel mide) llegan por order_results/touchpoints; el inflow se refresca en el
    // próximo evento de gestión o en el refresh manual. Medido: las RPCs tardan
    // ~200 ms, así que el costo era el volumen de recargas, no cada consulta.
    const channel = supabase
      .channel(`admin-productivity-${activeStoreId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'order_results', filter: storeFilter }, conGestion)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'touchpoints', filter: storeFilter }, conGestion)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'operator_activity_daily', filter: storeFilter }, debounced)
      // Un aviso de inactividad nuevo aparece en vivo en la columna "Sin trabajar".
      .on('postgres_changes', { event: '*', schema: 'public', table: 'operator_inactivity_warnings', filter: storeFilter }, debounced)
      // El rótulo de abajo promete «auto-refresh activo»: acá se mide si es
      // cierto en vez de darlo por hecho.
      .subscribe((status) => { setEnVivo(status === 'SUBSCRIBED'); });
    return () => {
      recarga.cancelar();
      setEnVivo(false);
      void supabase.removeChannel(channel);
    };
  }, [activeStoreId]);

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

  // ── VMs de las tarjetas por asesor (rediseño 26-ago) ──────────────────────
  // Se computan cada render: es el MISMO costo que la tabla vieja (que también
  // calculaba inline) y para un equipo chico es trivial. buildAdvisorVMs aplica
  // todos los guardas ("—" nunca 0) y ordena por quién hay que revisar primero.
  const liveByOp = new Map(liveTeam.operators.map((o) => [o.id, o]));
  const scoresByOp = new Map(respScores.map((s) => [s.operatorId, s]));

  // Universo de tarjetas = SIEMPRE todos los asesores (pedido del dueño):
  //  1. los que gestionaron en el rango → vienen en `rows`;
  //  2. los que hicieron APERTURA hoy pero aún no marcaron → de liveTeam;
  //  3. los INACTIVOS (roster, sin actividad en el rango) → con su "última vez".
  // Se agregan con fila en cero; `rows` (totales del equipo, líder, chart) NO se
  // toca. Si el roster falla, `extra` queda vacío → degrada al comportamiento previo.
  const rosterByOp = new Map(advisorRoster.map((r) => [r.operator_id, { role: r.role, lastActivityIso: r.lastActivityIso }]));
  const yaEnTarjetas = new Set(rows.map((r) => r.operator_id));
  const zeroRow = (operator_id: string, display_name: string): Row => ({
    operator_id, display_name,
    confirmados: 0, cancelados: 0, noresp: 0, novedades_resueltas: 0,
    seg_acciones: 0, seg_resueltos: 0, rescate_acciones: 0, rescate_resueltos: 0,
    total_atendidos: 0, total_entrantes: rows[0]?.total_entrantes ?? 0,
    tasa_contacto: 0, tasa_confirmacion: 0,
  });
  const extraRows: Row[] = [];
  if (isToday) {
    for (const o of liveTeam.operators) {
      if (yaEnTarjetas.has(o.id)) continue;
      yaEnTarjetas.add(o.id); extraRows.push(zeroRow(o.id, o.name));
    }
  }
  for (const r of advisorRoster) {
    if (yaEnTarjetas.has(r.operator_id)) continue;
    yaEnTarjetas.add(r.operator_id); extraRows.push(zeroRow(r.operator_id, r.display_name));
  }
  const cardRows = extraRows.length ? [...rows, ...extraRows] : rows;

  const advisorVMs = cardRows.length > 0
    ? buildAdvisorVMs({
        rows: cardRows, workedByOp, activityByOp, inactivityByOp,
        closingByOp, closingError, mezcla: mezclaAsesor, scoresByOp,
        liveByOp, rosterByOp, schedule, nowMs, entrantes, isToday, confTarget: CONF_TARGET_PCT,
        // Si la lectura de marcas se cortó (error o tope de filas), la tarjeta
        // NO puede decir "presente sin marcar": sería acusar por un hueco de
        // lectura. Ver `useLiveTeam.workEventsOk`.
        workEventsOk: liveTeam.workEventsOk,
        // Tres banderas que el panel calculaba y NO leía (4-sep-2026): con la
        // consulta caída, la tarjeta decía "Devoluciones evitables: 0", "Avisos
        // sin trabajar: 0" en verde, y la mezcla desaparecía igual que si nadie
        // hubiera descremado. Ahora pintan "—" / "no se pudo leer".
        scoresOk: respStatus !== 'error',
        inactivityOk,
        mezclaOk: !mezclaError,
      })
    : [];
  const trabajandoAhora = liveTeam.operators.filter((o) => o.estado === 'trabajando').length;
  const ausentesAhora = liveTeam.operators.filter((o) => o.estado === 'ausente').length;
  const backlogConfirmar = liveTeam.pendingConfirmar;
  const backlogNovedades = liveTeam.pendingNovedades;

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
            {/* No se afirma «activo» sin saberlo: `enVivo` sale del status real
                del canal. Un rótulo que promete algo que no está pasando es la
                misma familia del badge verde de la billetera. */}
            {RANGE_LABELS[range]}
            {enVivo
              ? ' · auto-refresh activo'
              : ' · sin conexión en vivo — usá «Actualizar» para traer lo último'}
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

      {/* El pulso EN VIVO del equipo ahora vive DENTRO de cada tarjeta de asesor
          (rediseño 26-ago-2026); el resumen "quién trabaja ahora" va en el
          encabezado de la grilla. useLiveTeam se monta arriba del componente. */}

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

          {/* Fuga Shopify→Dropi — banner suelto (antes vivía dentro de la tabla
              de Confirmar, que ya no existe). Debería estar en 0. */}
          {shopifyPending.data?.configured !== false && (shopifyPending.data?.pendingCount ?? 0) > 0 && (
            <div className="rounded-2xl border border-danger/30 bg-danger/8 px-4 py-3 flex items-center gap-3 shadow-card3d">
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

          {/* TARJETAS POR ASESOR — reemplazan las 7 tablas por-operador (rediseño
              26-ago). Cada tarjeta cuenta la historia de un asesor; el detalle
              hondo va plegado en "Ver detalle". Ordenadas: primero a quién revisar. */}
          {advisorVMs.length > 0 && (
            <motion.section {...fadeUp(0.06)} className="space-y-3">
              <div className="flex items-center justify-between gap-3 flex-wrap px-0.5">
                <div className="hud-label flex items-center gap-1.5">
                  <Users size={13} className="text-accent" aria-hidden="true" />
                  Asesores · {RANGE_LABELS[range].toLowerCase()}
                </div>
                {isToday && liveTeam.status === 'ok' && (
                  <div className="flex items-center gap-3 text-[11px] text-muted-foreground font-medium flex-wrap">
                    <span className="inline-flex items-center gap-1.5 text-success">
                      <Radio size={12} className="motion-safe:animate-pulse" aria-hidden="true" />{trabajandoAhora} trabajando
                    </span>
                    {ausentesAhora > 0 && <span className="text-warning">{ausentesAhora} ausente{ausentesAhora === 1 ? '' : 's'}</span>}
                    {backlogConfirmar != null && <span>· {backlogConfirmar} por confirmar</span>}
                    {backlogNovedades != null && backlogNovedades > 0 && <span>· {backlogNovedades} novedades</span>}
                  </div>
                )}
              </div>
              {/* ⛔ ARRIBA DE LAS TARJETAS, no dentro de "Ver detalle". El dueño
                  reportó que no volvía a ver las alertas de inactividad: el
                  número existía, pero colapsado en cada tarjeta, una por una. */}
              <AlertaEquipoStrip vms={advisorVMs} isToday={isToday} sinVuelta={sinVuelta.porAsesora} />
              {/* Hora por hora, todo el equipo junto. Va ARRIBA de las tarjetas
                  porque contesta antes la pregunta del dueño («¿quién estuvo
                  trabajando y a qué hora?») y porque, con equipo grande, es la
                  única vista donde entran todas de un vistazo. */}
              <MapaCalorEquipo
                storeId={activeStoreId}
                asesores={advisorVMs.map((vm) => ({ operatorId: vm.operatorId, name: vm.name }))}
                refreshKey={mapaTick}
              />
              {/* Las pausas declaradas ("estoy en la agencia") existían en la
                  base y NINGÚN panel las leía: el dueño no podía ver "declaró
                  4 pausas de 25 min". Solo hoy (4-sep-2026). */}
              {isToday && <PausasDelDiaPanel storeId={activeStoreId} nombreDe={(id) => advisorVMs.find((v) => v.operatorId === id)?.name ?? 'Sin nombre'} />}
              {/* Tres columnas en pantallas anchas (3-sep-2026): estaba fijo en
                  dos, así que con 8 asesoras eran cuatro filas de tarjetas altas
                  y el dueño no veía al equipo sin scrollear. */}
              <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-4">
                {advisorVMs.map((vm) => (
                  <AdvisorCard
                    key={vm.operatorId}
                    vm={vm}
                    isToday={isToday}
                    onInactivityDetail={(id, name) => setInactivityDetail({ id, name })}
                  />
                ))}
              </div>
            </motion.section>
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

          {/* La mezcla difíciles/fáciles (anti-descreme) ahora vive en el
              "Ver detalle" de cada tarjeta de asesor. */}

          {/* "Sin actividad" — solo cuando NI hay productividad NI hay jornada.
              Antes mostraba este mensaje con rows=0 aunque hubiera pings,
              ocultando la sección Jornada. Ahora cubre solo el verdadero
              cero-y-cero. */}
          {rows.length === 0 && jornadaOps.length === 0 && advisorVMs.length === 0 && (
            <div className="rounded-2xl border border-dashed border-border bg-card/40 p-10 text-center">
              <p className="text-sm font-semibold text-foreground mb-1">Sin actividad</p>
              <p className="text-xs text-muted-foreground">Nadie ha registrado acciones en {RANGE_LABELS[range].toLowerCase()}.</p>
            </div>
          )}

          {/* El "top operadora" ya no va aparte: las tarjetas se ordenan por a
              quién revisar, y el líder queda claro por sus cifras. */}

          {/* Las secciones de outcome (Confirmar / Seguimiento / Rescate /
              Novedades) se muestran SIEMPRE que haya alguien en el período.

              Antes se ocultaban enteras con `rows.length > 0` para no dibujar
              tablas vacías. El efecto real era peor: el dueño abría
              Productividad un día tranquilo, veía solo la Jornada y creía que
              las secciones se habían perdido. Ahora se muestran con un estado
              vacío explícito — "existe y hoy no hay datos" se lee distinto de
              "ya no está". */}
          {rows.length === 0 && jornadaOps.length > 0 && advisorVMs.length === 0 && (
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
                  {/* ⛔ El <defs> de afuera NO es decorativo: recharts SOLO deja
                      pasar los hijos que reconoce, y un componente propio como
                      <BarGradientDefs/> lo DESCARTA en silencio. Sin él, los
                      gradientes nunca llegan al DOM y las barras quedan con
                      fill="url(#prodComp-conf)" apuntando a nada: invisibles.
                      Medido en producción el 5-sep-2026 en esta misma pantalla
                      —ejes escalados 0..400, los nombres de las dos asesoras, y
                      cero barras dibujadas—. `DailyReportsView` ya lo envolvía
                      así y por eso era el único de los cinco que se veía. */}
                  <defs>
                    <BarGradientDefs
                      prefix="prodComp"
                      entries={[
                        { key: 'conf', color: CHART_SUCCESS },
                        { key: 'canc', color: CHART_DANGER },
                      ]}
                    />
                  </defs>
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


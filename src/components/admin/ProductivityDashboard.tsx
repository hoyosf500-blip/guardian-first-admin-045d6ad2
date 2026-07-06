import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Loader2, RefreshCw, TrendingUp, AlertTriangle, Trophy, Clock } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid } from 'recharts';
import { confRateBySample, confRateByCohort, isBelowDailyTarget, CONF_TARGET_PCT, CONF_DIA_TARGET_PCT } from '@/lib/confirmationRate';
import { useActiveStoreId } from '@/contexts/StoreContext';
import { useShopifyPending } from '@/hooks/useShopifyPending';
import { ShoppingBag } from 'lucide-react';
import { formatTimeBogota, formatDurationHM } from '@/lib/timeFormat';
import { computeJornadaReal, shouldAlertSinConfirmar, asWorkedBlocks, sumWorkedSeconds, blockRangeLabel, UMBRAL_HUECO_MIN, UMBRAL_DESCONECTADA_MIN } from '@/lib/jornadaMath';
import { gestionesPorHora, densidadTurno, esMouseVivoNoProduce, ritmoTone, MIN_INTENTOS_POR_HORA } from '@/lib/operatorThroughput';
import InactivityDetailModal from '@/components/admin/InactivityDetailModal';

interface ActivityRow {
  operator_id: string;
  display_name: string;
  first_action_at: string | null;
  last_active_at: string | null;
  active_seconds: number;
  idle_seconds: number;
}

interface InactivityRow {
  operator_id: string;
  display_name: string;
  warnings_count: number;
  total_lost_seconds: number;
  last_warning_at: string | null;
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

/** Bullet-style data bar para tasas. Tono semántico vs `target`. Para la tasa de
 *  CONFIRMACIÓN el target es la meta oficial del dueño (CONF_TARGET_PCT = 85%); la
 *  tasa de RESOLUCIÓN (Seguimiento/Novedades) es otra métrica y pasa su propio
 *  benchmark operativo. Verde >= target; ámbar en la banda "cerca" (5 pts). */
function RateBar({ value, target = CONF_TARGET_PCT }: { value: number; target?: number }) {
  const pct = Math.max(0, Math.min(100, value));
  const tone = pct >= target ? 'success' : pct >= target - 5 ? 'warning' : 'danger';
  return (
    <div className={`data-bar tone-${tone}`}>
      <div className="data-bar-fill" style={{ width: `${pct}%` }} aria-hidden="true" />
      <span className="data-bar-value">{pct.toFixed(0)}%</span>
    </div>
  );
}

export default function ProductivityDashboard() {
  const [range, setRange] = useState<Range>('today');
  const [rows, setRows] = useState<Row[]>([]);
  const [activityRows, setActivityRows] = useState<ActivityRow[]>([]);
  const [workedRows, setWorkedRows] = useState<WorkedRow[]>([]);
  const [inactivityRows, setInactivityRows] = useState<InactivityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Popup de detalle de avisos de inactividad (clic en la celda "Advert. inact.").
  const [inactivityDetail, setInactivityDetail] = useState<{ operadora: string } | null>(null);
  // Antes solo console.error → la UI mostraba "Sin actividad" indistinguible
  // de un error silenciado vs cero filas reales. Ahora capturamos el mensaje
  // y lo renderizamos como banner visible para diagnóstico inmediato.
  const [error, setError] = useState<string | null>(null);

  // Fuga Shopify→Dropi: ventas que entraron a Shopify pero NUNCA pasaron a Dropi
  // (no entran al flujo de confirmación → plata que se pierde en silencio). Es
  // responsabilidad del turno dejarla en 0. Store-scoped, cacheado 60s. Si no hay
  // Shopify configurado, el hook devuelve configured:false → no mostramos nada.
  const activeStoreId = useActiveStoreId();
  const shopifyPending = useShopifyPending(activeStoreId);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    // El scope por tienda lo resuelve la RPC server-side vía
    // _resolve_scope_store() (admin → su tienda activa, profiles.active_store_id).
    // No pasamos p_store_id: así NO dependemos de que la migration del parámetro
    // esté aplicada (evita el PGRST202 "function ... does not exist").
    const [productivity, activity, worked, inactivity] = await Promise.all([
      supabase.rpc('operator_productivity_stats' as never, { p_range: range } as never),
      // Jornada — RPC separada (migration 20260528200000). Si aún no se aplicó,
      // capturamos el PGRST202 silencioso y mostramos la sección vacía: el
      // dashboard principal sigue funcionando aunque jornada no exista.
      supabase.rpc('operator_activity_stats' as never, { p_range: range } as never),
      // HORAS REALES por evidencia de trabajo (operator_worked_blocks, migration
      // 20260703200000). Titular de la Jornada. Mismo trato silencioso: si la
      // migration no está, cae a '—' y el resto de la sección sigue.
      supabase.rpc('operator_worked_blocks' as never, { p_range: range } as never),
      // Advertencias de inactividad por operadora (operator_inactivity_stats).
      // Mismo trato silencioso: si la migration no está, la columna muestra 0.
      supabase.rpc('operator_inactivity_stats' as never, { p_range: range } as never),
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
    // Advertencias de inactividad: idem, error silencioso + limpieza (la
    // columna cae a 0 en vez de mostrar datos stale de otro range).
    if (!inactivity.error) {
      setInactivityRows((inactivity.data as InactivityRow[] | null) ?? []);
    } else {
      setInactivityRows([]);
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[productivity] inactivity rpc error', inactivity.error);
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
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'operator_inactivity_warnings' }, debounced)
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [load]);

  // Estable: evita re-registrar el Escape-handler del modal en cada refresh
  // (el realtime debounced re-renderiza este componente cada ~1s).
  const closeInactivityDetail = useCallback(() => setInactivityDetail(null), []);

  const inactivityByOp = new Map(inactivityRows.map(r => [r.operator_id, r]));
  // Cruce jornada ↔ productividad por operadora (para la alerta "sin confirmar"
  // en la tabla Confirmar). Si no hay fila de actividad, no se alerta.
  const activityByOp = new Map(activityRows.map(r => [r.operator_id, r]));
  const workedByOp = new Map(workedRows.map(r => [r.operator_id, r]));
  // Productividad por operadora (gestiones) — la Jornada la cruza para las
  // señales anti-"mama gallo" (bandera mouse-vivo, que necesita atendidos).
  const prodByOp = new Map(rows.map(r => [r.operator_id, r]));
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
  // así que los chips (hueco / desconectada / sin confirmar) se mantienen frescos.
  const nowMs = Date.now();
  // La matemática de ventana real (computeJornadaReal / shouldAlertSinConfirmar)
  // SOLO es válida en 'today': para 7d/30d la RPC operator_activity_stats
  // devuelve MIN(first_action_at) / MAX(last_active_at) / SUM(seconds) sobre
  // TODO el rango (migration 20260626233822, líneas 92-93), así que la
  // "ventana" incluiría noches y días libres → hueco ≈ 100h+ en todas las
  // filas, % real ≈ 5-20% y "⚠ 167h sin confirmar". En multi-día caemos al
  // cálculo viejo (activo ÷ (activo + inactivo)) y ocultamos los chips.
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
  const teamContactados = rows.reduce((a, r) => a + r.confirmados + r.cancelados, 0);
  const teamAtendidos = rows.reduce((a, r) => a + r.total_atendidos, 0);
  const teamTasaDia = entrantes > 0 ? Math.round((teamConf / entrantes) * 100) : 0;

  return (
    <div className="space-y-5">
      {/* Page sub-header — eyebrow + título + meta + actions */}
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          <div className="text-[11px] uppercase tracking-[0.12em] font-semibold text-muted-foreground">
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
          <div className="flex rounded-lg border border-border bg-card p-0.5">
            {(['today', '7d', '30d'] as Range[]).map(r => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  range === r ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {r}
              </button>
            ))}
          </div>
          <button
            onClick={() => load(true)}
            disabled={refreshing}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-card transition-colors hover:border-border-strong hover:bg-muted/40 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            aria-label="Refrescar"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} aria-hidden="true" />
          </button>
        </div>
      </header>

      {error && (
        <div className="rounded-xl border border-danger/30 bg-danger/5 p-4">
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
        <div className="rounded-xl border border-border bg-card p-10 flex items-center justify-center">
          <Loader2 className="animate-spin text-accent" size={20} aria-hidden="true" />
        </div>
      ) : !error ? (
        <>
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
              dotClass="bg-info"
              note={isToday
                ? 'Horas REALES por evidencia de trabajo: suma de los bloques donde registró acciones (confirmar / seguimiento), cortando si pasa +15 min sin tocar nada. "En el CRM" es el heartbeat de mouse aparte — subcuenta el trabajo al teléfono, por eso NO es el titular.'
                : 'Suma de horas trabajadas de todos los días del rango (por evidencia de acciones). El detalle de bloques y "En / fuera del CRM" solo aplica en Hoy.'}
            >
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="w-10">#</th>
                      <th>Operadora</th>
                      <th className="text-right" title="HORAS REALES: suma de los bloques donde registró acciones de trabajo (order_results + touchpoints), cortando el bloque si hay +15 min sin ninguna acción. Es lo más fiel a cuántas horas trabajó — no depende del mouse.">Trabajó</th>
                      <th className="text-right" title="Primera → última señal del día (acción de trabajo o movimiento de mouse), zona Bogotá.">Turno</th>
                      <th className="text-right" title="Heartbeat de mouse/teclado en la pestaña del CRM: activa (movió en los últimos 5 min) · quieta (con el CRM abierto pero sin mover). Subcuenta el trabajo telefónico — es referencia secundaria, no las horas reales.">En el CRM</th>
                      <th className="text-right" title="Tiempo con el CRM cerrado o en segundo plano (no hubo heartbeat). Puede ser trabajo al teléfono/WhatsApp o ausencia — por eso NO castiga las horas reales de arriba. Solo en Hoy.">Fuera del CRM</th>
                      <th className="text-right" title="Avisos de inactividad (5+ min en horario laboral, excl. almuerzo). El tiempo entre paréntesis es tiempo LABORAL perdido. Clic para ver el detalle de cada aviso.">Advert. inact.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jornadaOps.map((op, idx) => {
                      const a = op.a;
                      const w = op.w;
                      // Horas reales: worked_seconds del RPC; fallback a la suma de
                      // los bloques que se muestran, para que titular y detalle
                      // SIEMPRE reconcilien. null si no hay evidencia de trabajo.
                      const blocks = w ? asWorkedBlocks(w.blocks) : [];
                      // worked_seconds es bigint del RPC → coerce con Number (defensivo:
                      // aunque PostgREST devuelve int8 como número, un futuro RPC podría
                      // mandarlo como string). Fallback a la suma de bloques para que
                      // titular y detalle SIEMPRE reconcilien. null si no hay evidencia.
                      const wsNum = w ? Number(w.worked_seconds) : NaN;
                      const workedSec = w
                        ? (Number.isFinite(wsNum) && wsNum > 0 ? wsNum : sumWorkedSeconds(blocks))
                        : null;
                      // "En/Fuera del CRM": SOLO del heartbeat, SOLO en 'today' (en
                      // 7d/30d la ventana MIN/MAX incluiría noches → hueco absurdo).
                      const j = isToday && a
                        ? computeJornadaReal({
                            startedAt: a.first_action_at,
                            lastActivityAt: a.last_active_at,
                            activeSeconds: a.active_seconds,
                            idleSeconds: a.idle_seconds,
                            nowMs,
                          })
                        : null;
                      // Turno = primera → última señal (trabajo o mouse, lo que haya).
                      const turnoStart = w?.first_event ?? a?.first_action_at ?? null;
                      const turnoEnd = w?.last_event ?? a?.last_active_at ?? null;
                      // "Desconectada" = ahora − última señal (la más reciente entre
                      // acción de trabajo y mouse). Solo en 'today'.
                      const lastSignalMs = Math.max(
                        Date.parse(w?.last_event ?? '') || 0,
                        Date.parse(a?.last_active_at ?? '') || 0,
                      );
                      const desconectadaMin = isToday && lastSignalMs > 0
                        ? Math.max(0, Math.floor((nowMs - lastSignalMs) / 60000))
                        : null;
                      // Señales anti-"mama gallo" (solo 'today', sobre evidencia):
                      // densidad del turno + bandera mouse-vivo-no-produce. La
                      // bandera se mide sobre el ESFUERZO TOTAL (marcadas de
                      // Confirmar + acciones de Seguimiento + Rescate), NO solo
                      // Confirmar: si repartió el día entre colas, su esfuerzo de
                      // confirmar es bajo pero SÍ trabajó → no la acusamos falso.
                      // El heartbeat de mouse cubre todas las colas, así que el
                      // numerador también debe cubrirlas.
                      const prod = prodByOp.get(op.id);
                      const esfuerzoTotal = prod
                        ? (prod.intentos_total ?? prod.total_atendidos ?? 0)
                          + (prod.seg_acciones ?? 0)
                          + (prod.rescate_acciones ?? 0)
                        : null;
                      const startMs = Date.parse(turnoStart ?? '');
                      const endMs = Date.parse(turnoEnd ?? '');
                      const turnoSpanSec = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
                        ? (endMs - startMs) / 1000
                        : null;
                      const densidad = isToday ? densidadTurno(workedSec, turnoSpanSec) : null;
                      const mouseVivo = isToday && esMouseVivoNoProduce({
                        activeSeconds: a?.active_seconds,
                        atendidos: esfuerzoTotal,
                        umbralGestionesHora: MIN_INTENTOS_POR_HORA,
                      });
                      return (
                        <tr key={op.id}>
                          <td>
                            <span className="font-mono text-[11px] font-bold tabular-nums text-muted-foreground">
                              {String(idx + 1).padStart(2, '0')}
                            </span>
                          </td>
                          <td className="font-semibold text-foreground">{op.name}</td>
                          {/* TITULAR — horas reales por evidencia + bloques del día. */}
                          <td className="text-right">
                            <div className="inline-flex flex-col items-end gap-0.5">
                              <span
                                className={`font-mono tabular-nums font-bold text-sm ${workedSec == null ? 'text-muted-foreground' : 'text-success'}`}
                                title={workedSec == null
                                  ? 'Sin acciones de trabajo registradas en el período'
                                  : `${blocks.length} bloque${blocks.length === 1 ? '' : 's'} de trabajo`}
                              >
                                {workedSec == null ? '—' : formatDurationHM(workedSec)}
                              </span>
                              {isToday && blocks.length > 0 && (
                                <span
                                  className="text-[10px] text-muted-foreground tabular-nums max-w-[240px] truncate"
                                  title={blockRangeLabel(blocks, formatTimeBogota)}
                                >
                                  {blocks.length > 1 ? `${blocks.length} bloques · ` : ''}{blockRangeLabel(blocks, formatTimeBogota)}
                                </span>
                              )}
                              {densidad != null && (
                                <span
                                  className={`text-[10px] tabular-nums ${densidad < 0.5 ? 'text-warning' : 'text-muted-foreground'}`}
                                  title="Del turno (primera a última señal del día), qué parte realmente trabajó. Bajo = mucho tiempo muerto dentro de la jornada."
                                >
                                  {Math.round(densidad * 100)}% del turno
                                </span>
                              )}
                            </div>
                          </td>
                          {/* Turno: primera → última señal + badge "desconectada". */}
                          <td className="text-right font-mono tabular-nums text-muted-foreground text-xs">
                            <span className="inline-flex items-center justify-end gap-1.5 flex-wrap">
                              {desconectadaMin != null && desconectadaMin >= UMBRAL_DESCONECTADA_MIN && (
                                <span
                                  className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] font-semibold text-muted-foreground whitespace-nowrap"
                                  title="Sin ninguna señal (acción de trabajo ni mouse) desde la última — probablemente ya no está trabajando."
                                >
                                  desconectada hace {formatDurationHM(desconectadaMin * 60)}
                                </span>
                              )}
                              <span className="inline-flex items-center gap-1 whitespace-nowrap">
                                <Clock size={11} className="text-muted-foreground" aria-hidden="true" />
                                {formatTimeBogota(turnoStart)} → {formatTimeBogota(turnoEnd)}
                              </span>
                            </span>
                          </td>
                          {/* En el CRM (heartbeat) — secundario, honesto. */}
                          <td className="text-right">
                            {a ? (
                              <span className="inline-flex items-center justify-end gap-1.5 flex-wrap">
                                {mouseVivo && (
                                  <span
                                    className="inline-flex items-center rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5 text-[10px] font-bold text-danger whitespace-nowrap"
                                    title="El mouse figura muy activa (2h+) pero registra muy poco trabajo por hora de mouse — sumando TODAS las colas (Confirmar + Seguimiento + Rescate), no solo una. Patrón de menear el mouse para figurar sin trabajar."
                                  >
                                    🚩 mouse vivo, poco trabajo
                                  </span>
                                )}
                                <span className="font-mono tabular-nums text-[11px] whitespace-nowrap">
                                  <span className="text-success font-semibold">{formatDurationHM(a.active_seconds)}</span>
                                  <span className="text-muted-foreground"> · {formatDurationHM(a.idle_seconds)} quieta</span>
                                </span>
                              </span>
                            ) : (
                              <span
                                className="font-mono text-muted-foreground text-xs"
                                title="Sin heartbeat de CRM (trabajó por teléfono/WhatsApp o no tuvo la pestaña abierta). Las horas reales de la izquierda no dependen de esto."
                              >—</span>
                            )}
                          </td>
                          {/* Fuera del CRM (hueco) — informativo, no penaliza. */}
                          <td className="text-right font-mono tabular-nums text-xs">
                            {j?.huecoMin != null && j.huecoMin >= UMBRAL_HUECO_MIN ? (
                              <span
                                className="text-muted-foreground whitespace-nowrap"
                                title="Tiempo sin el CRM en primer plano — puede ser trabajo al teléfono/WhatsApp o ausencia. No se descuenta de las horas reales."
                              >
                                {formatDurationHM(j.huecoMin * 60)}
                              </span>
                            ) : (
                              <span className="text-muted-foreground/50">—</span>
                            )}
                          </td>
                          {/* Advertencias de inactividad. */}
                          <td className="text-right">
                            {(() => {
                              const wa = inactivityByOp.get(op.id);
                              const c = wa?.warnings_count ?? 0;
                              if (c === 0) return <span className="font-mono tabular-nums text-muted-foreground">0</span>;
                              return (
                                <button
                                  type="button"
                                  onClick={() => setInactivityDetail({ operadora: op.name })}
                                  className="font-mono tabular-nums font-bold text-danger underline decoration-dotted underline-offset-2 hover:decoration-solid focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none rounded"
                                  title={`Ver el detalle de ${c} aviso${c === 1 ? '' : 's'} · ${formatDurationHM(wa!.total_lost_seconds)} de tiempo laboral perdido`}
                                >
                                  {c}
                                  <span className="text-[10px] text-muted-foreground font-normal"> · {formatDurationHM(wa!.total_lost_seconds)}</span>
                                </button>
                              );
                            })()}
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
            <div className="rounded-xl border border-dashed border-border bg-card/40 p-10 text-center">
              <p className="text-sm font-semibold text-foreground mb-1">Sin actividad</p>
              <p className="text-xs text-muted-foreground">Nadie ha registrado acciones en {RANGE_LABELS[range].toLowerCase()}.</p>
            </div>
          )}

          {/* Top performer callout */}
          {leader && leader.confirmados > 0 && (
            <div className="rounded-xl border border-accent/25 bg-card p-3.5 flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-accent/12">
                <Trophy size={16} className="text-accent" aria-hidden="true" strokeWidth={2.25} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[11px] uppercase tracking-[0.08em] font-semibold text-muted-foreground">
                  Top operadora — {RANGE_LABELS[range].toLowerCase()}
                </div>
                <div className="text-sm font-bold text-foreground truncate">{leader.display_name}</div>
                <div className="text-xs text-accent font-mono font-semibold tabular-nums">
                  {leader.confirmados} confirmados · {(() => {
                    const t = confRateBySample(leader.confirmados, leader.cancelados).tasa;
                    return t == null ? '—' : `${t}%`;
                  })()} confirmación
                </div>
              </div>
            </div>
          )}

          {/* Las secciones de outcome (Confirmar / Seguimiento / Rescate / Novedades)
              solo se muestran si hay productividad medible. Si solo hay jornada
              registrada pero todavía nadie confirmó nada, NO renderizamos tablas
              vacías — la Jornada de arriba ya cuenta la historia. */}
          {rows.length > 0 && <>

          {/* Confirmar — el `note` muestra la COBERTURA DEL EQUIPO (cuánto del
              inflow del período alcanzó a resolver el equipo). La tasa POR
              OPERADORA de la tabla es la MADURA (conf ÷ resueltos), separada del
              volumen del equipo — antes se mezclaba (conf ÷ entrantes = 83%) y
              confundía. Ver src/lib/confirmationRate.ts. */}
          <Section
            title="Confirmar"
            dotClass="bg-success"
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
                      title="Pedidos donde marcó 'no contestó' al menos UNA vez en el período, incluso si después se confirmaron. Métrica de ESFUERZO (no de estado final)."
                    >
                      Intentos N/R
                    </th>
                    <th
                      className="text-right"
                      title="Pedidos cuyo último intento sigue siendo 'no contestó' (sin conf/canc posterior). Métrica de ESTADO ACTUAL — los que quedaron sin cerrar."
                    >
                      N/R abiertos
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
                        const pct = entrantes > 0 ? Math.round((contactados / entrantes) * 100) : null;
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
                        const tip = ef.tasa != null
                          ? `Efectividad de cierre: ${ef.tasa}% (${r.confirmados} de ${ef.resueltos} que decidieron). ${cd.pctProcesado}% del día trabajado.`
                          : 'Sin pedidos resueltos aún.';
                        if (cd.tasaDia == null) return <span className="font-mono tabular-nums text-xs text-muted-foreground" title={tip}>—</span>;
                        // SOLO en 'today' (día vivo) y con < 90% trabajado → provisional
                        // gris, NUNCA rojo: temprano en la jornada la tasa ÷inflow es baja
                        // solo porque falta trabajar. En 7d/30d es una ventana ya cerrada
                        // (la cola reciente pendiente es normal) → número firme vs meta.
                        if (isToday && cd.inmaduro) return (
                          <span className="font-mono tabular-nums text-xs text-muted-foreground" title={`Día en curso (${cd.pctProcesado}% trabajado) — provisional. ${tip}`}>
                            {cd.tasaDia}% <span className="opacity-70">· en curso</span>
                          </span>
                        );
                        return <span title={tip}><RateBar value={cd.tasaDia} target={CONF_DIA_TARGET_PCT} /></span>;
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
                    const pctContactoTeam = entrantes > 0 ? Math.round((totContactados / entrantes) * 100) : null;
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
                                {cdTeam.tasaDia}%{teamEnCurso ? ' ·en curso' : ''}
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
          <Section title="Seguimiento" dotClass="bg-info" note="Touchpoints marcados sobre pedidos en seguimiento">
            <ResolutionTable
              rows={rows}
              acciones={r => r.seg_acciones}
              resueltos={r => r.seg_resueltos}
              pedidos={r => r.seg_pedidos}
              resueltosDist={r => r.seg_resueltos_dist}
              actionTone="info"
            />
          </Section>

          {/* Rescate */}
          <Section title="Rescate" dotClass="bg-danger" note="Touchpoints marcados sobre pedidos en rescate">
            <ResolutionTable
              rows={rows}
              acciones={r => r.rescate_acciones}
              resueltos={r => r.rescate_resueltos}
              pedidos={r => r.rescate_pedidos}
              resueltosDist={r => r.rescate_resueltos_dist}
              actionTone="danger"
            />
          </Section>

          {/* Novedades */}
          {rows.some(r => r.novedades_resueltas > 0) && (
            <Section title="Novedades" dotClass="bg-warning" note="Novedades de transportadora resueltas">
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
            </Section>
          )}

          </>}
        </>
      ) : null}

      {/* Bar chart comparativo — recharts con HSL vars del DS */}
      {!loading && rows.length > 0 && (
        <Section title="Comparativo Confirmados vs Cancelados" dotClass="bg-accent">
          <div className="p-4">
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 8, right: 12, left: -16, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis
                    dataKey="name"
                    tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                    allowDecimals={false}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    contentStyle={{
                      background: 'hsl(var(--popover))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} iconType="circle" iconSize={9} />
                  <Bar dataKey="Confirmados" fill="hsl(var(--success))" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="Cancelados" fill="hsl(var(--danger))" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </Section>
      )}

      {inactivityDetail && (
        <InactivityDetailModal
          operadora={inactivityDetail.operadora}
          range={range}
          onClose={closeInactivityDetail}
        />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// Sub-components
// ──────────────────────────────────────────────────────────────

function Section({ title, dotClass, note, children }: { title: string; dotClass: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card overflow-hidden">
      <header className="px-4 py-3 border-b border-border/60 flex items-center justify-between">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className={`h-2 w-2 rounded-full shrink-0 ${dotClass}`} aria-hidden="true" />
          <h3 className="text-sm font-bold text-foreground tracking-tight">{title}</h3>
          {note && <span className="text-[11px] text-muted-foreground hidden md:inline truncate">· {note}</span>}
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

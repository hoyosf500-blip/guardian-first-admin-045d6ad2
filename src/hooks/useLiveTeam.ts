import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useStore } from '@/contexts/StoreContext';
import { bogotaToday } from '@/lib/utils';
import { bogotaSecondsOfDay } from '@/lib/inactivityWindow';
import { repartirPorHora } from '@/lib/ritmoEnVivo';

/**
 * Datos EN VIVO del equipo para las tarjetas de asesor de Productividad
 * (AdvisorCard): cómo va el equipo HOY, por operadora,
 * en las tres colas (Confirmar / Seguimiento / Novedades) + qué está haciendo
 * cada una AHORA (última acción) + su estado (trabajando / presente sin marcar /
 * ausente) + el backlog compartido de la tienda. Todo store-scoped.
 *
 * Presencia basada en TRABAJO, no solo en mouse: `enLinea`/`estado` salen de la
 * señal MÁS RECIENTE entre el heartbeat (mouse) y el último evento de trabajo
 * (order_results/touchpoints). Así una asesora marcando pedidos con la pestaña
 * en segundo plano NO figura "desconectada", y una con el mouse moviéndose pero
 * sin marcar nada figura "presente sin marcar" (la señal de "parece ocupada,
 * no trabaja").
 *
 * Honestidad: si la RPC principal falla → status 'error'. Si SOLO falla la de
 * presencia (mouse), no se pinta a todos como offline: la presencia igual se
 * deriva del trabajo, y `presenceMouseOk=false` avisa que falta el dato de mouse.
 * Espejo para el trabajo: si fallan las consultas de order_results/touchpoints,
 * `workEventsOk=false` avisa que "sin marcar hoy" puede ser un hueco de LECTURA
 * y no un cero real (el estado queda derivado solo del mouse) — sin la bandera,
 * un fallo de RLS/red dejaba a todo el equipo 'Ausente' con status 'ok'.
 */

const EN_LINEA_MAX_MIN = 10;   // señal < 10 min = en línea
const SIN_MARCAR_MIN = 20;     // presente (mouse) pero sin marcar hace +20 min
const POLL_MS = 30_000;
const EVENT_SCAN_LIMIT = 400;  // filas recientes para hallar la última por operadora

export type WorkStatus = 'trabajando' | 'presente_sin_marcar' | 'ausente';

export interface LiveOperator {
  id: string;
  name: string;
  confirmar: number;
  seguimiento: number;
  novedades: number;
  total: number;
  /** Minutos desde la señal MÁS RECIENTE (mouse o trabajo). null si ninguna. */
  lastSignalMin: number | null;
  /** Minutos desde el último EVENTO DE TRABAJO (marcado). null si ninguno hoy. */
  lastWorkMin: number | null;
  /** Qué fue lo último que marcó ("confirmó", "seguimiento", …). null si nada. */
  ultimaAccion: string | null;
  enLinea: boolean;
  estado: WorkStatus;
  /** Instante (ms) de la PRIMERA señal del día (mouse o trabajo, la más temprana).
   *  Base de "entró a las HH:MM (tarde)" y del ritmo en vivo. null si ninguna. */
  firstSignalMs: number | null;
  /** Gestiones por hora del día (Bogotá) para las barritas del turno. OJO: puede
   *  estar CAPADA a las ~400 marcas más recientes (EVENT_SCAN_LIMIT) — en equipos
   *  chicos cubre el día entero; en uno grande, las horas más viejas subcontarían. */
  hourly: { hora: number; cantidad: number }[];
}

export interface LiveTeam {
  operators: LiveOperator[];
  pendingConfirmar: number | null;
  pendingNovedades: number | null;
  /** false = no se pudo leer el heartbeat de mouse (presencia solo por trabajo). */
  presenceMouseOk: boolean;
  /** false = no se pudo leer la última acción (order_results/touchpoints):
   *  "sin marcar hoy" puede ser hueco de lectura, NO un cero real. */
  workEventsOk: boolean;
  status: 'loading' | 'ok' | 'error';
  updatedAt: number;
}

interface ProdRow {
  operator_id: string; display_name: string;
  confirmados: number; cancelados: number; noresp: number;
  seg_acciones: number; novedades_resueltas: number;
}
interface ActRow { operator_id: string; display_name?: string | null; last_active_at: string | null; first_action_at?: string | null; }

function accionResultado(result: string): string {
  if (result === 'conf') return 'confirmó';
  if (result === 'canc') return 'canceló';
  if (result === 'noresp') return 'no contestó';
  return 'gestionó';
}
function accionTouchpoint(action: string): string {
  if (action.startsWith('SEG:')) return 'seguimiento';
  if (action.startsWith('NOVEDAD:')) return 'novedad';
  if (action.startsWith('RESCUE:')) return 'rescate';
  if (action.startsWith('LLAMADA:')) return 'llamó';
  if (action.startsWith('WHATSAPP:')) return 'WhatsApp';
  if (action.startsWith('REAGENDA:')) return 'reagendó';
  return 'gestión';
}

export function useLiveTeam(): LiveTeam {
  const { activeStoreId: storeId, scopeSynced } = useStore();
  const [team, setTeam] = useState<LiveTeam>({
    operators: [], pendingConfirmar: null, pendingNovedades: null,
    presenceMouseOk: true, workEventsOk: true, status: 'loading', updatedAt: 0,
  });
  // Descarta respuestas viejas (poll + realtime + cambio de tienda pueden pisarse).
  const reqRef = useRef(0);

  const load = useCallback(async () => {
    if (!storeId) return;
    // Las dos RPCs de abajo resuelven la tienda SERVER-SIDE
    // (_resolve_scope_store, sin p_store). Si el set_active_store no quedó
    // sincronizado, devolverían las cifras de la tienda ANTERIOR bajo el
    // nombre de la nueva — mostrar el país equivocado es peor que no mostrar.
    if (!scopeSynced) { setTeam(t => ({ ...t, status: 'error', updatedAt: Date.now() })); return; }
    const myReq = ++reqRef.current;
    const nowMs = Date.now();
    const today = bogotaToday();
    const [prod, act, confPend, novPend, results, tps] = await Promise.all([
      supabase.rpc('operator_productivity_stats' as never, { p_range: 'today' } as never),
      supabase.rpc('operator_activity_stats' as never, { p_range: 'today' } as never),
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('store_id', storeId).ilike('estado', 'PENDIENTE CONFIRMACION'),
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('store_id', storeId)
      // Red ancha = la de la cola real (useNovedades). El eq.NOVEDAD estricto
      // subcontaba las variantes ('NOVEDAD PENDIENTE', 'NOVEDAD EN RUTA')
      // que la cola SI atrapa; se excluye la resuelta en el filtro porque un
      // COUNT head:true no tiene client-side.
        .or('and(estado.ilike.%NOVEDAD%,estado.not.ilike.%SOLUCIONADA%),estado.ilike.%INTENTO DE ENTREGA%').eq('novedad_sol', false),
      // Última actividad de trabajo de HOY (para presencia real + "última acción").
      supabase.from('order_results').select('operator_id, result, created_at')
        .eq('store_id', storeId).eq('result_date', today)
        .order('created_at', { ascending: false }).limit(EVENT_SCAN_LIMIT),
      supabase.from('touchpoints').select('operator_id, action, created_at')
        .eq('store_id', storeId).eq('action_date', today)
        .order('created_at', { ascending: false }).limit(EVENT_SCAN_LIMIT),
    ]);

    if (myReq !== reqRef.current) return; // llegó una respuesta más nueva
    if (prod.error) { setTeam(t => ({ ...t, status: 'error', updatedAt: nowMs })); return; }

    const prodRows = (prod.data as ProdRow[] | null) ?? [];
    const actErr = Boolean(act.error);
    const actRows = actErr ? [] : ((act.data as ActRow[] | null) ?? []);
    const actByOp = new Map(actRows.map(r => [r.operator_id, r]));

    // Último evento de trabajo por operadora (las filas vienen desc → la primera
    // que veo de cada quien es la más reciente).
    const lastWork = new Map<string, { whenMs: number; label: string }>();
    const noteWork = (opId: string | null, iso: string, label: string) => {
      if (!opId) return;
      if (lastWork.has(opId)) return;
      const ms = Date.parse(iso);
      if (Number.isFinite(ms)) lastWork.set(opId, { whenMs: ms, label });
    };
    // EARLIEST marca del día + reparto por hora (para "entró (tarde)" y las
    // barritas del turno). Distinto de lastWork (que guarda la MÁS reciente): acá
    // se recorre TODA marca, no solo la primera vista.
    const firstWorkByOp = new Map<string, number>();
    const horasByOp = new Map<string, number[]>();
    const noteEvento = (opId: string | null, iso: string) => {
      if (!opId) return;
      const ms = Date.parse(iso);
      if (!Number.isFinite(ms)) return;
      const prev = firstWorkByOp.get(opId);
      if (prev == null || ms < prev) firstWorkByOp.set(opId, ms);
      const hora = Math.floor(bogotaSecondsOfDay(new Date(ms)) / 3600);
      const arr = horasByOp.get(opId) ?? [];
      arr.push(hora);
      horasByOp.set(opId, arr);
    };
    if (!results.error) for (const r of (results.data as { operator_id: string | null; result: string; created_at: string }[] ?? [])) {
      noteWork(r.operator_id, r.created_at, accionResultado(r.result));
      noteEvento(r.operator_id, r.created_at);
    }
    if (!tps.error) for (const t of (tps.data as { operator_id: string | null; action: string; created_at: string }[] ?? [])) {
      noteWork(t.operator_id, t.created_at, accionTouchpoint(t.action));
      noteEvento(t.operator_id, t.created_at);
    }

    const minsSince = (ms: number | null | undefined) =>
      ms != null && Number.isFinite(ms) ? Math.max(0, Math.floor((nowMs - ms) / 60000)) : null;

    // Unión de fuentes: la RPC de productividad solo devuelve a quien YA marcó
    // algo hoy. Una operadora presente (heartbeat) que aún no marcó NADA es
    // exactamente el caso que 'presente sin marcar' debe atrapar — sin la unión
    // era invisible en la franja y en los contadores del header.
    const prodByOp = new Map(prodRows.map(r => [r.operator_id, r]));
    const opIds = Array.from(new Set([
      ...prodRows.map(r => r.operator_id),
      ...actRows.map(r => r.operator_id),
    ]));
    const operators: LiveOperator[] = opIds.map(id => {
      const r = prodByOp.get(id);
      const confirmar = r ? (Number(r.confirmados) || 0) + (Number(r.cancelados) || 0) + (Number(r.noresp) || 0) : 0;
      const seguimiento = r ? (Number(r.seg_acciones) || 0) : 0;
      const novedades = r ? (Number(r.novedades_resueltas) || 0) : 0;
      const mouseIso = actByOp.get(id)?.last_active_at ?? null;
      const mouseMin = minsSince(mouseIso ? Date.parse(mouseIso) : null);
      const work = lastWork.get(id);
      const lastWorkMin = minsSince(work?.whenMs ?? null);
      // PRIMERA señal del día = la más temprana entre el primer mouse (heartbeat,
      // dato fiable sin tope) y la marca más vieja que trajimos. El mouse manda
      // para "entró": es cuándo se conectó, aunque aún no hubiera marcado nada.
      const mouseFirstMs = actByOp.get(id)?.first_action_at
        ? Date.parse(actByOp.get(id)!.first_action_at as string) : NaN;
      const workFirstMs = firstWorkByOp.get(id);
      const firstCandidates = [mouseFirstMs, workFirstMs ?? NaN].filter((x): x is number => Number.isFinite(x));
      const firstSignalMs = firstCandidates.length ? Math.min(...firstCandidates) : null;
      const hourly = repartirPorHora(horasByOp.get(id) ?? []);
      // Señal más reciente entre mouse y trabajo.
      const candidates = [mouseMin, lastWorkMin].filter((x): x is number => x != null);
      const lastSignalMin = candidates.length ? Math.min(...candidates) : null;
      const enLinea = lastSignalMin != null && lastSignalMin < EN_LINEA_MAX_MIN;
      // Estado de TRABAJO (no de mouse): trabajando = marcó hace <10 min, O
      // marcó hace <20 min Y está en línea (entre dos llamadas largas es NORMAL
      // pasar 10-19 min sin marcar — antes esa banda caía a 'ausente' con el
      // mouse moviéndose, un estado contradictorio). Presente sin marcar = en
      // línea por mouse pero sin marca hace 20+ (o nunca). Ausente = sin señal.
      let estado: WorkStatus;
      if (lastWorkMin != null && lastWorkMin < EN_LINEA_MAX_MIN) estado = 'trabajando';
      else if (enLinea) estado = lastWorkMin != null && lastWorkMin < SIN_MARCAR_MIN ? 'trabajando' : 'presente_sin_marcar';
      else estado = 'ausente';
      return {
        id,
        name: r?.display_name || actByOp.get(id)?.display_name || 'Operador',
        confirmar, seguimiento, novedades,
        total: confirmar + seguimiento + novedades,
        lastSignalMin, lastWorkMin,
        ultimaAccion: work?.label ?? null,
        enLinea, estado,
        firstSignalMs, hourly,
      };
    })
    // Trabajando primero, luego presente, luego por trabajo del día.
    .sort((a, b) => {
      const rank = (s: WorkStatus) => (s === 'trabajando' ? 0 : s === 'presente_sin_marcar' ? 1 : 2);
      return rank(a.estado) - rank(b.estado) || b.total - a.total;
    });

    setTeam({
      operators,
      pendingConfirmar: confPend.error ? null : (confPend.count ?? 0),
      pendingNovedades: novPend.error ? null : (novPend.count ?? 0),
      presenceMouseOk: !actErr,
      // ⛔ El corte por LÍMITE cuenta como "no se pudo leer" (27-ago-2026).
      //
      // Las dos consultas traen las 400 filas más recientes DE TODA LA TIENDA.
      // Si el equipo marcó más que eso hoy, las marcas viejas quedan afuera y
      // `lastWork` no encuentra a quien empezó temprano y no volvió a marcar
      // hace rato: su tarjeta decía **"presente sin marcar · sin marcar aún"**
      // —la frase exacta que hizo que el dueño le reclamara a un asesor que sí
      // estaba trabajando— sin ninguna señal de que el dato estaba truncado.
      // `workEventsOk` solo cubría el error de red; un tope alcanzado es
      // igual de ciego y hasta más engañoso, porque no falla nada.
      workEventsOk: !results.error && !tps.error
        && (results.data?.length ?? 0) < EVENT_SCAN_LIMIT
        && (tps.data?.length ?? 0) < EVENT_SCAN_LIMIT,
      status: 'ok',
      updatedAt: nowMs,
    });
  }, [storeId, scopeSynced]);

  useEffect(() => {
    setTeam(t => ({ ...t, status: 'loading' }));
    void load();
  }, [load]);

  // Realtime (store-scoped) + poll de 30s para refrescar "hace Xm".
  useEffect(() => {
    if (!storeId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const debounced = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void load(); }, 800);
    };
    const filter = `store_id=eq.${storeId}`;
    // NO escuchamos `orders`: el sync la reescribe sin parar y disparaba un refetch
    // de las 6 consultas de este hook en bucle (parte de la lentitud del panel,
    // 26-ago). La presencia y las gestiones llegan por order_results/touchpoints;
    // los conteos de cola (pendingConfirmar/Novedades, que sí salen de orders) se
    // refrescan en el poll de 30 s — suficiente para un contador de backlog.
    const channel = supabase
      .channel(`live-team-${storeId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_results', filter }, debounced)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'touchpoints', filter }, debounced)
      .subscribe();
    // Poll solo con la pestaña visible (no gastar en background).
    const interval = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') void load();
    }, POLL_MS);
    return () => {
      if (timer) clearTimeout(timer);
      clearInterval(interval);
      void supabase.removeChannel(channel);
    };
  }, [storeId, load]);

  return team;
}

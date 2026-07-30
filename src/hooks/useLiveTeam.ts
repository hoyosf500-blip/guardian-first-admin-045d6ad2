import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useActiveStoreId } from '@/contexts/StoreContext';
import { bogotaToday } from '@/lib/utils';

/**
 * Datos de la franja "Ahora mismo" (TeamNowStrip, embebida en Productividad):
 * cómo va el equipo HOY, por operadora,
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
}

export interface LiveTeam {
  operators: LiveOperator[];
  pendingConfirmar: number | null;
  pendingNovedades: number | null;
  /** false = no se pudo leer el heartbeat de mouse (presencia solo por trabajo). */
  presenceMouseOk: boolean;
  status: 'loading' | 'ok' | 'error';
  updatedAt: number;
}

interface ProdRow {
  operator_id: string; display_name: string;
  confirmados: number; cancelados: number; noresp: number;
  seg_acciones: number; novedades_resueltas: number;
}
interface ActRow { operator_id: string; last_active_at: string | null; }

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
  return 'gestión';
}

export function useLiveTeam(): LiveTeam {
  const storeId = useActiveStoreId();
  const [team, setTeam] = useState<LiveTeam>({
    operators: [], pendingConfirmar: null, pendingNovedades: null,
    presenceMouseOk: true, status: 'loading', updatedAt: 0,
  });
  // Descarta respuestas viejas (poll + realtime + cambio de tienda pueden pisarse).
  const reqRef = useRef(0);

  const load = useCallback(async () => {
    if (!storeId) return;
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
        .or('estado.eq.NOVEDAD,estado.ilike.%INTENTO DE ENTREGA%').eq('novedad_sol', false),
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
    const mouseByOp = new Map(actRows.map(r => [r.operator_id, r.last_active_at]));

    // Último evento de trabajo por operadora (las filas vienen desc → la primera
    // que veo de cada quien es la más reciente).
    const lastWork = new Map<string, { whenMs: number; label: string }>();
    const noteWork = (opId: string | null, iso: string, label: string) => {
      if (!opId) return;
      if (lastWork.has(opId)) return;
      const ms = Date.parse(iso);
      if (Number.isFinite(ms)) lastWork.set(opId, { whenMs: ms, label });
    };
    if (!results.error) for (const r of (results.data as { operator_id: string | null; result: string; created_at: string }[] ?? []))
      noteWork(r.operator_id, r.created_at, accionResultado(r.result));
    if (!tps.error) for (const t of (tps.data as { operator_id: string | null; action: string; created_at: string }[] ?? []))
      noteWork(t.operator_id, t.created_at, accionTouchpoint(t.action));

    const minsSince = (ms: number | null | undefined) =>
      ms != null && Number.isFinite(ms) ? Math.max(0, Math.floor((nowMs - ms) / 60000)) : null;

    const operators: LiveOperator[] = prodRows.map(r => {
      const confirmar = (Number(r.confirmados) || 0) + (Number(r.cancelados) || 0) + (Number(r.noresp) || 0);
      const seguimiento = Number(r.seg_acciones) || 0;
      const novedades = Number(r.novedades_resueltas) || 0;
      const mouseIso = mouseByOp.get(r.operator_id) ?? null;
      const mouseMin = minsSince(mouseIso ? Date.parse(mouseIso) : null);
      const work = lastWork.get(r.operator_id);
      const lastWorkMin = minsSince(work?.whenMs ?? null);
      // Señal más reciente entre mouse y trabajo.
      const candidates = [mouseMin, lastWorkMin].filter((x): x is number => x != null);
      const lastSignalMin = candidates.length ? Math.min(...candidates) : null;
      const enLinea = lastSignalMin != null && lastSignalMin < EN_LINEA_MAX_MIN;
      // Estado de TRABAJO (no de mouse): trabajando si marcó hace poco; presente
      // sin marcar si está en línea por mouse pero hace rato no marca; ausente.
      let estado: WorkStatus;
      if (lastWorkMin != null && lastWorkMin < EN_LINEA_MAX_MIN) estado = 'trabajando';
      else if (enLinea && (lastWorkMin == null || lastWorkMin >= SIN_MARCAR_MIN)) estado = 'presente_sin_marcar';
      else estado = 'ausente';
      return {
        id: r.operator_id,
        name: r.display_name || 'Operador',
        confirmar, seguimiento, novedades,
        total: confirmar + seguimiento + novedades,
        lastSignalMin, lastWorkMin,
        ultimaAccion: work?.label ?? null,
        enLinea, estado,
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
      status: 'ok',
      updatedAt: nowMs,
    });
  }, [storeId]);

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
    const channel = supabase
      .channel(`live-team-${storeId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_results', filter }, debounced)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'touchpoints', filter }, debounced)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter }, debounced)
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

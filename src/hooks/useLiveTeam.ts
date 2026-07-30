import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useActiveStoreId } from '@/contexts/StoreContext';

/**
 * Datos del panel "En vivo" (/en-vivo): cómo va el equipo HOY, por operadora,
 * en las tres colas (Confirmar / Seguimiento / Novedades), + quién está
 * trabajando ahora, + cuánto backlog comparte la tienda. Todo store-scoped.
 *
 * Fuentes (las mismas RPC que Productividad, ya probadas y gated):
 *  - operator_productivity_stats → gestiones del día por operadora.
 *  - operator_activity_stats → última señal (para "en línea / desconectada").
 *  - dos conteos directos sobre `orders` para el backlog compartido (Confirmar
 *    y Novedades), que son exactos y no necesitan RPC nueva.
 *
 * Frescura: realtime sobre order_results/touchpoints/orders (filtrado por
 * tienda) refresca al instante; un intervalo de 30s mantiene vivo el
 * "desconectada hace Xm" aunque no lleguen eventos.
 */

const EN_LINEA_MAX_MIN = 10;
const POLL_MS = 30_000;

export interface LiveOperator {
  id: string;
  name: string;
  /** Gestiones de Confirmar hoy (conf + canc + no contestó). */
  confirmar: number;
  /** Acciones de Seguimiento hoy (touchpoints SEG:*). */
  seguimiento: number;
  /** Novedades resueltas hoy. */
  novedades: number;
  total: number;
  /** Minutos desde la última señal (mouse o marcado). null si nunca. */
  lastActiveMin: number | null;
  enLinea: boolean;
}

export interface LiveTeam {
  operators: LiveOperator[];
  pendingConfirmar: number | null;
  pendingNovedades: number | null;
  status: 'loading' | 'ok' | 'error';
  updatedAt: number;
}

interface ProdRow {
  operator_id: string;
  display_name: string;
  confirmados: number;
  cancelados: number;
  noresp: number;
  seg_acciones: number;
  novedades_resueltas: number;
}
interface ActRow {
  operator_id: string;
  last_active_at: string | null;
}

export function useLiveTeam(): LiveTeam {
  const storeId = useActiveStoreId();
  const [team, setTeam] = useState<LiveTeam>({
    operators: [], pendingConfirmar: null, pendingNovedades: null,
    status: 'loading', updatedAt: 0,
  });
  // Evita pisar un estado 'ok' con 'loading' en cada refetch silencioso.
  const startedRef = useRef(false);

  const load = useCallback(async () => {
    if (!storeId) return;
    const nowMs = Date.now();
    const [prod, act, confPend, novPend] = await Promise.all([
      supabase.rpc('operator_productivity_stats' as never, { p_range: 'today' } as never),
      supabase.rpc('operator_activity_stats' as never, { p_range: 'today' } as never),
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('store_id', storeId).ilike('estado', 'PENDIENTE CONFIRMACION'),
      supabase.from('orders').select('id', { count: 'exact', head: true })
        .eq('store_id', storeId)
        .or('estado.eq.NOVEDAD,estado.ilike.%INTENTO DE ENTREGA%').eq('novedad_sol', false),
    ]);

    // Si la RPC principal falla, decirlo (no pintar ceros que parezcan medidos).
    if (prod.error) {
      setTeam(t => ({ ...t, status: 'error', updatedAt: nowMs }));
      return;
    }

    const prodRows = (prod.data as ProdRow[] | null) ?? [];
    const actRows = (act.error ? [] : (act.data as ActRow[] | null) ?? []);
    const lastByOp = new Map(actRows.map(r => [r.operator_id, r.last_active_at]));

    const operators: LiveOperator[] = prodRows.map(r => {
      const confirmar = (Number(r.confirmados) || 0) + (Number(r.cancelados) || 0) + (Number(r.noresp) || 0);
      const seguimiento = Number(r.seg_acciones) || 0;
      const novedades = Number(r.novedades_resueltas) || 0;
      const lastIso = lastByOp.get(r.operator_id) ?? null;
      const lastMs = lastIso ? Date.parse(lastIso) : NaN;
      const lastActiveMin = Number.isFinite(lastMs) ? Math.max(0, Math.floor((nowMs - lastMs) / 60000)) : null;
      return {
        id: r.operator_id,
        name: r.display_name || 'Operador',
        confirmar, seguimiento, novedades,
        total: confirmar + seguimiento + novedades,
        lastActiveMin,
        enLinea: lastActiveMin != null && lastActiveMin < EN_LINEA_MAX_MIN,
      };
    })
    // En línea primero, luego por trabajo del día.
    .sort((a, b) => Number(b.enLinea) - Number(a.enLinea) || b.total - a.total);

    setTeam({
      operators,
      pendingConfirmar: confPend.error ? null : (confPend.count ?? 0),
      pendingNovedades: novPend.error ? null : (novPend.count ?? 0),
      status: 'ok',
      updatedAt: nowMs,
    });
  }, [storeId]);

  useEffect(() => {
    startedRef.current = false;
    setTeam(t => ({ ...t, status: 'loading' }));
    void load();
  }, [load]);

  // Realtime (store-scoped) + poll de 30s para refrescar "en línea".
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
    const interval = setInterval(() => { void load(); }, POLL_MS);
    return () => {
      if (timer) clearTimeout(timer);
      clearInterval(interval);
      void supabase.removeChannel(channel);
    };
  }, [storeId, load]);

  return team;
}

import { createContext, useContext, useState, useCallback, useEffect, useRef, ReactNode } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './AuthContext';
import { OrderData, dbToOrderData, isPendiente, isDespachado, isConfirmado, isNovedad, isOficina, isDevolucion } from '@/lib/orderUtils';
import { calcPriority } from '@/lib/alertSystem';
import { bogotaToday } from '@/lib/utils';
import { toast } from 'sonner';
import { useCelebration } from '@/hooks/useCelebration';
import { useDataLoader } from '@/hooks/useDataLoader';
import { useNovedades } from '@/hooks/useNovedades';
import { useAutoDropiSync } from '@/hooks/useAutoDropiSync';
import { useRealtimeOrders } from '@/hooks/useRealtimeOrders';

interface Counter { conf: number; canc: number; noresp: number; }

interface OrderState {
  allOrders: OrderData[];
  workQueue: OrderData[];
  segData: OrderData[];
  segLoaded: boolean;
  segLoading: boolean;
  segLastUpdate: Date | null;
  loadSegData: (force?: boolean) => Promise<void>;
  resData: OrderData[];
  resLoaded: boolean;
  resLoading: boolean;
  loadResData: (force?: boolean) => Promise<void>;
  novedadesQueue: OrderData[];
  novedadesLoading: boolean;
  counter: Counter;
  timerStart: number;
  loading: boolean;
  excelLoaded: boolean;
  setExcelLoaded: (v: boolean) => void;
  setAllOrders: (orders: OrderData[]) => void;
  buildWorkQueue: (orders: OrderData[]) => void;
  loadWorkQueue: () => Promise<void>;
  markResult: (order: OrderData, result: string, reason?: string) => Promise<void>;
  undoLast: () => Promise<void>;
  lastMark: { order: OrderData; result: string; reason?: string; resultId?: string; touchpointId?: string } | null;
  resetOrders: () => void;
  loadNovedades: (force?: boolean) => Promise<void>;
  resolveNovedad: (order: OrderData, action: 'reoffer' | 'return', solution?: string) => Promise<void>;
}

const OrderContext = createContext<OrderState | undefined>(undefined);

export function OrderProvider({ children }: { children: ReactNode }) {
  const { user, isAdmin } = useAuth();
  const { checkMilestone, requestNotificationPermission, resetCelebrations } = useCelebration();
  const [allOrders, setAllOrdersState] = useState<OrderData[]>([]);
  const [workQueue, setWorkQueue] = useState<OrderData[]>([]);
  const [counter, setCounter] = useState<Counter>({ conf: 0, canc: 0, noresp: 0 });
  const [timerStart, setTimerStart] = useState(0);
  const [loading] = useState(false);
  const [excelLoaded, setExcelLoaded] = useState(false);
  const [lastMark, setLastMark] = useState<{ order: OrderData; result: string; reason?: string; resultId?: string; touchpointId?: string } | null>(null);

  // Extracted hooks for data loading and novedades
  const dataLoader = useDataLoader(user);
  const novedades = useNovedades(user);

  // loadWorkQueue: refresca la cola de Confirmar desde DB respetando los
  // locks de las otras operadoras. Es la pieza clave del modelo PUSH:
  // cuando otra operadora libera un pedido (al confirmar/cancelar/timeout),
  // realtime la dispara y la operadora libre ve los pedidos disponibles
  // sin tener que dar click en "Actualizar".
  const loadWorkQueue = useCallback(async () => {
    if (!user) return;
    const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { data: dbOrders, error } = await supabase
      .from('orders')
      .select('*')
      .ilike('estado', 'PENDIENTE CONFIRMACION')
      .or(`locked_by.is.null,locked_by.eq.${user.id},locked_at.lt.${fifteenMinAgo}`);
    if (error || !dbOrders) return;
    const orders = dbOrders.map((o, idx) => dbToOrderData(o, idx));
    setAllOrdersState(orders);
    buildWorkQueue(orders);
    // Marca la sesión como cargada para que ConfirmarTab no dispare su
    // propia query duplicada cuando la operadora navegue entre tabs.
    setExcelLoaded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Coalesce los reloads de realtime + auto-Dropi-sync en un solo timer.
  // Antes había 2 callbacks (onOrderChange + onResultChange), cada uno
  // disparaba 3-4 fetches; al confirmar un pedido se generaban 7-8
  // requests en 500ms. Con este wrapper el burst se aplana a 4 fetches.
  //
  // Fix D3: usamos un ref que se actualiza en cada render con las funciones
  // más recientes. El useCallback queda con deps [] y nunca se recrea, así
  // que useRealtimeOrders/useAutoDropiSync no se re-suscriben en cada render
  // — pero adentro siempre llama a la versión más fresca de cada función,
  // evitando el stale-closure que dejaba refrescos disparándose contra
  // estados ya obsoletos.
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshFnsRef = useRef({
    loadNovedades: novedades.loadNovedades,
    loadSegData: dataLoader.loadSegData,
    loadResData: dataLoader.loadResData,
    loadWorkQueue,
  });
  useEffect(() => {
    refreshFnsRef.current = {
      loadNovedades: novedades.loadNovedades,
      loadSegData: dataLoader.loadSegData,
      loadResData: dataLoader.loadResData,
      loadWorkQueue,
    };
  });
  const debouncedRefreshAll = useCallback(() => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      void refreshFnsRef.current.loadNovedades(true);
      void refreshFnsRef.current.loadSegData(true);
      void refreshFnsRef.current.loadResData(true);
      void refreshFnsRef.current.loadWorkQueue();
      refreshTimerRef.current = null;
    }, 800);
  }, []);

  // Auto-sync con Dropi cada 5 min mientras un admin esté con la app abierta.
  // Al terminar refresca todas las colas vía debouncedRefreshAll.
  useAutoDropiSync(isAdmin, user?.id, debouncedRefreshAll);

  // Realtime: cuando cualquier operadora cambia orders o inserta un
  // order_result, todos los caches se refrescan vía el mismo timer
  // debounced para evitar el ráfaga de fetches duplicados.
  useRealtimeOrders(user, {
    onOrderChange: debouncedRefreshAll,
    onResultChange: debouncedRefreshAll,
  });

  // Prevents double-click race: tracks phones currently being processed by markResult.
  const markingInFlight = useRef(new Set<string>());
  // Coordination flag so undoLast and rollbackDropiFailure don't both decrement the counter.
  const revertedRef = useRef(false);
  // Fix D4: cada llamada a buildWorkQueue incrementa este id. El fetch
  // async de order_results valida que el id siga siendo el suyo antes de
  // hacer setWorkQueue/setCounter — si llegó un build más nuevo (p. ej.
  // realtime trajo un cambio mientras la operadora hacía scroll), descarta
  // el resultado para no pisar estado fresco con datos viejos.
  const lastBuildIdRef = useRef(0);

  useEffect(() => {
    requestNotificationPermission();
  }, [requestNotificationPermission]);

  const setAllOrders = useCallback((orders: OrderData[]) => {
    setAllOrdersState(orders);
  }, []);

  const buildWorkQueue = useCallback((orders: OrderData[]) => {
    const pendientes = orders.filter(o => isPendiente(o.estado));
    pendientes.sort((a, b) => calcPriority(b) - calcPriority(a) || b.dias - a.dias);

    const seen = new Set<string>();
    const dedupPendientes = pendientes.filter(o => {
      // Prefer externalId as dedup key — it's unique per order in Dropi.
      // Fall back to phone+producto for orders loaded from Excel without externalId.
      const key = o.externalId || ((o.phone || '') + '|' + (o.producto || ''));
      if (!o.phone || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    setWorkQueue(dedupPendientes);
    dataLoader.setSegData(orders.filter(o => {
      const e = o.estado.toUpperCase();
      return isConfirmado(e) || isDespachado(e) || isNovedad(e) || isOficina(e) || isDevolucion(e);
    }));
    dataLoader.setResData(orders.filter(o => {
      const e = o.estado.toUpperCase();
      return (isDespachado(e) && o.diasConf >= 5) ||
        (e.includes('NOVEDAD') && !o.novedadSol) ||
        e.includes('OFICINA') || e.includes('RECLAME') ||
        e.includes('DEVOL');
    }));

    if (user) {
      // BUG A fix: pull last 7 days so confirmations done late yesterday
      // (or near midnight) don't reappear in the queue today.
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);
      supabase.from('order_results')
        .select('order_id, phone, result, reason, result_time, result_date, created_at')
        .eq('operator_id', user.id)
        .gte('result_date', sevenDaysAgo)
        .then(({ data }) => {
          if (data) {
            const now = Date.now();
            // BUG 1/2 fix: only consider real call outcomes. Audit rows like
            // 'edicion_orden' must NOT mark a pedido as resuelto ni inflar el
            // counter de "no respondió".
            const isCallOutcome = (r: string) => r === 'conf' || r === 'canc' || r === 'noresp';
            const todayLocal = bogotaToday();
            const COOLDOWN_HOURS = 2;
            const MAX_DAILY_ATTEMPTS = 3;

            type ResultRow = {
              order_id: string | null;
              phone: string;
              result: string;
              reason: string | null;
              result_time: string | null;
              result_date: string | null;
              created_at: string;
            };

            // Noresps de HOY agrupados por phone
            const todayNoresp = new Map<string, ResultRow[]>();
            (data as ResultRow[]).forEach(r => {
              if (r.result !== 'noresp') return;
              if (r.result_date !== todayLocal) return;
              if (!todayNoresp.has(r.phone)) todayNoresp.set(r.phone, []);
              todayNoresp.get(r.phone)!.push(r);
            });

            // resultMap: conf/canc siempre; noresp solo si alcanzó cap de hoy o sigue
            // en cooldown de 2h
            const resultMap = new Map<string, { result: string; reason: string }>();
            (data as ResultRow[]).forEach(r => {
              if (!isCallOutcome(r.result)) return;
              if (!r.order_id) return;
              if (r.result === 'conf' || r.result === 'canc') {
                resultMap.set(r.order_id, { result: r.result, reason: r.reason || '' });
                return;
              }
              if (r.result_date !== todayLocal) return;
              const todayCount = (todayNoresp.get(r.phone) || []).length;
              if (todayCount >= MAX_DAILY_ATTEMPTS) {
                resultMap.set(r.order_id, { result: 'noresp', reason: r.reason || '' });
                return;
              }
              const hoursElapsed = (now - new Date(r.created_at).getTime()) / (1000 * 60 * 60);
              if (hoursElapsed < COOLDOWN_HOURS) {
                resultMap.set(r.order_id, { result: 'noresp', reason: r.reason || '' });
              }
            });

            // retryPhones: solo noresps de HOY con <3 intentos Y última hace >=2h
            const retryPhones = new Map<string, number>();
            todayNoresp.forEach((results, phone) => {
              const count = results.length;
              if (count === 0 || count >= MAX_DAILY_ATTEMPTS) return;
              const latest = results.reduce((max, r) =>
                Math.max(max, new Date(r.created_at).getTime()), 0);
              const hoursSinceLatest = (now - latest) / (1000 * 60 * 60);
              if (hoursSinceLatest >= COOLDOWN_HOURS) {
                retryPhones.set(phone, count);
              }
            });
            const updated = dedupPendientes.map(o => {
              const r = o.dbId ? resultMap.get(o.dbId) : undefined;
              const retry = retryPhones.get(o.phone);
              if (r) return { ...o, result: r.result, reason: r.reason };
              if (retry) return { ...o, retryCount: retry };
              return o;
            });
            setWorkQueue(updated);

            if (retryPhones.size > 0) {
              toast.info(`${retryPhones.size} pedido${retryPhones.size > 1 ? 's' : ''} sin respuesta disponible${retryPhones.size > 1 ? 's' : ''} para reintentar`, {
                description: 'No contestaron antes — intenta llamar de nuevo',
                duration: 8000,
              });
            }

            // Contador solo de HOY para que cuadre con TasaMetaBanner y la meta diaria.
            const c = { conf: 0, canc: 0, noresp: 0 };
            (data as ResultRow[]).forEach(r => {
              if (!isCallOutcome(r.result)) return;
              if (r.result_date !== todayLocal) return;
              if (r.result === 'conf') c.conf++;
              else if (r.result === 'canc') c.canc++;
              else if (r.result === 'noresp') c.noresp++;
            });
            setCounter(c);
          }
        });
    }
  }, [user, dataLoader.setSegData, dataLoader.setResData]);

  const markResult = useCallback(async (order: OrderData, result: string, reason?: string) => {
    if (!user || order.result) return;

    if (!order.dbId) {
      toast.error('Este pedido no tiene ID en la base de datos — no se puede registrar');
      return;
    }

    // BUG 7 fix: dedupe por dbId (único por pedido), no por phone — un
    // cliente con 2 pedidos puede confirmar ambos en paralelo.
    if (markingInFlight.current.has(order.dbId)) return;
    markingInFlight.current.add(order.dbId);
    revertedRef.current = false;

    setWorkQueue(prev => prev.map(o => o.dbId === order.dbId ? { ...o, result, reason } : o));
    setCounter(prev => {
      const next = {
        conf: prev.conf + (result === 'conf' ? 1 : 0),
        canc: prev.canc + (result === 'canc' ? 1 : 0),
        noresp: prev.noresp + (result === 'noresp' ? 1 : 0),
      };
      const newTotal = next.conf + next.canc + next.noresp;
      setTimeout(() => checkMilestone(newTotal), 300);
      return next;
    });
    setLastMark({ order, result, reason });

    if (!timerStart) setTimerStart(Date.now());

    const today = bogotaToday();
    const now = new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' });

    const { error, data: insertedResult } = await supabase.from('order_results').insert({
      order_id: order.dbId,
      phone: order.phone,
      result,
      reason: reason || '',
      operator_id: user.id,
      result_date: today,
      result_time: now,
      dropi_sync_status: 'synced',
    }).select('id').single();

    if (!error && result === 'conf' && order.dbId) {
      await supabase.from('orders').update({ estado: 'PENDIENTE' }).eq('id', order.dbId);
      setWorkQueue(prev => prev.map(o => o.dbId === order.dbId ? { ...o, estado: 'PENDIENTE' } : o));

      if (order.externalId) {
        const toastId = `dropi-${order.externalId}`;
        const insertedResultId = insertedResult?.id;
        toast.loading('Dropi: actualizando…', { id: toastId });

        const markDropiFailure = async (errMsg: string) => {
          if (revertedRef.current) return;
          revertedRef.current = true;
          // BUG A fix: do NOT silently rollback. Keep the local confirmation,
          // mark the order_results row as failed so dropi-cron retries it,
          // and warn the operator with a destructive long-duration toast.
          if (insertedResultId) {
            await (supabase.from('order_results') as unknown as {
              update: (v: Record<string, unknown>) => { eq: (c: string, v: string) => Promise<unknown> };
            }).update({
              dropi_sync_status: 'failed',
              result_notes: `Dropi sync pendiente - reintentar (${errMsg})`,
            }).eq('id', insertedResultId);
          }
          toast.error(
            '⚠ Confirmación guardada localmente pero Dropi no respondió. Aparecerá en la pestaña "Novedades" para reintentar.',
            { id: toastId, duration: 10000 },
          );
        };

        supabase.functions
          .invoke('dropi-update-order', { body: { externalId: order.externalId } })
          .then((res) => {
            const data = res?.data as { ok?: boolean; error?: string } | null | undefined;
            if (res?.error || data?.ok === false) {
              const msg = res?.error?.message || data?.error || 'Error desconocido';
              markDropiFailure(msg);
            } else {
              toast.success('Dropi OK', { id: toastId, duration: 2500 });
            }
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            markDropiFailure(`red — ${msg}`);
          });
      }
    }
    if (error) {
      toast.error('Error guardando resultado');
      setWorkQueue(prev => prev.map(o => o.dbId === order.dbId ? { ...o, result: undefined, reason: undefined } : o));
      setCounter(prev => ({
        conf: prev.conf - (result === 'conf' ? 1 : 0),
        canc: prev.canc - (result === 'canc' ? 1 : 0),
        noresp: prev.noresp - (result === 'noresp' ? 1 : 0),
      }));
    } else {
      if (insertedResult?.id) {
        setLastMark(prev => prev ? { ...prev, resultId: insertedResult.id } : prev);
      }

      const { data: tpData } = await supabase.from('touchpoints').insert({
        phone: order.phone,
        action: result === 'conf' ? 'Confirmado' : result === 'canc' ? `Cancelado: ${reason || ''}` : 'No respondió',
        operator_id: user.id,
        action_date: today,
        action_time: now,
      }).select('id').single();

      if (tpData?.id) {
        setLastMark(prev => prev ? { ...prev, touchpointId: tpData.id } : prev);
      }

      // Release the per-order lock now that this operator is done with it.
      // Use rpc cast — claim/release_order are not yet in generated types.
      if (order.dbId) {
        await (supabase.rpc as unknown as (
          fn: string, args: Record<string, unknown>
        ) => Promise<{ error: unknown }>)('release_order', { p_order_id: order.dbId });
      }
    }
    markingInFlight.current.delete(order.dbId);
  }, [user, timerStart, checkMilestone]);

  const undoLast = useCallback(async () => {
    if (!lastMark || !user) return;
    if (revertedRef.current) {
      setLastMark(null);
      toast.info('Ya fue revertido por el rollback de Dropi');
      return;
    }
    revertedRef.current = true;
    const { order, result, resultId, touchpointId } = lastMark;

    setWorkQueue(prev => prev.map(o => o.dbId === order.dbId ? { ...o, result: undefined, reason: undefined } : o));
    setCounter(prev => ({
      conf: prev.conf - (result === 'conf' ? 1 : 0),
      canc: prev.canc - (result === 'canc' ? 1 : 0),
      noresp: prev.noresp - (result === 'noresp' ? 1 : 0),
    }));

    if (resultId) {
      await supabase.from('order_results').delete().eq('id', resultId);
    }
    if (touchpointId) {
      await supabase.from('touchpoints').delete().eq('id', touchpointId);
    }

    // Fix 6: si revertimos una confirmación, también devolvemos el estado
    // del pedido a PENDIENTE CONFIRMACION para que vuelva a aparecer en la
    // cola. Antes el order_results se borraba pero estado quedaba en
    // 'PENDIENTE' y la operadora veía el pedido marcado como ya gestionado.
    if (result === 'conf' && order.dbId) {
      await supabase.from('orders')
        .update({ estado: 'PENDIENTE CONFIRMACION' })
        .eq('id', order.dbId);
      setWorkQueue(prev => prev.map(o =>
        o.dbId === order.dbId
          ? { ...o, estado: 'PENDIENTE CONFIRMACION' }
          : o
      ));
    }

    setLastMark(null);
    toast.success('Deshecho');
  }, [lastMark, user]);

  const resetOrders = useCallback(() => {
    setAllOrdersState([]);
    setWorkQueue([]);
    dataLoader.setSegData([]);
    dataLoader.setSegLoaded(false);
    dataLoader.setResData([]);
    dataLoader.setResLoaded(false);
    novedades.setNovedadesQueue([]);
    setExcelLoaded(false);
    resetCelebrations();
  }, [resetCelebrations, dataLoader.setSegData, dataLoader.setSegLoaded, dataLoader.setResData, dataLoader.setResLoaded, novedades.setNovedadesQueue]);

  return (
    <OrderContext.Provider value={{
      allOrders, workQueue,
      segData: dataLoader.segData, segLoaded: dataLoader.segLoaded, segLoading: dataLoader.segLoading,
      segLastUpdate: dataLoader.segLastUpdate, loadSegData: dataLoader.loadSegData,
      resData: dataLoader.resData, resLoaded: dataLoader.resLoaded, resLoading: dataLoader.resLoading,
      loadResData: dataLoader.loadResData,
      novedadesQueue: novedades.novedadesQueue, novedadesLoading: novedades.novedadesLoading,
      counter, timerStart,
      loading, excelLoaded, setExcelLoaded, setAllOrders, buildWorkQueue, loadWorkQueue, markResult, undoLast, lastMark, resetOrders,
      loadNovedades: novedades.loadNovedades, resolveNovedad: novedades.resolveNovedad,
    }}>
      {children}
    </OrderContext.Provider>
  );
}

export function useOrders() {
  const ctx = useContext(OrderContext);
  if (!ctx) throw new Error('useOrders must be inside OrderProvider');
  return ctx;
}

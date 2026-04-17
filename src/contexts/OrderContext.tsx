import { createContext, useContext, useState, useCallback, useEffect, useRef, ReactNode } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './AuthContext';
import { OrderData, isPendiente, isDespachado, isConfirmado, isNovedad, isOficina, isDevolucion } from '@/lib/orderUtils';
import { calcPriority } from '@/lib/alertSystem';
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

  // Auto-sync con Dropi cada 5 min mientras un admin esté con la app abierta.
  // Al terminar refresca la cola de novedades para que los pedidos ya
  // resueltos en Dropi desaparezcan sin intervención manual.
  useAutoDropiSync(isAdmin, user?.id, () => {
    void novedades.loadNovedades(true);
    void dataLoader.loadSegData(true);
    void dataLoader.loadResData(true);
  });

  // Realtime: when any operator updates orders or inserts an order_result,
  // refetch all queue caches so the admin (and other operators) see the
  // change in seconds without a manual reload. Bursts are debounced inside
  // the hook so a 2000-row sync only triggers one refetch.
  useRealtimeOrders(user, {
    onOrderChange: () => {
      void novedades.loadNovedades(true);
      void dataLoader.loadSegData(true);
      void dataLoader.loadResData(true);
    },
    onResultChange: () => {
      void dataLoader.loadSegData(true);
      void dataLoader.loadResData(true);
    },
  });

  // Prevents double-click race: tracks phones currently being processed by markResult.
  const markingInFlight = useRef(new Set<string>());
  // Coordination flag so undoLast and rollbackDropiFailure don't both decrement the counter.
  const revertedRef = useRef(false);

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
      const diasT = o.diasConf || o.dias;
      return (isDespachado(e) && diasT >= 5) ||
        (e.includes('NOVEDAD') && !o.novedadSol) ||
        e.includes('OFICINA') || e.includes('RECLAME') ||
        e.includes('DEVOL');
    }));

    if (user) {
      const today = new Date().toLocaleDateString('en-CA');
      supabase.from('order_results')
        .select('phone, result, reason, result_time, created_at')
        .eq('operator_id', user.id)
        .eq('result_date', today)
        .then(({ data }) => {
          if (data) {
            const now = Date.now();
            const phoneResults = new Map<string, typeof data>();
            data.forEach(r => {
              if (!phoneResults.has(r.phone)) phoneResults.set(r.phone, []);
              phoneResults.get(r.phone)!.push(r);
            });

            const resultMap = new Map<string, { result: string; reason: string }>();
            data.forEach(r => {
              if (r.result === 'noresp') {
                const attempts = (phoneResults.get(r.phone) || []).filter(x => x.result === 'noresp').length;
                if (attempts >= 3) {
                  resultMap.set(r.phone, { result: r.result, reason: r.reason || '' });
                } else {
                  const createdAt = new Date(r.created_at).getTime();
                  const hoursElapsed = (now - createdAt) / (1000 * 60 * 60);
                  if (hoursElapsed < 3) {
                    resultMap.set(r.phone, { result: r.result, reason: r.reason || '' });
                  }
                }
              } else {
                resultMap.set(r.phone, { result: r.result, reason: r.reason || '' });
              }
            });

            const retryPhones = new Map<string, number>();
            phoneResults.forEach((results, phone) => {
              const nrAttempts = results.filter(x => x.result === 'noresp').length;
              if (nrAttempts > 0 && nrAttempts < 3 && !resultMap.has(phone)) {
                retryPhones.set(phone, nrAttempts);
              }
            });

            const updated = dedupPendientes.map(o => {
              const r = resultMap.get(o.phone);
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

            const c = { conf: 0, canc: 0, noresp: 0 };
            resultMap.forEach(({ result: r }) => {
              if (r === 'conf') c.conf++;
              else if (r === 'canc') c.canc++;
              else c.noresp++;
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

    if (markingInFlight.current.has(order.phone)) return;
    markingInFlight.current.add(order.phone);
    revertedRef.current = false;

    setWorkQueue(prev => prev.map(o => o.phone === order.phone ? { ...o, result, reason } : o));
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

    const today = new Date().toLocaleDateString('en-CA');
    const now = new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });

    const { error, data: insertedResult } = await supabase.from('order_results').insert({
      order_id: order.dbId,
      phone: order.phone,
      result,
      reason: reason || '',
      operator_id: user.id,
      result_date: today,
      result_time: now,
    }).select('id').single();

    if (!error && result === 'conf' && order.dbId) {
      await supabase.from('orders').update({ estado: 'PENDIENTE' }).eq('id', order.dbId);
      setWorkQueue(prev => prev.map(o => o.dbId === order.dbId ? { ...o, estado: 'PENDIENTE' } : o));

      if (order.externalId) {
        const toastId = `dropi-${order.externalId}`;
        const insertedResultId = insertedResult?.id;
        toast.loading('Dropi: actualizando…', { id: toastId });

        const rollbackDropiFailure = async (errMsg: string) => {
          if (revertedRef.current) return;
          revertedRef.current = true;
          toast.error(`Dropi falló: ${errMsg}. Pedido revertido — volvé a confirmarlo.`, { id: toastId, duration: 10000 });
          if (order.dbId) {
            await supabase.from('orders').update({ estado: 'PENDIENTE CONFIRMACION' }).eq('id', order.dbId);
          }
          if (insertedResultId) {
            await supabase.from('order_results').delete().eq('id', insertedResultId);
          }
          setWorkQueue(prev => prev.map(o => o.dbId === order.dbId
            ? { ...o, estado: 'PENDIENTE CONFIRMACION', result: undefined, reason: undefined }
            : o));
          setCounter(prev => ({ ...prev, conf: Math.max(0, prev.conf - 1) }));
          setLastMark(null);
        };

        supabase.functions
          .invoke('dropi-update-order', { body: { externalId: order.externalId } })
          .then((res) => {
            const data = res?.data as { ok?: boolean; error?: string } | null | undefined;
            if (res?.error || data?.ok === false) {
              const msg = res?.error?.message || data?.error || 'Error desconocido';
              rollbackDropiFailure(msg);
            } else {
              toast.success('Dropi OK', { id: toastId, duration: 2500 });
            }
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            rollbackDropiFailure(`red — ${msg}`);
          });
      }
    }
    if (error) {
      toast.error('Error guardando resultado');
      setWorkQueue(prev => prev.map(o => o.phone === order.phone ? { ...o, result: undefined, reason: undefined } : o));
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
    markingInFlight.current.delete(order.phone);
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

    setWorkQueue(prev => prev.map(o => o.phone === order.phone ? { ...o, result: undefined, reason: undefined } : o));
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
      loading, excelLoaded, setExcelLoaded, setAllOrders, buildWorkQueue, markResult, undoLast, lastMark, resetOrders,
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

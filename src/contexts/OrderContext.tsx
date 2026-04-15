import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './AuthContext';
import { OrderData, isPendiente, isDespachado, isConfirmado, isNovedad, isOficina, isDevolucion, dbToOrderData } from '@/lib/orderUtils';
import { toast } from 'sonner';
import { useCelebration } from '@/hooks/useCelebration';

interface Counter { conf: number; canc: number; noresp: number; }

interface OrderState {
  allOrders: OrderData[];
  workQueue: OrderData[];
  segData: OrderData[];
  resData: OrderData[];
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
  lastMark: { order: OrderData; result: string; reason?: string; resultId?: string } | null;
  resetOrders: () => void;
  loadNovedades: () => Promise<void>;
  resolveNovedad: (order: OrderData, action: 'reoffer' | 'return', solution?: string) => Promise<void>;
}

const OrderContext = createContext<OrderState | undefined>(undefined);

export function OrderProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { checkMilestone, requestNotificationPermission, resetCelebrations } = useCelebration();
  const [allOrders, setAllOrdersState] = useState<OrderData[]>([]);
  const [workQueue, setWorkQueue] = useState<OrderData[]>([]);
  const [segData, setSegData] = useState<OrderData[]>([]);
  const [resData, setResData] = useState<OrderData[]>([]);
  const [novedadesQueue, setNovedadesQueue] = useState<OrderData[]>([]);
  const [novedadesLoading, setNovedadesLoading] = useState(false);
  const [counter, setCounter] = useState<Counter>({ conf: 0, canc: 0, noresp: 0 });
  const [timerStart, setTimerStart] = useState(0);
  const [loading, setLoading] = useState(false);
  const [excelLoaded, setExcelLoaded] = useState(false);
  const [lastMark, setLastMark] = useState<{ order: OrderData; result: string; reason?: string; resultId?: string } | null>(null);

  // Request notification permission on mount
  useEffect(() => {
    requestNotificationPermission();
  }, [requestNotificationPermission]);

  const setAllOrders = useCallback((orders: OrderData[]) => {
    setAllOrdersState(orders);
  }, []);

  const buildWorkQueue = useCallback((orders: OrderData[]) => {
    // Filter pendientes and deduplicate by phone+producto
    const pendientes = orders.filter(o => isPendiente(o.estado));
    pendientes.sort((a, b) => b.dias - a.dias);

    const seen = new Set<string>();
    const dedupPendientes = pendientes.filter(o => {
      const key = (o.phone || '') + '|' + (o.producto || '');
      if (!o.phone || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    setWorkQueue(dedupPendientes);
    // Seguimiento: all non-pending orders (matching old app)
    setSegData(orders.filter(o => {
      const e = o.estado.toUpperCase();
      return isConfirmado(e) || isDespachado(e) || isNovedad(e) || isOficina(e) || isDevolucion(e);
    }));
    setResData(orders.filter(o => {
      const e = o.estado.toUpperCase();
      const diasT = o.diasConf || o.dias;
      return (isDespachado(e) && diasT >= 5) ||
        (e.includes('NOVEDAD') && !o.novedadSol) ||
        e.includes('OFICINA') || e.includes('RECLAME') ||
        e.includes('DEVOL');
    }));

    // Load existing results for today
    if (user) {
      const today = new Date().toISOString().split('T')[0];
      supabase.from('order_results')
        .select('phone, result, reason, result_time, created_at')
        .eq('operator_id', user.id)
        .eq('result_date', today)
        .then(({ data }) => {
          if (data) {
            const now = Date.now();
            // Group results by phone
            const phoneResults = new Map<string, typeof data>();
            data.forEach(r => {
              if (!phoneResults.has(r.phone)) phoneResults.set(r.phone, []);
              phoneResults.get(r.phone)!.push(r);
            });

            const resultMap = new Map<string, { result: string; reason: string }>();
            data.forEach(r => {
              // For noresp: check if 3+ hours passed AND fewer than 3 attempts
              if (r.result === 'noresp') {
                const attempts = (phoneResults.get(r.phone) || []).filter(x => x.result === 'noresp').length;
                if (attempts >= 3) {
                  // Max 3 attempts reached, keep as managed
                  resultMap.set(r.phone, { result: r.result, reason: r.reason || '' });
                } else {
                  // Check time elapsed
                  const createdAt = new Date(r.created_at).getTime();
                  const hoursElapsed = (now - createdAt) / (1000 * 60 * 60);
                  if (hoursElapsed < 3) {
                    // Less than 3h, keep as managed
                    resultMap.set(r.phone, { result: r.result, reason: r.reason || '' });
                  }
                  // Otherwise: don't set in resultMap — order reappears as pending
                }
              } else {
                resultMap.set(r.phone, { result: r.result, reason: r.reason || '' });
              }
            });

            // Count retry phones (noresp that reappeared)
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

            // Notify operator about re-surfaced orders
            if (retryPhones.size > 0) {
              toast.info(`${retryPhones.size} pedido${retryPhones.size > 1 ? 's' : ''} sin respuesta disponible${retryPhones.size > 1 ? 's' : ''} para reintentar`, {
                description: 'No contestaron antes — intenta llamar de nuevo',
                duration: 8000,
              });
            }

            const c = { conf: 0, canc: 0, noresp: 0 };
            data.forEach(r => {
              if (r.result === 'conf') c.conf++;
              else if (r.result === 'canc') c.canc++;
              else c.noresp++;
            });
            setCounter(c);
          }
        });
    }
  }, [user]);

  const markResult = useCallback(async (order: OrderData, result: string, reason?: string) => {
    if (!user || order.result) return;

    // Update local state immediately
    setWorkQueue(prev => prev.map(o => o.phone === order.phone ? { ...o, result, reason } : o));
    setCounter(prev => {
      const next = {
        conf: prev.conf + (result === 'conf' ? 1 : 0),
        canc: prev.canc + (result === 'canc' ? 1 : 0),
        noresp: prev.noresp + (result === 'noresp' ? 1 : 0),
      };
      // Check milestones after update
      const newTotal = next.conf + next.canc + next.noresp;
      setTimeout(() => checkMilestone(newTotal), 300);
      return next;
    });
    // resultId will be set after DB insert below
    setLastMark({ order, result, reason });

    if (!timerStart) setTimerStart(Date.now());

    const today = new Date().toISOString().split('T')[0];
    const now = new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });

    // Save to DB
    const { error, data: insertedResult } = await supabase.from('order_results').insert({
      order_id: order.dbId!,
      phone: order.phone,
      result,
      reason: reason || '',
      operator_id: user.id,
      result_date: today,
      result_time: now,
    }).select('id').single();

    // When confirmed, update order status from PENDIENTE CONFIRMACION to PENDIENTE
    if (!error && result === 'conf' && order.dbId) {
      await supabase.from('orders').update({ estado: 'PENDIENTE' }).eq('id', order.dbId);
      setWorkQueue(prev => prev.map(o => o.dbId === order.dbId ? { ...o, estado: 'PENDIENTE' } : o));

      // Fire-and-forget: push the status change to Dropi via the Bearer-token flow.
      // Only runs if the order has a Dropi external_id (skip for Excel-only rows).
      // Non-blocking: the operator moves on to the next call immediately;
      // sonner toast is updated in place when the function call resolves.
      if (order.externalId) {
        const toastId = `dropi-${order.externalId}`;
        toast.loading('Dropi: actualizando…', { id: toastId });
        supabase.functions
          .invoke('dropi-update-order', { body: { externalId: order.externalId } })
          .then((res) => {
            const data = res?.data as { ok?: boolean; error?: string } | null | undefined;
            if (res?.error || data?.ok === false) {
              const msg = res?.error?.message || data?.error || 'Error desconocido';
              toast.error(`Dropi falló: ${msg}`, { id: toastId, duration: 8000 });
            } else {
              toast.success('Dropi OK', { id: toastId, duration: 2500 });
            }
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            toast.error(`Dropi red: ${msg}`, { id: toastId, duration: 8000 });
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
    } else if (insertedResult?.id) {
      setLastMark(prev => prev ? { ...prev, resultId: insertedResult.id } : prev);
    }

    // Save touchpoint
    await supabase.from('touchpoints').insert({
      phone: order.phone,
      action: result === 'conf' ? 'Confirmado' : result === 'canc' ? `Cancelado: ${reason || ''}` : 'No respondió',
      operator_id: user.id,
      action_date: today,
      action_time: now,
    });
  }, [user, timerStart, checkMilestone]);

  const undoLast = useCallback(async () => {
    if (!lastMark || !user) return;
    const { order, result, resultId } = lastMark;

    setWorkQueue(prev => prev.map(o => o.phone === order.phone ? { ...o, result: undefined, reason: undefined } : o));
    setCounter(prev => ({
      conf: prev.conf - (result === 'conf' ? 1 : 0),
      canc: prev.canc - (result === 'canc' ? 1 : 0),
      noresp: prev.noresp - (result === 'noresp' ? 1 : 0),
    }));

    if (resultId) {
      await supabase.from('order_results').delete().eq('id', resultId);
    }

    setLastMark(null);
    toast.success('↩️ Deshecho');
  }, [lastMark, user]);

  const resetOrders = useCallback(() => {
    setAllOrdersState([]);
    setWorkQueue([]);
    setSegData([]);
    setResData([]);
    setNovedadesQueue([]);
    setExcelLoaded(false);
    resetCelebrations();
  }, [resetCelebrations]);

  const loadNovedades = useCallback(async () => {
    if (!user) return;
    setNovedadesLoading(true);
    try {
      // Only `estado='NOVEDAD'` matches what Dropi shows in its own
      // Novedades panel. `INTENTO DE ENTREGA` is a logistic-in-progress
      // state that does NOT require customer action and Dropi does not
      // list it as a pending novedad — including it here creates a huge
      // false positive backlog (see diagnosis against Dropi dashboard).
      const { data, error } = await supabase
        .from('orders')
        .select('*')
        .eq('estado', 'NOVEDAD')
        .eq('novedad_sol', false);
      if (error) {
        toast.error('Error cargando novedades: ' + error.message);
        return;
      }
      const orders = (data || []).map((o, idx) => dbToOrderData(o, idx));
      // Sort by days descending (oldest first, most urgent)
      orders.sort((a, b) => b.dias - a.dias);
      setNovedadesQueue(orders);
    } finally {
      setNovedadesLoading(false);
    }
  }, [user]);

  const resolveNovedad = useCallback(async (
    order: OrderData,
    action: 'reoffer' | 'return',
    solution?: string,
  ) => {
    if (!user || !order) return;

    const cleanSolution = (solution || '').trim();
    if (action === 'reoffer' && cleanSolution.length < 3) {
      toast.error('Escribe la solución antes de continuar');
      return;
    }

    // 1) Optimistic update: mark as resolving so the view can show feedback
    setNovedadesQueue(prev => prev.map(o =>
      o.dbId === order.dbId ? { ...o, result: 'resolving', novedadSol: true } : o,
    ));

    const today = new Date().toISOString().split('T')[0];
    const now = new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });

    // 2) Audit touchpoint (also the source of truth for the protect trigger)
    const touchAction = action === 'reoffer'
      ? `NOVEDAD: Volver a ofrecer — ${cleanSolution.slice(0, 180)}`
      : 'NOVEDAD: Devolver al remitente';

    await supabase.from('touchpoints').insert({
      phone: order.phone,
      action: touchAction,
      operator_id: user.id,
      action_date: today,
      action_time: now,
    });

    // 3) Local DB update
    if (order.dbId) {
      const { error: updateError } = await supabase
        .from('orders')
        .update({ novedad_sol: true, estado: 'NOVEDAD SOLUCIONADA' })
        .eq('id', order.dbId);
      if (updateError) {
        toast.error('Error guardando localmente: ' + updateError.message);
        // Roll back optimistic
        setNovedadesQueue(prev => prev.map(o =>
          o.dbId === order.dbId ? { ...o, result: undefined, novedadSol: false } : o,
        ));
        return;
      }
    }

    // 4) Fire-and-forget Edge Function (only if we have the Dropi external_id)
    if (order.externalId) {
      const toastId = `novedad-${order.externalId}`;
      toast.loading('Dropi: reportando solución…', { id: toastId });
      supabase.functions
        .invoke('dropi-resolve-incidence', {
          body: action === 'reoffer'
            ? { externalId: order.externalId, action, solution: cleanSolution }
            : { externalId: order.externalId, action },
        })
        .then((res) => {
          const data = res?.data as { ok?: boolean; error?: string } | null | undefined;
          if (res?.error || data?.ok === false) {
            const msg = res?.error?.message || data?.error || 'Error desconocido';
            toast.error(`Dropi falló: ${msg}`, { id: toastId, duration: 8000 });
          } else {
            toast.success('Dropi: novedad reportada', { id: toastId, duration: 2500 });
          }
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          toast.error(`Dropi red: ${msg}`, { id: toastId, duration: 8000 });
        });
    } else {
      toast.success('Novedad marcada como resuelta localmente', { duration: 2500 });
    }

    // 5) Remove from queue after a short delay so the UI can show the resolved state
    setTimeout(() => {
      setNovedadesQueue(prev => prev.filter(o => o.dbId !== order.dbId));
    }, 800);
  }, [user]);

  return (
    <OrderContext.Provider value={{
      allOrders, workQueue, segData, resData, novedadesQueue, novedadesLoading, counter, timerStart,
      loading, excelLoaded, setExcelLoaded, setAllOrders, buildWorkQueue, markResult, undoLast, lastMark, resetOrders,
      loadNovedades, resolveNovedad,
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

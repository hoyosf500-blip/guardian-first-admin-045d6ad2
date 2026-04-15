import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './AuthContext';
import { OrderData, isPendiente, isDespachado, isConfirmado, isNovedad, isOficina, isDevolucion } from '@/lib/orderUtils';
import { toast } from 'sonner';
import { useCelebration } from '@/hooks/useCelebration';

interface Counter { conf: number; canc: number; noresp: number; }

interface OrderState {
  allOrders: OrderData[];
  workQueue: OrderData[];
  segData: OrderData[];
  resData: OrderData[];
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
}

const OrderContext = createContext<OrderState | undefined>(undefined);

export function OrderProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { checkMilestone, requestNotificationPermission, resetCelebrations } = useCelebration();
  const [allOrders, setAllOrdersState] = useState<OrderData[]>([]);
  const [workQueue, setWorkQueue] = useState<OrderData[]>([]);
  const [segData, setSegData] = useState<OrderData[]>([]);
  const [resData, setResData] = useState<OrderData[]>([]);
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

            const updated = dedupPendientes.map(o => {
              const r = resultMap.get(o.phone);
              return r ? { ...o, result: r.result, reason: r.reason } : o;
            });
            setWorkQueue(updated);
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
    setExcelLoaded(false);
    resetCelebrations();
  }, [resetCelebrations]);

  return (
    <OrderContext.Provider value={{
      allOrders, workQueue, segData, resData, counter, timerStart,
      loading, excelLoaded, setExcelLoaded, setAllOrders, buildWorkQueue, markResult, undoLast, lastMark, resetOrders
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

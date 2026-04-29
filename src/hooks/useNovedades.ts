import { useState, useCallback, useEffect } from 'react';
import { User } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { OrderData, dbToOrderData } from '@/lib/orderUtils';
import { bogotaToday } from '@/lib/utils';
import { POLL_INTERVAL_MS } from '@/lib/constants';
import { toast } from 'sonner';

interface NovedadesState {
  novedadesQueue: OrderData[];
  setNovedadesQueue: React.Dispatch<React.SetStateAction<OrderData[]>>;
  novedadesLoading: boolean;
  loadNovedades: (force?: boolean) => Promise<void>;
  resolveNovedad: (order: OrderData, action: 'reoffer' | 'return', solution?: string) => Promise<void>;
}

export function useNovedades(user: User | null): NovedadesState {
  const [novedadesQueue, setNovedadesQueue] = useState<OrderData[]>([]);
  const [novedadesLoading, setNovedadesLoading] = useState(false);
  const [novedadesLoaded, setNovedadesLoaded] = useState(false);

  const loadNovedades = useCallback(async (force = false) => {
    if (!user) return;
    if (novedadesLoaded && !force) return;
    setNovedadesLoading(true);
    try {
      // BUG 5 fix: lock solo aplica en Confirmar.
      // Match any estado que contenga NOVEDAD o INTENTO DE ENTREGA — Dropi usa
      // variantes ('NOVEDAD PENDIENTE', 'NOVEDAD EN RUTA', etc.) y un .in()
      // estricto dejaba pedidos fuera de la cola.
      // M5: columnas explícitas en vez de `select('*')` para ser
      // consistente con useDataLoader (Fix 22) y evitar traer columnas
      // futuras innecesarias automáticamente.
      const ORDER_COLUMNS = 'id, external_id, nombre, phone, ciudad, departamento, producto, estado, fecha, fecha_conf, dias, dias_conf, valor, flete, costo_prod, costo_dev, cantidad, direccion, novedad, guia, transportadora, tags, tienda, novedad_sol, assigned_to, locked_by, locked_at, created_at, uploaded_by';
      const { data, error } = await supabase
        .from('orders')
        .select(ORDER_COLUMNS)
        .or('estado.ilike.%NOVEDAD%,estado.ilike.%INTENTO DE ENTREGA%')
        .eq('novedad_sol', false);
      if (error) {
        toast.error('Error cargando novedades: ' + error.message);
        return;
      }
      const orders = (data || []).map((o, idx) => dbToOrderData(o, idx));
      orders.sort((a, b) => b.dias - a.dias);
      setNovedadesQueue(orders);
      setNovedadesLoaded(true);
    } finally {
      setNovedadesLoading(false);
    }
  }, [user, novedadesLoaded]);

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

    setNovedadesQueue(prev => prev.map(o =>
      o.dbId === order.dbId ? { ...o, result: 'resolving', novedadSol: true } : o,
    ));

    const today = bogotaToday();
    const now = new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' });
    const prevEstado = order.estado;

    const touchAction = action === 'reoffer'
      ? `NOVEDAD: Volver a ofrecer — ${cleanSolution.slice(0, 180)}`
      : 'NOVEDAD: Devolver al remitente';

    if (order.dbId) {
      const { error: updateError } = await supabase
        .from('orders')
        .update({ novedad_sol: true, estado: 'NOVEDAD SOLUCIONADA' })
        .eq('id', order.dbId);
      if (updateError) {
        toast.error('Error guardando localmente: ' + updateError.message);
        setNovedadesQueue(prev => prev.map(o =>
          o.dbId === order.dbId ? { ...o, result: undefined, novedadSol: false } : o,
        ));
        return;
      }
    }

    await supabase.from('touchpoints').insert({
      phone: order.phone,
      action: touchAction,
      operator_id: user.id,
      action_date: today,
      action_time: now,
    });

    const rollbackNovedad = async () => {
      if (order.dbId) {
        // Preserva el estado previo (p.ej. 'INTENTO DE ENTREGA') en lugar de
        // sobreescribir a 'NOVEDAD' y perder el matiz original.
        await supabase.from('orders').update({ novedad_sol: false, estado: prevEstado || 'NOVEDAD' }).eq('id', order.dbId);
      }
      setNovedadesQueue(prev => prev.map(o =>
        o.dbId === order.dbId ? { ...o, result: undefined, novedadSol: false } : o,
      ));
    };

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
            toast.error(`Dropi falló: ${msg}. Novedad revertida.`, { id: toastId, duration: 8000 });
            rollbackNovedad();
          } else {
            toast.success('Dropi: novedad reportada', { id: toastId, duration: 2500 });
            // Release lock now that the novedad is resolved.
            if (order.dbId) {
              void (supabase.rpc as unknown as (
                fn: string, args: Record<string, unknown>
              ) => Promise<unknown>)('release_order', { p_order_id: order.dbId });
            }
            setTimeout(() => {
              setNovedadesQueue(prev => prev.filter(o => o.dbId !== order.dbId));
            }, 800);
          }
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          toast.error(`Dropi red: ${msg}. Novedad revertida.`, { id: toastId, duration: 8000 });
          rollbackNovedad();
        });
    } else {
      toast.success('Novedad marcada como resuelta localmente', { duration: 2500 });
      if (order.dbId) {
        void (supabase.rpc as unknown as (
          fn: string, args: Record<string, unknown>
        ) => Promise<unknown>)('release_order', { p_order_id: order.dbId });
      }
      setTimeout(() => {
        setNovedadesQueue(prev => prev.filter(o => o.dbId !== order.dbId));
      }, 800);
    }
  }, [user]);

  // COST-1: pausa polling cuando la pestaña está oculta.
  useEffect(() => {
    if (!user) return;
    return pollWhenVisible(() => {
      if (novedadesLoaded) loadNovedades(true);
    }, POLL_INTERVAL_MS, { runOnVisible: false });
  }, [user, novedadesLoaded, loadNovedades]);

  return {
    novedadesQueue, setNovedadesQueue, novedadesLoading, loadNovedades, resolveNovedad,
  };
}

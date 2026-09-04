import { pollWhenVisible } from '@/lib/pollWhenVisible';
import { useState, useCallback, useEffect, useRef } from 'react';
import { User } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { OrderData, dbToOrderData } from '@/lib/orderUtils';
import { ORDER_COLUMNS } from '@/lib/orderColumns';
import { paginarQuery, type Paginable } from '@/lib/paginarQuery';
import { esNovedadResuelta } from '@/lib/segStatus';
import { bogotaToday } from '@/lib/utils';
import { POLL_INTERVAL_MS } from '@/lib/constants';
import { toast } from 'sonner';

interface NovedadesState {
  novedadesQueue: OrderData[];
  setNovedadesQueue: React.Dispatch<React.SetStateAction<OrderData[]>>;
  novedadesLoading: boolean;
  /** Último error de CARGA (H4, auditoría 14-ago-2026). Con la carga rota la
   *  cola queda vacía y la pantalla pintaba el estado verde "no hay novedades
   *  pendientes" — un toast fugaz era todo el aviso. `null` = última carga OK. */
  novedadesError: string | null;
  loadNovedades: (force?: boolean) => Promise<void>;
  resolveNovedad: (order: OrderData, action: 'reoffer' | 'return', solution?: string) => Promise<void>;
}

export function useNovedades(user: User | null, storeId: string | null): NovedadesState {
  const [novedadesQueue, setNovedadesQueue] = useState<OrderData[]>([]);
  // ⛔ Arranca en `true`: hasta que la primera carga vuelva NO se sabe si hay
  // novedades, y `false` con la cola vacía hacía que la pestaña pintara el
  // verde «Todas las incidencias resueltas» antes de haber preguntado a la
  // base (y `SiguienteColaBanner` lo leía como medido). `novedadesLoaded` no
  // sale del OrderContext, así que la pantalla solo tiene este flag para saber
  // si el cero es real — el mismo patrón de «estado vacío mientras carga».
  const [novedadesLoading, setNovedadesLoading] = useState(true);
  const [novedadesError, setNovedadesError] = useState<string | null>(null);
  const [novedadesLoaded, setNovedadesLoaded] = useState(false);

  // MULTI-TENANT: mismo patrón que useDataLoader — al cambiar de tienda hay que
  // resetear, si no `novedadesLoaded` sigue true y el loadNovedades() sin force
  // hace no-op → quedan las novedades de la tienda anterior (mezcla).
  const prevStoreRef = useRef<string | null>(storeId);
  useEffect(() => {
    if (prevStoreRef.current === storeId) return;
    prevStoreRef.current = storeId;
    setNovedadesQueue([]);
    setNovedadesLoaded(false);
    setNovedadesError(null);
    // La tienda nueva todavía no cargó: cola vacía + loading=false = verde falso.
    setNovedadesLoading(true);
  }, [storeId]);

  // Referencia siempre-fresca para poder relanzar desde dentro del propio load
  // sin meter loadNovedades en sus propias deps.
  const loadNovedadesRef = useRef<(force?: boolean) => Promise<void>>(async () => {});

  const loadNovedades = useCallback(async (force = false) => {
    if (!user || !storeId) return;
    if (novedadesLoaded && !force) return;
    setNovedadesLoading(true);
    // Si el guard multi-tienda de abajo relanza la carga, `loading` tiene que
    // seguir en true: bajarlo en el finally dejaba un render con cola vacía y
    // sin error — el verde de «todo resuelto» durante un frame.
    let relanzada = false;
    try {
      // BUG 5 fix: lock solo aplica en Confirmar.
      // Match any estado que contenga NOVEDAD o INTENTO DE ENTREGA — Dropi usa
      // variantes ('NOVEDAD PENDIENTE', 'NOVEDAD EN RUTA', etc.) y un .in()
      // estricto dejaba pedidos fuera de la cola.
      // M5: usamos ORDER_COLUMNS compartido para que las cards de Novedades
      // traigan validation_decision, address_kind, suggested_customer_message,
      // lat/lng, etc. (mismas que Confirmar/Seguimiento). Antes el string local
      // omitía esos campos y los badges de validación nunca aparecían.
      // Paginado: PostgREST corta en ~1000 filas SIN avisar. Las novedades no
      // tienen techo natural —se acumulan hasta que alguien las resuelve— así
      // que pasado el tope las de más quedaban invisibles y sin gestionar.
      // `cancelado` corta el paginado apenas cambia la tienda: seguir trayendo
      // páginas de la anterior mezclaría Colombia con Ecuador.
      type Row = Parameters<typeof dbToOrderData>[0];
      const { filas, error, truncado } = await paginarQuery<Row>(
        () =>
          supabase
            .from('orders')
            .select(ORDER_COLUMNS)
            .eq('store_id', storeId)
            .or('estado.ilike.%NOVEDAD%,estado.ilike.%INTENTO DE ENTREGA%')
            .eq('novedad_sol', false)
            .order('created_at', { ascending: false })
            .order('id', { ascending: true }) as unknown as Paginable<Row>,
        { cancelado: () => prevStoreRef.current !== storeId },
      );
      // Guard multi-tienda (mismo patrón que useDataLoader): con red lenta la
      // respuesta de la tienda ANTERIOR puede aterrizar después del reset y
      // dejar novedades de CO bajo el encabezado de EC — mezclar países está
      // prohibido. Peor: gestionar una de esas cards escribe el touchpoint con
      // el store_id de la tienda NUEVA sobre un pedido de la vieja.
      if (prevStoreRef.current !== storeId) {
        relanzada = true;
        window.setTimeout(() => void loadNovedadesRef.current(true), 0);
        return;
      }
      if (error) {
        // H4: además del toast (fugaz), dejar el error en estado para que la
        // pantalla lo pinte — sin esto la cola vacía se leía como "todo
        // resuelto" en verde.
        setNovedadesError(error);
        toast.error('Error cargando novedades: ' + error);
        return;
      }
      setNovedadesError(null);
      if (truncado) toast.warning('Hay tantas novedades que no caben todas en pantalla. Avisá para subir el tope.');
      // `%NOVEDAD%` también atrapa NOVEDAD SOLUCIONADA / SOLUCION APROBADA (la
      // variante de Ecuador). Sacarlas acá y no en el SQL a propósito: la red
      // ancha es la que evita perder variantes como "NOVEDAD PENDIENTE".
      // Ver `esNovedadResuelta` — Seguimiento ya las muestra como resueltas y
      // las dos pantallas se contradecían sobre el mismo pedido.
      const orders = filas
        .filter((o) => !esNovedadResuelta((o as { estado?: string | null }).estado))
        .map((o, idx) => dbToOrderData(o, idx));
      orders.sort((a, b) => b.dias - a.dias);
      setNovedadesQueue(orders);
      setNovedadesLoaded(true);
    } finally {
      if (!relanzada) setNovedadesLoading(false);
    }
  }, [user, novedadesLoaded, storeId]);
  loadNovedadesRef.current = loadNovedades;

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
      store_id: storeId,
    });

    // LA MARCA LOCAL SE QUEDA — decisión del dueño (14-ago-2026): "las
    // novedades no se pueden resolver desde el CRM; la operadora lo hace desde
    // Dropi, pero tiene que marcar la opción en el CRM". El reporte automático
    // a Dropi es un EXTRA de cortesía: si Dropi lo rechaza ("ya resuelta",
    // incidencia vencida/cerrada por la transportadora, un estatus de los mil
    // que no vale la pena mapear), eso NO invalida la gestión que ella ya hizo
    // en el panel. La versión anterior REVERTÍA la marca ante cualquier rechazo
    // y la novedad reaparecía en la cola: doble gestión y cliente llamado dos
    // veces. (El único camino que sí revierte es el de arriba: si el UPDATE
    // local falla, no se marcó nada.)
    const cerrarEnPantalla = () => {
      if (order.dbId) {
        void (supabase.rpc as unknown as (
          fn: string, args: Record<string, unknown>
        ) => Promise<unknown>)('release_order', { p_order_id: order.dbId });
      }
      setTimeout(() => {
        setNovedadesQueue(prev => prev.filter(o => o.dbId !== order.dbId));
      }, 800);
    };

    if (order.externalId) {
      const toastId = `novedad-${order.externalId}`;
      toast.loading('Dropi: reportando solución…', { id: toastId });
      supabase.functions
        .invoke('dropi-resolve-incidence', {
          // storeId: el numero de pedido ya no identifica una empresa
          // (20260820140000) y resolver la novedad en la tienda equivocada
          // dispara una devolucion REAL en la transportadora de otro dueno.
          body: action === 'reoffer'
            ? { externalId: order.externalId, storeId, action, solution: cleanSolution }
            : { externalId: order.externalId, storeId, action },
        })
        .then((res) => {
          const data = res?.data as { ok?: boolean; error?: string } | null | undefined;
          if (res?.error || data?.ok === false) {
            const msg = res?.error?.message || data?.error || 'Error desconocido';
            toast.info(
              `Marcada en el CRM ✓. Dropi no aceptó el reporte automático (${msg}) — si la gestionaste desde el panel de Dropi, está bien así.`,
              { id: toastId, duration: 7000 },
            );
          } else {
            toast.success('Dropi: novedad reportada', { id: toastId, duration: 2500 });
          }
          cerrarEnPantalla();
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          // Red caída ≠ gestión inválida: misma regla, la marca se queda.
          toast.info(
            `Marcada en el CRM ✓. No se pudo avisar a Dropi (${msg}) — si la gestionaste desde su panel, está bien así.`,
            { id: toastId, duration: 7000 },
          );
          cerrarEnPantalla();
        });
    } else {
      toast.success('Novedad marcada como resuelta localmente', { duration: 2500 });
      cerrarEnPantalla();
    }
    // storeId va en deps: se usa para el store_id del touchpoint. Sin él, tras
    // cambiar de tienda resolveNovedad escribiría con el store viejo.
  }, [user, storeId]);

  // COST-1: pausa polling cuando la pestaña está oculta.
  useEffect(() => {
    if (!user) return;
    return pollWhenVisible(() => {
      if (novedadesLoaded) loadNovedades(true);
    }, POLL_INTERVAL_MS, { runOnVisible: false });
  }, [user, novedadesLoaded, loadNovedades]);

  return {
    novedadesQueue, setNovedadesQueue, novedadesLoading, novedadesError, loadNovedades, resolveNovedad,
  };
}

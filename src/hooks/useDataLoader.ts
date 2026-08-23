import { pollWhenVisible } from '@/lib/pollWhenVisible';
import { useState, useCallback, useEffect, useRef } from 'react';
import { User } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { OrderData, dbToOrderData } from '@/lib/orderUtils';
import { calcPriority } from '@/lib/alertSystem';
import { POLL_INTERVAL_MS } from '@/lib/constants';
import { ORDER_COLUMNS } from '@/lib/orderColumns';
import { toast } from 'sonner';

/**
 * Smart merge: preserva la referencia de objetos que no cambiaron en campos
 * relevantes para que React no re-renderice las cards intactas durante
 * refreshes periódicos (cron Dropi cada 1 min). Esto elimina el "parpadeo".
 */
export function smartMerge(prev: OrderData[], next: OrderData[]): OrderData[] {
  if (prev.length === 0) return next;
  const prevById = new Map(prev.map(o => [o.dbId || `${o.phone}|${o.idx}`, o]));
  let anyChanged = false;
  const merged = next.map(n => {
    const id = n.dbId || `${n.phone}|${n.idx}`;
    const old = prevById.get(id);
    if (!old) {
      anyChanged = true;
      return n;
    }
    const fieldsChanged = (
      old.estado !== n.estado ||
      old.assignedTo !== n.assignedTo ||
      old.lockedBy !== n.lockedBy ||
      old.lockedAt !== n.lockedAt ||
      old.diasConf !== n.diasConf ||
      old.dias !== n.dias ||
      old.novedad !== n.novedad ||
      old.novedadSol !== n.novedadSol ||
      old.guia !== n.guia ||
      old.transportadora !== n.transportadora ||
      // Seguimiento: cuando Dropi "mueve" un pedido sin cambiar el TEXTO del
      // estado, solo cambia last_movement_at. Sin compararlo, smartMerge
      // preservaba la fila vieja y el conteo de "días sin movimiento" (y la
      // re-clasificación de listas SLA que depende de él) quedaba congelado
      // hasta recargar. Solo cambia en movimientos reales → no genera parpadeo.
      old.lastMovementAt !== n.lastMovementAt ||
      // Confirmar: el branch async de buildWorkQueue (order_results) marca
      // result/reason/retryCount sobre la cola. Sin estos campos, smartMerge
      // preservaría la fila vieja (sin el resultado nuevo) Y, al revés, no
      // detectaría que NO cambió nada en una ráfaga de realtime → reemplazaba
      // el array y re-renderizaba toda la cola (parpadeo).
      old.result !== n.result ||
      old.reason !== n.reason ||
      old.retryCount !== n.retryCount
    );
    if (fieldsChanged) {
      anyChanged = true;
      return n;
    }
    return old;
  });
  // Si nada cambió y la cantidad coincide, devolver prev intacto para que
  // React no re-renderice (preserva scroll).
  if (!anyChanged && prev.length === next.length) {
    return prev;
  }
  return merged;
}

// Fix 22: lista explícita de columnas para queries de orders. Evita SELECT *
// que trae columnas innecesarias en cada fetch. Ahora se importa desde
// `@/lib/orderColumns` para mantener un único source of truth (incluye las
// columnas del validador: validation_decision, address_kind, etc.).

interface DataLoaderState {
  segData: OrderData[];
  setSegData: React.Dispatch<React.SetStateAction<OrderData[]>>;
  segLoaded: boolean;
  setSegLoaded: React.Dispatch<React.SetStateAction<boolean>>;
  segLoading: boolean;
  segLastUpdate: Date | null;
  loadSegData: (force?: boolean) => Promise<void>;
}

export function useDataLoader(user: User | null, storeId: string | null): DataLoaderState {
  const [segData, setSegData] = useState<OrderData[]>([]);
  const [segLoaded, setSegLoaded] = useState(false);
  const [segLoading, setSegLoading] = useState(false);
  const [segLastUpdate, setSegLastUpdate] = useState<Date | null>(null);

  // MULTI-TENANT: useDataLoader es singleton bajo OrderProvider — su estado NO
  // se remonta al cambiar de tienda. Sin esto, `segLoaded` sigue true y el
  // `loadSegData()` (sin force) que dispara SeguimientoTab al cambiar de tienda
  // hace no-op → quedan visibles los pedidos de la tienda ANTERIOR (mezcla).
  // Reseteamos al cambiar storeId para forzar un refetch limpio de la nueva
  // tienda. El ref-guard evita limpiar en el mount inicial (storeId estable).
  const prevStoreRef = useRef<string | null>(storeId);
  useEffect(() => {
    if (prevStoreRef.current === storeId) return;
    prevStoreRef.current = storeId;
    setSegData([]);
    setSegLoaded(false);
  }, [storeId]);

  // Reintento ÚNICO ante error de red: si el refetch que falló era el catch-up
  // al volver a la pestaña, sin esto Seguimiento quedaba viejo hasta el próximo
  // tick del poll de 15 min (auditoría 2026-07-07). `retriedOnceRef` corta la
  // cadena: máximo UN reintento por episodio de fallo (se rearma solo cuando
  // una carga vuelve a salir bien) — sin él, fallo→retry→fallo→retry loopeaba
  // cada 30s con un toast por intento (review 2026-07-07).
  const retryTimerRef = useRef<number | null>(null);
  const retriedOnceRef = useRef(false);
  const inFlightRef = useRef(false);
  const loadSegDataRef = useRef<(force?: boolean) => void>(() => {});
  useEffect(() => () => {
    if (retryTimerRef.current != null) window.clearTimeout(retryTimerRef.current);
  }, []);

  const loadSegData = useCallback(async (force = false) => {
    if (!user || !storeId) return;
    if (segLoaded && !force) return;
    // Guard in-flight: el poll (runOnVisible) y el catch-up de realtime pueden
    // dispararse casi juntos al volver a la pestaña — con esto el segundo se
    // descarta en vez de correr un fetch completo duplicado.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setSegLoading(true);
    try {
      // Paginación: Supabase limita cada SELECT a ~1000 filas por defecto.
      // Leemos en páginas hasta completar o llegar a HARD_LIMIT — evita el
      // antiguo problema de "solo se ven los 5000 más recientes".
      const PAGE_SIZE = 1000;
      const HARD_LIMIT = 20000;
      type Row = Parameters<typeof dbToOrderData>[0];
      const all: Row[] = [];
      let fromIdx = 0;
      while (true) {
        const toIdx = fromIdx + PAGE_SIZE - 1;
        const { data, error } = await supabase
          .from('orders')
          .select(ORDER_COLUMNS)
          .eq('store_id', storeId)
          .not('estado', 'eq', 'PENDIENTE CONFIRMACION')
          .not('estado', 'eq', 'ENTREGADO')
          // Variante EC del mismo terminal — sin esta línea entraba a la data
          // de Seguimiento y el hero la contaba como "en ruta".
          .not('estado', 'eq', 'ENTREGADO A DESTINO')
          .not('estado', 'eq', 'CANCELADO')
          .not('estado', 'eq', 'REEMPLAZADA')
          .not('estado', 'eq', 'RECHAZADO')
          // Prefijos, no literales exactos: 'DEVOLUCION A ORIGEN' (EC),
          // 'DEVUELTO ...' y las variantes con tilde no estaban excluidas y
          // entraban por ACA con el historico completo (esta query no tiene
          // ventana de fecha) — miles de devoluciones viejas contadas como
          // "en ruta". La familia entera entra solo por la query acotada de
          // abajo. Espeja DEVOLUC%/DEVUELT% de _estado_bucket.
          .not('estado', 'ilike', 'DEVOLUC%')
          .not('estado', 'ilike', 'DEVUELT%')
          .not('estado', 'ilike', 'EN PROCESO DE DEVOLUC%')
          .not('estado', 'ilike', '%INDEMNIZADA%')
          // Borrados en Dropi (nightly-reconcile): no son pedidos vivos — sin
          // esto entraban al tablero de Seguimiento como si existieran.
          .not('estado', 'eq', 'ARCHIVADO GHOST')
          .not('estado', 'eq', 'ARCHIVADO_GHOST')
          .order('created_at', { ascending: false })
          .range(fromIdx, toIdx);
        if (error) {
          console.error('Error loading seg orders:', error);
          if (!retriedOnceRef.current) {
            toast.error('Error cargando seguimiento: ' + error.message);
            retriedOnceRef.current = true;
            if (retryTimerRef.current == null) {
              retryTimerRef.current = window.setTimeout(() => {
                retryTimerRef.current = null;
                loadSegDataRef.current(true);
              }, 30_000);
            }
          }
          return;
        }
        // Guard multi-tienda: si la tienda activa cambió con este fetch en
        // vuelo (hasta 20 páginas, varios segundos), la respuesta es de la
        // tienda ANTERIOR — aterrizarla pisaría el reset de arriba y mostraría
        // pedidos de CO bajo el encabezado de EC (mezclar países está
        // prohibido). Se descarta y se relanza para la tienda nueva, porque el
        // load que disparó el cambio de tienda murió en el guard inFlightRef
        // (el setTimeout corre después del finally, ya con inFlight=false).
        // Mismo problema que resuelve el flag `cancelled` de useSegClosedPhones.
        if (prevStoreRef.current !== storeId) {
          window.setTimeout(() => loadSegDataRef.current(true), 0);
          return;
        }
        const rows = (data || []) as Row[];
        all.push(...rows);
        if (rows.length < PAGE_SIZE) break;
        if (all.length >= HARD_LIMIT) {
          toast.warning(`Se cargaron ${HARD_LIMIT} pedidos (tope máx). Pide a un admin subir el límite si faltan pedidos antiguos.`);
          break;
        }
        fromIdx += PAGE_SIZE;
      }
      // DEVOLUCIONES RECIENTES (auditoría 14-ago-2026, artifact fa210631). Los
      // dos filtros exactos de arriba existen porque esta query NO tiene ventana
      // de fecha — sin ellos entraría el histórico completo de devoluciones. El
      // costo era que "se fue a devolución" se volvía INVISIBLE: las columnas
      // Devolución del tablero llevaban meses en 0 en Colombia (las variantes
      // EC pasaban de casualidad por la tilde) y la tarjeta desaparecía en
      // silencio — "se entregó" y "se me fue de vuelta" se veían idéntico.
      // Query aparte y ACOTADA por último movimiento: trae EXACTAMENTE lo que
      // la principal excluye (cero solape) sin cargar años de devoluciones.
      // La misma ventana (30d) usa el chip "Se fue a devolución" de segLists.
      try {
        const devDesde = new Date(Date.now() - 30 * 86_400_000).toISOString();
        // Sin last_movement_at NO se puede afirmar "reciente", pero tratarlo
        // como "no existe" era peor: una devolucion sin fecha de movimiento no
        // aparecia en Seguimiento NI UN DIA (la principal la excluye por estado
        // y esta la excluia por fecha). Entra si el pedido se creo hace <90d.
        const devCreadoDesde = new Date(Date.now() - 90 * 86_400_000).toISOString();
        const { data: devRows, error: devError } = await supabase
          .from('orders')
          .select(ORDER_COLUMNS)
          .eq('store_id', storeId)
          // La misma familia que excluye la principal (cero solape, cero hueco).
          .or('estado.ilike.DEVOLUC%,estado.ilike.DEVUELT%,estado.ilike.EN PROCESO DE DEVOLUC%')
          .or(`last_movement_at.gte.${devDesde},and(last_movement_at.is.null,created_at.gte.${devCreadoDesde})`)
          .order('created_at', { ascending: false })
          .limit(2000);
        if (devError) {
          // No-fatal: sin el extra el tablero sigue sirviendo. Avisar, no caer.
          console.warn('Error cargando devoluciones recientes:', devError.message);
        } else if (prevStoreRef.current === storeId) {
          all.push(...(((devRows || []) as unknown) as Row[]));
        }
      } catch (e) {
        console.warn('Error cargando devoluciones recientes:', e);
      }
      // PEDIDOS SIN ESTADO — el hueco que ningun filtro de arriba puede tapar.
      //
      // En SQL, `NOT (NULL = 'X')` no es TRUE: es NULL, y PostgREST descarta la
      // fila. O sea que cada `.not('estado','eq',...)` de la query principal
      // tambien tira los pedidos con `estado IS NULL` — no aparecen en
      // Seguimiento NUNCA, sin toast ni aviso. `dropi-nightly-reconcile`
      // documenta esta misma trampa dos veces y por eso filtra del lado del
      // cliente; el frontend no habia aplicado la leccion.
      //
      // Medido el 21-ago-2026 en las dos tiendas: CERO filas. Esto es una
      // defensa, no una reparacion — y por eso es barata. El dia que Dropi
      // devuelva un estado vacio, el pedido va a estar a la vista en vez de
      // desaparecer, que es exactamente como se pierden.
      try {
        const { data: sinEstado, error: sinEstadoError } = await supabase
          .from('orders')
          .select(ORDER_COLUMNS)
          .eq('store_id', storeId)
          .is('estado', null)
          .order('created_at', { ascending: false })
          .limit(500);
        if (sinEstadoError) {
          console.warn('Error cargando pedidos sin estado:', sinEstadoError.message);
        } else if (prevStoreRef.current === storeId) {
          all.push(...(((sinEstado || []) as unknown) as Row[]));
        }
      } catch (e) {
        console.warn('Error cargando pedidos sin estado:', e);
      }
      const mapped = all.map((o, idx) => dbToOrderData(o, idx));
      mapped.sort((a, b) => calcPriority(b) - calcPriority(a));
      setSegData(prev => smartMerge(prev, mapped));
      setSegLastUpdate(new Date());
      setSegLoaded(true);
      // Cargó bien → cerrar el episodio de fallo: cancelar reintento pendiente
      // y rearmar el "único reintento" para el próximo episodio.
      retriedOnceRef.current = false;
      if (retryTimerRef.current != null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    } finally {
      inFlightRef.current = false;
      setSegLoading(false);
    }
  }, [user, segLoaded, storeId]);
  loadSegDataRef.current = (force = true) => { void loadSegData(force); };

  // COST-1: auto-refresh cada 15 min. runOnVisible:true → al volver a la
  // pestaña refetchea de una (smartMerge evita el parpadeo/scroll-reset que
  // motivó apagarlo); cubre el caso en que el catch-up de realtime falló.
  useEffect(() => {
    if (!user) return;
    return pollWhenVisible(() => {
      if (segLoaded) loadSegData(true);
    }, 15 * 60 * 1000, { runOnVisible: true });
  }, [user, segLoaded, loadSegData]);

  return {
    segData, setSegData, segLoaded, setSegLoaded, segLoading, segLastUpdate, loadSegData,
  };
}

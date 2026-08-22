import { useState, useEffect, useMemo, useRef, useLayoutEffect, useCallback } from 'react';
import { useOrders } from '@/contexts/OrderContext';
import { findSupersededPendingConfDetailed, findClienteYaDespachado, isLocallyDead, type ProgressedOrder } from '@/lib/duplicateOrders';
import { detectDuplicatePairs } from '@/lib/duplicatePairs';
import { buildActiveDupIndex, type ConfirmarOrderAlerts } from '@/lib/orderAlerts';
import { useShopifyValueMismatches } from '@/hooks/useShopifyPending';
import { useAuth } from '@/contexts/AuthContext';
import { useStore } from '@/contexts/StoreContext';
import { useOrderNotesIndex } from '@/hooks/useOrderNotesIndex';
import { useRiesgoChat } from '@/hooks/useRiesgoChat';
import { compararRiesgo } from '@/lib/riesgoChat';
import { useOperatorNames } from '@/hooks/useOperatorNames';
import { useSessionState } from '@/hooks/useSessionState';
import { supabase } from '@/integrations/supabase/client';
import { formatDateES, OrderData, parseDate, dbToOrderData } from '@/lib/orderUtils';
import { ORDER_COLUMNS } from '@/lib/orderColumns';
import { fetchPendientesDeConfirmar } from '@/lib/fetchPendientes';
import { isLockedByOther } from '@/lib/callQueueNav';
import { MAX_DAILY_ATTEMPTS, COOLDOWN_LABEL, REMIND_LOOKAHEAD_MS, estaAplazado } from '@/lib/confirmarQueue';
import { toast } from 'sonner';
import WorkList, { diasReales } from '@/components/WorkList';
import CallView from '@/components/CallView';
import WorkFilters from '@/components/WorkFilters';
import TasaMetaBanner from '@/components/TasaMetaBanner';
import SiguienteColaBanner from '@/components/SiguienteColaBanner';
import ShopifyPendingPanel from '@/components/confirmar/ShopifyPendingPanel';
import DropiSyncFailuresPanel from '@/components/confirmar/DropiSyncFailuresPanel';
import { MetricsUpdateBanner } from '@/components/MetricsUpdateBanner';
import ClosingReportDialog from '@/components/ClosingReportDialog';
import { AlertTriangle, List, Phone, RefreshCw, CloudDownload, CalendarIcon, X, RotateCcw, Moon, CheckCircle2, XCircle, PhoneOff, ClipboardCheck } from 'lucide-react';
import { motion } from 'framer-motion';
import { TiltCard, CountUp, StatTile, AuroraBackdrop } from '@/components/ui3d';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { cn, bogotaToday, formatCOP } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';


interface Props {
  profile: { display_name: string } | null;
  onLogout: () => void;
}

// Los pills d7/d46 usan `diasReales` de WorkList — la MISMA función con la que
// se colorean las filas. Antes había una copia acá y las dos derivaron.

/** Entrada escalonada: la pantalla se arma de arriba abajo, igual que Logística. */
const fadeUp = (delay = 0) => ({
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35, delay, ease: 'easeOut' as const },
});

export default function ConfirmarTab({ profile }: Props) {
  const { user } = useAuth();
  const { activeStoreId, isOwnerOfActive } = useStore();
  const { workQueue, allOrders, setAllOrders, buildWorkQueue, counter, resetOrders, excelLoaded, setExcelLoaded, myConfirmTouchedToday, gestionPorPedido, gestionCargada, resumenAsesorasHoy, sinRespuestaHoy, coverageConfirmError, markResult } = useOrders();
  // Persist nav state in sessionStorage so a tab discard (common on mobile
  // when operator leaves to the transportadora's tracking page) does not
  // make them lose their place and filters.
  // Nombre de cada asesora para la franja "hoy por asesora" (cache compartido).
  const { nameOf: nombreDeAsesora } = useOperatorNames();
  const [view, setView] = useSessionState<'list' | 'call'>('confirmar:view', 'list');
  const [filter, setFilter] = useSessionState<string>('confirmar:filter', 'pending');
  const [search, setSearch] = useSessionState<string>('confirmar:search', '');
  const [dateFrom, setDateFrom] = useSessionState<string>('confirmar:dateFrom', '');
  const [dateTo, setDateTo] = useSessionState<string>('confirmar:dateTo', '');
  // Toggle "Solo sin tocar" — filtra workQueue para que solo aparezcan los
  // pedidos donde la operadora aún NO ha registrado un order_results hoy.
  // Persiste en sessionStorage para sobrevivir a tab discard de mobile.
  const [onlyUntouched, setOnlyUntouched] = useSessionState<boolean>('confirmar:onlyUntouched', false);
  const [syncing, setSyncing] = useState(false);
  const [autoLoading, setAutoLoading] = useState(false);
  const [closing, setClosing] = useState(false);
  // Pedidos "progresados" (ya reales en Dropi) de los mismos teléfonos de la cola,
  // para detectar PENDIENTE CONFIRMACION duplicados/viejos y ocultarlos (ver abajo).
  const [progressedOrders, setProgressedOrders] = useState<ProgressedOrder[]>([]);
  const [dupExpanded, setDupExpanded] = useState(false);
  // Duplicado VIVO cuya cancelación se está confirmando (AlertDialog).
  // null = sin diálogo abierto. Mismo patrón que NotesPanel.
  const [dupToCancel, setDupToCancel] = useState<OrderData | null>(null);
  const today = bogotaToday();

  // Preservación de scroll: cada refresh de realtime (cron Dropi cada 5 min,
  // vuelta de pestaña, o la validación de dirección que escribe en `orders`)
  // reconstruye la cola y el navegador resetea el scroll al tope → la operadora
  // "salta de arriba abajo". Guardamos la última posición donde dejó el scroll
  // y, si un re-render la tiró hacia arriba, la devolvemos ANTES del paint
  // (useLayoutEffect → sin parpadeo). Mismo objetivo que la preservación de
  // scroll de CrmTable en Seguimiento, que Confirmar no tenía.
  const lastScrollY = useRef(0);
  useEffect(() => {
    const onScroll = () => { lastScrollY.current = window.scrollY; };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Tienda vigente, para que un fetch en vuelo sepa que ya no le corresponde
  // aterrizar. Va DECLARADO ANTES del efecto de carga a propósito: dentro de un
  // mismo commit los efectos corren en orden, así que cuando arranca el fetch
  // el ref ya tiene la tienda buena. Al revés, la primera página se cancelaría
  // sola contra un ref viejo y la cola arrancaría vacía.
  const storeVigenteRef = useRef<string | null>(activeStoreId);
  useEffect(() => { storeVigenteRef.current = activeStoreId; }, [activeStoreId]);

  // Reintento ÚNICO ante fallo de la carga inicial. Sin esto, el error hacía
  // setAutoLoading(false) SIN marcar excelLoaded → el efecto (autoLoading está en
  // sus deps) se relanzaba EN EL ACTO → refetch → error → toast, en bucle
  // martillando la DB (escenario típico de una tienda nueva con RLS a medio
  // aplicar). Mismo patrón que useDataLoader: corta el loop marcando cargado y
  // reintenta UNA sola vez tras 30s; se rearma al próximo montaje.
  const autoLoadRetryTimerRef = useRef<number | null>(null);
  const autoLoadRetriedRef = useRef(false);
  useEffect(() => () => {
    if (autoLoadRetryTimerRef.current != null) window.clearTimeout(autoLoadRetryTimerRef.current);
  }, []);

  // Auto-load orders from DB on mount if not already loaded. Uses a strict
  // eq() match on PENDIENTE CONFIRMACION instead of ilike('%PENDIENTE%') —
  // the old filter also matched "PENDIENTE" (locally confirmed) and
  // re-surfaced them in the queue. It also handles both the `error` channel
  // and a Promise rejection so a failing query can't leave the spinner
  // hanging forever — that is the eternal "Cargando..." Fabian hit when
  // the Dropi sync fell over.
  useEffect(() => {
    if (excelLoaded || !user || autoLoading) return;
    if (!activeStoreId) return;
    setAutoLoading(true);
    // Sin filtro de lock en el SERVIDOR (2026-07-31). Antes esta primera carga
    // traía `.or(locked_by.is.null, locked_by.eq.yo, locked_at.lt.15min)`, y eso
    // tenía dos problemas:
    //   1. Un pedido con `locked_by` puesto pero `locked_at` NULL no cumplía
    //      NINGUNA de las tres condiciones (en SQL, NULL < X no es verdadero) →
    //      desaparecía de la cola de esa asesora PARA SIEMPRE, sin aviso.
    //   2. `loadWorkQueue` (el refresh) nunca tuvo ese filtro: al arrancar se
    //      veían menos pedidos que treinta segundos después. Dos caminos, dos
    //      colas distintas.
    // El anti-choque real lo hace `isLockedByOther` en el cliente, que además
    // sabe soltar el pedido cuando el lock vence y trata el `locked_at` nulo
    // como "sin lock" (mejor mostrar de más que perder una venta).
    // Misma función que usa `loadWorkQueue` (OrderContext): antes eran dos
    // queries escritas aparte y ninguna paginaba — PostgREST corta en ~1000
    // filas sin avisar y los pendientes de más no los veía nadie.
    // Guard de tienda: el paginado puede tardar varios segundos y la asesora
    // puede cambiar de tienda mientras tanto. Aterrizar la respuesta vieja
    // llenaría la cola con pedidos de Colombia bajo el encabezado de Ecuador —
    // y llamar a uno de esos escribe la gestión con el store_id equivocado.
    // Mezclar países está prohibido en esta operación.
    //
    // Con un flag + cleanup del efecto NO se puede: `autoLoading` está en las
    // deps y se setea acá arriba, así que el efecto se relanza en el acto, el
    // cleanup marcaría cancelado y la carga inicial no aterrizaría NUNCA. Por
    // eso el guard mira un ref con la tienda vigente, no el ciclo del efecto.
    const storeDeEstaCarga = activeStoreId;
    const esDeOtraTienda = () => storeVigenteRef.current !== storeDeEstaCarga;
    // Corta el loop de reintento: marca cargado (para que el efecto no se relance
    // en el acto) y programa UN reintento tras 30s por si fue un blip de red.
    const onErrorCarga = (mensaje: string) => {
      toast.error(mensaje);
      setAutoLoading(false);
      setExcelLoaded(true);
      if (!autoLoadRetriedRef.current) {
        autoLoadRetriedRef.current = true;
        autoLoadRetryTimerRef.current = window.setTimeout(() => {
          if (!esDeOtraTienda()) setExcelLoaded(false); // habilita un único reintento
        }, 30000);
      }
    };
    fetchPendientesDeConfirmar(storeDeEstaCarga, esDeOtraTienda)
      .then(({ filas: dbOrders, error, truncado }) => {
        if (esDeOtraTienda()) return;
        if (error) {
          console.error('Error loading orders:', error);
          onErrorCarga('Error cargando pedidos: ' + error);
          return;
        }
        if (truncado) toast.warning('Hay tantos pendientes que no caben todos en pantalla. Avisá para subir el tope.');
        if (dbOrders.length > 0) {
          const orders = dbOrders.map((o, idx) => dbToOrderData(o as Parameters<typeof dbToOrderData>[0], idx));
          setAllOrders(orders);
          buildWorkQueue(orders);
        }
        // Fix D7: marcar como cargado SIEMPRE que la query termine sin
        // error, incluso si vino vacía. Antes solo se marcaba con
        // dbOrders.length > 0, así que en días con cero pedidos disponibles
        // la pantalla quedaba en spinner eterno + AperturaWizard genérico.
        setExcelLoaded(true);
        setAutoLoading(false);
      }, (err: unknown) => {
        if (esDeOtraTienda()) return;
        const msg = err instanceof Error ? err.message : String(err);
        console.error('Network error loading orders:', err);
        onErrorCarga('Error de red: ' + msg);
      });
  }, [user, excelLoaded, today, autoLoading, activeStoreId]);

  // La carga manual por Excel se eliminó (2026-07-31, decisión del dueño). Los
  // pedidos entran SOLO por la API de Dropi (cron cada 15 min + el botón de
  // abajo). El upsert del Excel usaba onConflict:'external_id', que es UNIQUE
  // GLOBAL entre tiendas: subir el archivo de Ecuador con Colombia activa le
  // reescribía el store_id a las filas de la otra tienda — la mezcla de países
  // que esta operación tiene PROHIBIDA (incidente 2026-07-21).

  // Firma estable del conjunto de teléfonos de la cola. El efecto de abajo
  // depende de ESTO, no del array `workQueue`: una ráfaga de realtime que
  // reconstruye `workQueue` con los MISMOS teléfonos no re-dispara la query
  // (antes re-consultaba Supabase + setProgressedOrders en cada refresh →
  // cascada de re-render que alimentaba el parpadeo).
  const phoneSig = useMemo(
    () => Array.from(new Set(workQueue.map(o => o.phone).filter(Boolean))).sort().join('|'),
    [workQueue],
  );

  // Traer los pedidos YA reales en Dropi (no PENDIENTE CONFIRMACION, no CANCELADO)
  // de los mismos teléfonos que están en la cola, para detectar duplicados viejos.
  useEffect(() => {
    const phones = phoneSig ? phoneSig.split('|') : [];
    if (!activeStoreId || phones.length === 0) { setProgressedOrders([]); return; }
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    let cancelled = false;
    supabase.from('orders')
      .select('phone, producto, external_id, estado, fecha, created_at')
      .eq('store_id', activeStoreId)
      .in('phone', phones)
      .not('estado', 'ilike', 'PENDIENTE CONFIRMACION')
      .neq('estado', 'CANCELADO')
      .neq('estado', 'REEMPLAZADA')
      // ARCHIVADO GHOST = borrado en Dropi (nightly-reconcile). NO es un "pedido
      // real más nuevo": dejarlo entrar acá ocultaba el PENDIENTE legítimo del
      // mismo cliente y lo pintaba como "DUPLICADO VIVO" con botón de cancelar
      // — la asesora cancelaba el ÚNICO pedido real (auditoría 2026-08-13).
      .neq('estado', 'ARCHIVADO GHOST')
      .neq('estado', 'ARCHIVADO_GHOST')
      .gte('created_at', since)
      .then(({ data, error }) => {
        if (cancelled || error || !data) return;
        setProgressedOrders(data as ProgressedOrder[]);
      }, () => { /* red: dejamos la cola sin filtrar (no rompemos Confirmar) */ });
    return () => { cancelled = true; };
  }, [phoneSig, activeStoreId]);

  // Duplicados: PENDIENTE CONFIRMACION ya superados por un pedido real más nuevo
  // del mismo cliente+producto. Se ocultan de la cola, pero desde el incidente
  // 2026-07-13 (#6107398 vivo en Dropi, oculto sin botones, nadie lo podía
  // cancelar → riesgo de doble despacho) se separan en dos destinos:
  //  - muertos localmente (cancelado/reemplazado/rechazado) → panel pasivo.
  //  - VIVOS → tarjeta roja accionable con "Cancelar en Dropi".
  const supersededMap = useMemo(
    () => findSupersededPendingConfDetailed(workQueue, progressedOrders),
    [workQueue, progressedOrders],
  );
  const supersededIds = useMemo(
    () => new Set(supersededMap.keys()),
    [supersededMap],
  );
  const visibleQueue = useMemo(
    () => workQueue.filter(o => !supersededIds.has(String(o.externalId))),
    [workQueue, supersededIds],
  );
  const hiddenDuplicates = useMemo(
    () => workQueue.filter(o => supersededIds.has(String(o.externalId))),
    [workQueue, supersededIds],
  );
  // Split del incidente: solo los muertos localmente van al panel pasivo.
  const hiddenDeadDups = useMemo(
    () => hiddenDuplicates.filter(o => isLocallyDead(o.estado)),
    [hiddenDuplicates],
  );
  const liveDups = useMemo(
    () => hiddenDuplicates.filter(o => !isLocallyDead(o.estado)),
    [hiddenDuplicates],
  );

  // ⚠ YA REENVIADO (pares stub+reenvío, auditoría 2026-07-12): el mismo
  // teléfono tiene DOS pedidos ACTIVOS (PENDIENTE / PENDIENTE CONFIRMACION) —
  // típico bot LucidBot: al reenviar/editar, Dropi crea un # nuevo y el viejo
  // queda vivo. Cruzamos la cola visible con los "progressed" de esos mismos
  // teléfonos (incluyen los PENDIENTE del reenvío, ya cargados arriba — cero
  // queries extra) y señalamos el pedido VIEJO del par para que la asesora
  // gestione el # nuevo y no confirme/cancele la guía equivocada.
  const resentOldInQueue = useMemo(() => {
    const pairs = detectDuplicatePairs([
      ...visibleQueue.map(o => ({
        externalId: String(o.externalId ?? ''),
        phone: o.phone,
        estado: o.estado,
        createdAt: o.createdAt ?? null,
      })),
      ...progressedOrders.map(p => ({
        externalId: String(p.external_id ?? ''),
        phone: p.phone,
        estado: p.estado,
        createdAt: p.created_at ?? null,
      })),
    ]);
    // Solo señalamos viejos que están EN la cola visible (fila accionable acá)
    // y aún sin gestionar.
    const byExt = new Map(visibleQueue.map(o => [String(o.externalId ?? ''), o]));
    const out: Array<{ order: OrderData; nuevoId: string }> = [];
    for (const { viejo, nuevo } of pairs.values()) {
      const row = byExt.get(viejo.externalId);
      if (row && !row.result) out.push({ order: row, nuevoId: nuevo.externalId });
    }
    return out;
  }, [visibleQueue, progressedOrders]);

  // ⚠ CLIENTE CON PEDIDO YA DESPACHADO (caso real en Colombia, 18-ago-2026):
  // #86118300 seguía PENDIENTE CONFIRMACION mientras #86142163, del mismo
  // cliente y por la misma plata, YA tenía guía. La asesora no veía nada e iba
  // a despachar un segundo paquete. Los dos avisos de arriba no lo agarran: uno
  // exige que el producto coincida EXACTO (una edición de cantidad lo rompe, y
  // es justo cuando nace el duplicado) y el otro solo mira pedidos ACTIVOS.
  //
  // Este matcher es MÁS LAXO, así que SOLO AVISA: no oculta la fila ni ofrece
  // cancelar. Un cliente puede comprar dos veces de verdad, y cancelar por
  // sospecha ya mató el pedido REAL de un cliente antes.
  const clienteYaDespachado = useMemo(() => {
    const yaSenalados = new Set<string>([
      ...supersededIds,
      ...resentOldInQueue.map(r => String(r.order.externalId ?? '')),
    ]);
    const m = findClienteYaDespachado(visibleQueue, progressedOrders, yaSenalados);
    const byExt = new Map(visibleQueue.map(o => [String(o.externalId ?? ''), o]));
    const out: Array<{ order: OrderData; otroId: string; otroEstado: string | null }> = [];
    for (const [extId, info] of m) {
      const row = byExt.get(extId);
      if (row && !row.result) out.push({ order: row, otroId: info.nuevoId, otroEstado: info.estado });
    }
    return out;
  }, [visibleQueue, progressedOrders, supersededIds, resentOldInQueue]);

  // Alertas POR PEDIDO para CallView/WorkList (chips en la ficha misma):
  //  - duplicado: cliente con OTRO pedido en curso (Dropi o repetido en la cola)
  //  - sobreprecio: valor Dropi > total Shopify (mismo dato del banner de arriba;
  //    React Query dedupea con la instancia de ShopifyPendingPanel — 0 requests extra)
  const { data: vmDataTab } = useShopifyValueMismatches(activeStoreId);
  const orderAlerts = useMemo<ConfirmarOrderAlerts>(() => {
    const mismatchByExt = new Map<string, number>();
    for (const m of vmDataTab?.valueMismatches ?? []) {
      // Cancelados en Dropi no se despachan → no hay cobro de más (mismo filtro
      // que el banner del panel).
      if (/CANCEL/i.test(String(m.estado ?? ''))) continue;
      if (m.external_id) mismatchByExt.set(String(m.external_id), Number(m.shopify_total) || 0);
    }
    return {
      dupByPhone: buildActiveDupIndex(visibleQueue, progressedOrders),
      mismatchByExt,
    };
  }, [vmDataTab, visibleQueue, progressedOrders]);

  // Notas/recordatorios agregados por pedido (1 sola query, no N). El hook
  // se suscribe a realtime para que cuando otra asesora deje una nota, todos
  // los listados se actualicen.
  const queueOrderIds = useMemo(
    () => visibleQueue.map(o => o.dbId).filter((id): id is string => !!id),
    [visibleQueue],
  );
  const notesIndex = useOrderNotesIndex(activeStoreId, queueOrderIds);
  // Qué hizo el cliente con el botón de confirmar del WhatsApp. Query aparte
  // (no va en ORDER_COLUMNS: una columna sin migrar tumba TODA pantalla que
  // cargue pedidos). Con la sincronización apagada el índice queda vacío y
  // nada de lo de abajo cambia. Ver `useRiesgoChat`.
  const { index: riesgoIndex } = useRiesgoChat(activeStoreId, queueOrderIds);
  // "Recordatorios para hoy/ahora": recordatorio que llega en ≤1h o ya vencido.
  // La constante vive en confirmarQueue para que el chip, este filtro y
  // `estaAplazado` usen el MISMO número (antes estaba duplicada en dos archivos).

  /** ¿Este pedido está aplazado (reagendado a futuro)? Necesita el notesIndex. */
  const esAplazado = useCallback((o: OrderData, now = Date.now()) => (
    estaAplazado(
      { result: o.result, nextReminderAt: o.dbId ? notesIndex.get(o.dbId)?.nextReminderAt : null },
      now,
    )
  ), [notesIndex]);

  // Memoizado: sin esto, `filteredItems` era un array nuevo en CADA render
  // (incluido cada refresh de realtime), forzando a WorkList/CallView a
  // re-renderizar aunque el contenido fuera idéntico.
  const filteredItems = useMemo(() => visibleQueue.filter(o => {
    // ANTI-CHOQUE (Fase 1, 2026-07-07): esconder de MI cola lo que otra asesora
    // está atendiendo AHORA (lock fresco <15 min, ajeno). Así no me lo topo, no me
    // rebota al aterrizar, y puedo retroceder sin caer en un pedido de otra. Nunca
    // esconde el que YO tengo en pantalla (lock mío). Reaparece solo cuando se libera
    // (el realtime de orders ya trae el cambio de locked_by → recomputa este memo).
    // Todo automático: la asesora no hace nada.
    if (isLockedByOther(o, user?.id ?? null, Date.now())) return false;
    // Toggle "Solo sin tocar" — los pedidos que ya marqué (cualquier result)
    // se ocultan. Útil cuando me quedan los noresp pendientes pero no quiero
    // ver los que ya gestioné hoy. Un pedido sin dbId no cae en el set y se
    // muestra igual (mejor mostrar que perder).
    // Con coverageConfirmError el set está vacío/parcial (la query falló):
    // filtrar contra un set roto escondería/mostraría pedidos mal → el toggle
    // se ignora (y el checkbox se desactiva en el chip "Tu cola hoy").
    // El toggle es de EQUIPO, no personal (cambio 2026-07-31, pedido del dueño:
    // "para yo no tener que preguntarles si esos ya los llamaron"). Antes solo
    // miraba `myConfirmTouchedToday`, así que a una asesora le seguían saliendo
    // como "sin tocar" los pedidos que una compañera ya había llamado esa
    // mañana — y se repetía la llamada al mismo cliente. `gestionPorPedido`
    // incluye mis propias llamadas, pero se deja el set personal como respaldo
    // por si el mapa de equipo todavía no cargó.
    //
    // EXCEPCIÓN: un pedido LISTO PARA REINTENTAR nunca se esconde. No contestó,
    // paso el enfriamiento y volvio a la cola justamente para que alguien lo llame de
    // nuevo; esconderlo por "ya lo llamaron" apaga el sistema de reintentos y
    // el cliente se queda sin las llamadas que le quedaban.
    const listoParaReintentar = !!o.retryCount && !o.result;
    if (onlyUntouched && !coverageConfirmError && o.dbId && !listoParaReintentar
      && (gestionPorPedido.has(o.dbId) || myConfirmTouchedToday.has(o.dbId))) return false;
    // APLAZADOS (reagendados a futuro): fuera de "Pendientes" — el cliente pidió
    // que lo llamaran otro día y aparecer hoy es volver a llamarlo hoy. NO se
    // pierden: tienen su propio chip con la cuenta y su propia lista, y vuelven
    // solos al tope cuando el recordatorio vence.
    if (filter === 'pending' && esAplazado(o)) return false;
    if (filter === 'aplazado' && !esAplazado(o)) return false;
    if (filter === 'pending' && o.result) return false;
    if (filter === 'conf' && o.result !== 'conf') return false;
    if (filter === 'canc' && o.result !== 'canc') return false;
    if (filter === 'noresp' && o.result !== 'noresp') return false;
    // 'retry' = los que no contestaron antes y ya cumplieron el cooldown (banner naranja).
    if (filter === 'retry' && !(o.retryCount && !o.result)) return false;
    // 'remind' = recordatorio que llega en ≤1h o ya pasó (visible para que la
    // asesora actúe sin tener que abrir cada pedido).
    if (filter === 'remind') {
      const r = o.dbId ? notesIndex.get(o.dbId)?.nextReminderAt : null;
      if (!r) return false;
      const t = Date.parse(r);
      if (!Number.isFinite(t) || t > Date.now() + REMIND_LOOKAHEAD_MS) return false;
    }
    if (filter.startsWith('prod_') && o.producto !== filter.slice(5)) return false;
    // Date filter
    if (dateFrom || dateTo) {
      const orderDate = parseDate(o.fecha);
      if (!orderDate) return false;
      const orderDateStr = orderDate.toISOString().split('T')[0];
      if (dateFrom && orderDateStr < dateFrom) return false;
      if (dateTo && orderDateStr > dateTo) return false;
    }
    if (search) {
      const s = search.toLowerCase();
      return o.nombre.toLowerCase().includes(s) || o.phone.includes(s) || o.ciudad.toLowerCase().includes(s);
    }
    return true;
  }).sort((a, b) => {
    // Reordenar por lo que hizo el CLIENTE. `buildWorkQueue` ya ordenó con
    // `compareConfirmar`, pero esta señal llega después (query aparte), así que
    // se aplica acá — mismo lugar donde el recordatorio se integra.
    //
    // Solo desempata: `compararRiesgo` trata la ausencia de señal como neutro,
    // así que con el índice vacío devuelve 0 para todo par y `Array.sort`
    // conserva el orden que ya venía (es estable desde ES2019).
    const ra = a.dbId ? riesgoIndex.get(a.dbId) ?? null : null;
    const rb = b.dbId ? riesgoIndex.get(b.dbId) ?? null : null;
    return compararRiesgo(ra, rb);
  }), [visibleQueue, filter, search, dateFrom, dateTo, notesIndex, riesgoIndex, onlyUntouched, myConfirmTouchedToday, gestionPorPedido, coverageConfirmError, user?.id, esAplazado]);

  // Si el rebuild de la cola (cambio de `filteredItems` por un refresh) tiró el
  // scroll hacia el tope, lo restauramos. Solo actúa cuando saltó claramente
  // hacia arriba (firma del "salta al tope"); no pelea con el scroll normal ni
  // con un scroll deliberado de la operadora.
  useLayoutEffect(() => {
    const saved = lastScrollY.current;
    if (saved > 50 && window.scrollY < saved - 20) {
      window.scrollTo(0, saved);
    }
  }, [filteredItems]);

  const total = counter.conf + counter.canc + counter.noresp;
  // "por confirmar" debe alinearse con lo que la operadora realmente ve/puede
  // accionar: la lista (filteredItems) esconde los lockeados por otra asesora
  // (isLockedByOther). Si el headline los contara, superaría la lista.
  const pending = visibleQueue.filter(
    o => !o.result && !isLockedByOther(o, user?.id ?? null, Date.now()),
  ).length;

  return (
    <div className="relative max-w-5xl mx-auto space-y-5">
      {/* Header-hero (MOLDE 1): los dos orbes hechos a mano que vivían sueltos
          detrás de toda la página los reemplaza <AuroraBackdrop/>, el componente
          del DS, contenido DENTRO del header — el mismo tratamiento que el hero
          de Logística. Exige `relative overflow-hidden` acá y `relative` en cada
          hijo hermano para que el contenido quede por encima. */}
      <motion.header
        {...fadeUp(0)}
        className="relative overflow-hidden rounded-3xl border border-border bg-card/40 p-5 shadow-card3d-lg hairline-top flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"
      >
        <AuroraBackdrop />
        <div className="relative min-w-0 space-y-1.5">
          <div className="hud-label truncate text-accent">
            Cola · Operadora
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-3">
            <span className="inline-flex w-11 h-11 rounded-2xl bg-accent/14 border border-accent/30 text-accent glow-accent items-center justify-center shrink-0" aria-hidden="true">
              <Phone size={20} strokeWidth={2.25} />
            </span>
            Confirmar
          </h1>
          <p className="text-sm text-muted-foreground">
            {formatDateES(today)} · Cola de pedidos pendientes de confirmación.
          </p>
        </div>

        <div className="relative flex items-center gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={() => setClosing(true)} className="gap-1.5 h-9 rounded-xl bg-card/40 border-border hover:border-border-strong">
            <Moon size={14} /> Cerrar turno
          </Button>
          {excelLoaded && (
            <button
              onClick={() => {
                resetOrders();
                setExcelLoaded(false);
                try {
                  sessionStorage.removeItem('confirmar:view');
                  sessionStorage.removeItem('confirmar:filter');
                  sessionStorage.removeItem('confirmar:search');
                  sessionStorage.removeItem('confirmar:dateFrom');
                  sessionStorage.removeItem('confirmar:dateTo');
                  sessionStorage.removeItem('confirmar:callIdx');
                  sessionStorage.removeItem('confirmar:callOrderId');
                } catch { /* storage disabled */ }
              }}
              className="inline-flex h-9 items-center gap-1.5 px-3 rounded-xl bg-card/40 border border-border text-xs font-semibold text-muted-foreground hover:text-foreground hover:border-border-strong transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              Recargar cola
            </button>
          )}
        </div>
      </motion.header>

      {/* Aviso al equipo: cambio en cómo se cuenta noresp (dedup por
          order_id, espeja RPC v20260505184140). Dismissible y persiste
          el cierre en localStorage por id. expiresAt evita banner zombi. */}
      <MetricsUpdateBanner
        id="dedup-noresp-2026-05-05"
        expiresAt="2026-05-19"
        message="Métricas actualizadas — el contador de 'no contestó' ahora dedupea reintentos del cooldown 2h. Tu rendimiento real puede ajustar ligeramente."
      />

      <TasaMetaBanner />

      {/* Contador anti-fuga: pedidos de Shopify que aún no llegaron a Dropi. */}
      <ShopifyPendingPanel />

      {/* Gestiones (conf/canc) que quedaron en el CRM pero NO llegaron a Dropi
          (order_results dropi_sync_status='failed') — visibles + reintento manual. */}
      <DropiSyncFailuresPanel />

      <ClosingReportDialog open={closing} onClose={() => setClosing(false)} />

      {autoLoading && (
        <div className="flex flex-col items-center justify-center py-16 gap-4" role="status" aria-live="polite">
          <RefreshCw size={32} className="text-accent animate-spin" aria-hidden="true" />
          <div className="text-center">
            <p className="text-sm font-semibold text-foreground">Cargando pedidos...</p>
            <p className="text-xs text-muted-foreground mt-1">Recuperando datos de la base de datos</p>
          </div>
        </div>
      )}

      {/* SEGUNDO formulario de apertura, quitado junto con el del layout
          (2026-07-19). Con la cola sin cargar, la asesora se topaba con OTRO
          cuestionario antes de verla — el mismo trámite, dos veces.
          `AperturaWizard` no se borra: queda en el repo por si el dueño quiere
          recuperar la carga manual de esos números, solo que ya no se monta. */}

      {/* Pantalla vacía: la cola se llena desde Dropi. El botón que sincroniza es
          SOLO del dueño (dropi-sync es owner-only: a una operadora le daba
          "Error sincronizando: Edge Function returned a non-2xx status code" =
          "el CRM está roto" en su primer día). El equipo ve un mensaje claro. */}
      {!autoLoading && !excelLoaded && !isOwnerOfActive && (
        <div className="rounded-2xl bg-card/40 border border-border p-6 text-center">
          <p className="text-sm font-semibold text-foreground">Todavía no hay pedidos para confirmar</p>
          <p className="text-xs text-muted-foreground mt-1">
            El dueño de la tienda los trae desde Dropi. Apenas sincronice, aparecen acá.
          </p>
        </div>
      )}
      {!autoLoading && !excelLoaded && isOwnerOfActive && (
        <div className="space-y-3">
          <button
            onClick={async () => {
              if (!user) return;
              if (!activeStoreId) { toast.error('Sin tienda activa'); return; }
              setSyncing(true);
              try {
                const { data, error } = await supabase.functions.invoke('dropi-sync', {
                  body: { store_id: activeStoreId },
                });
                if (error) throw error;
                if (data?.synced > 0 || data?.total > 0) {
                  // Esta recarga filtraba con `eq` mientras la carga inicial y
                  // `loadWorkQueue` filtraban con `ilike`: un estado guardado con
                  // otra caja aparecía o desaparecía según por dónde se llegara.
                  // Ahora las tres son la MISMA función, y pagina.
                  const { filas: dbOrders, truncado } = await fetchPendientesDeConfirmar(activeStoreId);
                  if (truncado) toast.warning('Hay tantos pendientes que no caben todos en pantalla. Avisá para subir el tope.');
                  if (dbOrders.length > 0) {
                    const orders = dbOrders.map((o, idx) => dbToOrderData(o as never, idx));
                    setAllOrders(orders);
                    buildWorkQueue(orders);
                    setExcelLoaded(true);
                    toast.success(`${dbOrders.length} pedidos cargados desde Dropi`);
                  }
                } else {
                  toast.info(data?.message || 'No hay pedidos nuevos en Dropi');
                }
              } catch (err: unknown) {
                toast.error('Error sincronizando: ' + (err instanceof Error ? err.message : 'Error desconocido'));
              } finally {
                setSyncing(false);
              }
            }}
            disabled={syncing}
            className="relative overflow-hidden w-full flex items-center justify-center gap-3 py-5 px-5 rounded-2xl bg-card/40 border border-border shadow-card3d hairline-top hover:border-accent/40 transition-colors duration-200 cursor-pointer group focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none disabled:cursor-not-allowed"
          >
            {/* Halo de acento detrás del CTA: es la única acción de la pantalla
                vacía, tiene que verse como tal y no como una fila más. */}
            <span className="pointer-events-none absolute -left-8 -top-16 w-56 h-56 rounded-full blur-[50px] bg-accent/20" aria-hidden="true" />
            <div className="relative w-11 h-11 rounded-2xl bg-gradient-to-br from-accent/30 to-accent/10 border border-accent/30 text-accent glow-accent flex items-center justify-center group-hover:from-accent/45 group-hover:to-accent/20 transition-colors duration-200">
              {syncing ? <RefreshCw size={20} className="text-accent animate-spin" aria-hidden="true" /> : <CloudDownload size={20} className="text-accent" aria-hidden="true" />}
            </div>
            <div className="relative text-left">
              <div className="text-sm font-semibold text-foreground">
                {syncing ? 'Sincronizando...' : 'Sincronizar desde Dropi'}
              </div>
              <div className="text-[10px] text-muted-foreground">Descarga automáticamente los pedidos del día</div>
            </div>
          </button>
        </div>
      )}

      {/* Guía entre colas: al terminar Confirmar, la lleva a Novedades →
          Seguimiento con lo que falta. Se auto-oculta si aún le falta confirmar
          o si es admin. Recibe supersededIds para que "terminé Confirmar" use
          el MISMO criterio que el headline: un duplicado oculto sin cancelar
          no debe bloquear el banner para siempre. */}
      <SiguienteColaBanner supersededIds={supersededIds} />

      {excelLoaded && workQueue.length === 0 && (
        <div className="relative overflow-hidden flex flex-col items-center justify-center py-16 text-center rounded-3xl border border-border bg-card/40 shadow-card3d hairline-top" role="status" aria-live="polite">
          <AuroraBackdrop />
          <div className="relative w-14 h-14 rounded-2xl bg-success/14 border border-success/30 text-success glow-success shadow-card3d flex items-center justify-center mb-4">
            <Phone size={24} aria-hidden="true" />
          </div>
          <h3 className="relative text-base font-semibold text-foreground mb-1">No hay pedidos disponibles para confirmar</h3>
          <p className="relative text-sm text-muted-foreground max-w-md">
            Espera al próximo sync con Dropi o sincronizá vos misma desde el inicio.
          </p>
          <button
            onClick={() => { resetOrders(); setExcelLoaded(false); }}
            className="relative mt-4 text-sm px-3 py-2 rounded-xl bg-card/40 border border-border text-muted-foreground font-medium hover:text-foreground hover:border-border-strong transition-colors"
          >
            Volver al inicio
          </button>
        </div>
      )}

      {excelLoaded && workQueue.length > 0 && (
        <>
          {/* Chip "Tu cola hoy" — cobertura por operadora. La queja del usuario
              fue: "no sé si Mayra YA llamó a las 20 o si le faltan 5". Este
              chip lo resuelve por encima del KPI: muestra cuántos ya tocaste
              HOY (cualquier resultado) y cuántos pendientes te quedan SIN
              tocar. `tocadosHoy` cuenta a TODOS los pedidos del día (incluye
              confirmados que ya no están en la cola); `faltanEnCola` cuenta
              solo los pendientes que todavía no marcaste — accionable. */}
          {(() => {
            const tocadosHoy = myConfirmTouchedToday.size;
            // Contar sobre EL MISMO arreglo que alimenta la lista (filteredItems,
            // ya con isLockedByOther + filtro 'pending'/activo + fecha/búsqueda
            // aplicados). Antes se contaba sobre visibleQueue crudo → el chip
            // decía 8 pero la lista mostraba 5 y no bajaba (divergían).
            const sinTocarEnCola = filteredItems.filter(o => !o.dbId || !myConfirmTouchedToday.has(o.dbId)).length;
            // Población de EQUIPO: de los que están a la vista, a cuántos ya
            // llamó ALGUIEN hoy y a cuántos no los ha llamado nadie. Es la cifra
            // que el dueño pedía para no tener que preguntar. `gestionCargada`
            // separa "nadie llamó" (dato) de "todavía no leímos" (nada).
            const equipoLlamo = gestionCargada
              ? filteredItems.filter(o => o.dbId && gestionPorPedido.has(o.dbId)).length
              : 0;
            const nadieLlamo = gestionCargada
              ? filteredItems.filter(o => !o.dbId || !gestionPorPedido.has(o.dbId)).length
              : sinTocarEnCola;
            // Contrato de honestidad de OrderContext: coverageConfirmError=true
            // significa que la query de cobertura FALLÓ — el set no es "cero",
            // es DATO AUSENTE. Un 0 acá le diría a una asesora con 40 llamadas
            // "no llamaste a nadie". Se muestra "—" en tono NEUTRO (no rojo:
            // no sabemos si algo está mal, no sabemos nada) y se desactiva el
            // checkbox, porque filtrar con un set roto escondería pedidos mal.
            const tone = coverageConfirmError
              ? 'neutral'
              : sinTocarEnCola === 0
                ? 'success'
                : sinTocarEnCola >= Math.max(1, Math.ceil(filteredItems.length / 2))
                  ? 'danger'
                  : 'warning';
            // Clases LITERALES por tono. La versión anterior armaba
            // `text-${tone}` en runtime: Tailwind escanea el texto del archivo,
            // así que esa clase nunca se generaba y la cifra clave del banner
            // —cuántos te faltan— salía del color del texto normal.
            const skin = tone === 'success'
              ? { bar: 'bg-success', box: 'border-success/30 bg-success/10', chip: 'bg-success/20 text-success glow-success', num: 'text-success' }
              : tone === 'warning'
                ? { bar: 'bg-warning', box: 'border-warning/30 bg-warning/10', chip: 'bg-warning/20 text-warning glow-warning', num: 'text-warning' }
                : tone === 'danger'
                  ? { bar: 'bg-danger', box: 'border-danger/30 bg-danger/10', chip: 'bg-danger/20 text-danger glow-danger', num: 'text-danger' }
                  : { bar: 'bg-muted-foreground/40', box: 'border-border bg-card/40', chip: 'bg-foreground/10 text-muted-foreground', num: 'text-muted-foreground' };
            return (
              <div className={`relative mb-3 rounded-2xl border ${skin.box} px-4 py-3 pl-5 shadow-card3d flex items-center flex-wrap gap-x-4 gap-y-2`}>
                <span className={`absolute left-0 top-3 bottom-3 w-1 rounded-full ${skin.bar}`} aria-hidden="true" />
                <span className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${skin.chip}`} aria-hidden="true">
                  <ClipboardCheck size={17} />
                </span>
                <div className="text-sm font-semibold text-foreground">
                  Tu cola hoy
                </div>
                {coverageConfirmError ? (
                  <div className="text-xs text-muted-foreground flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span>
                      Has llamado a <span className="text-base font-bold text-muted-foreground">—</span>
                    </span>
                    <span className="opacity-50">·</span>
                    <span className="italic">no se pudo leer tu avance de hoy</span>
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span>
                      Has llamado a <CountUp value={tocadosHoy} className="text-base font-bold text-foreground" />
                    </span>
                    <span className="opacity-50">·</span>
                    {gestionCargada && (
                      <>
                        <span title="Cuenta las llamadas de TODO el equipo, no solo las tuyas">
                          El equipo ya llamó a <CountUp value={equipoLlamo} className="text-base font-bold text-foreground" /> de esta lista
                        </span>
                        <span className="opacity-50">·</span>
                      </>
                    )}
                    <span>
                      {nadieLlamo === 1 ? 'Falta' : 'Faltan'}{' '}
                      <CountUp value={nadieLlamo} className={`text-base font-bold ${skin.num}`} />{' '}
                      {gestionCargada ? 'que nadie llamó' : 'sin tocar'}
                      {nadieLlamo === 0 && <span className="text-success ml-1">✓</span>}
                    </span>
                  </div>
                )}
                <label
                  className={`ml-auto inline-flex items-center gap-2 text-xs text-muted-foreground select-none ${coverageConfirmError ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                  title={coverageConfirmError ? 'Desactivado: no se pudo leer tu avance de hoy' : undefined}
                >
                  <input
                    type="checkbox"
                    checked={onlyUntouched}
                    disabled={coverageConfirmError}
                    onChange={(e) => setOnlyUntouched(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-border accent-accent cursor-pointer disabled:cursor-not-allowed"
                  />
                  {gestionCargada ? 'Solo los que nadie llamó' : 'Solo sin tocar'}
                </label>
                {/* Cómo va HOY cada asesora. Sale de las MISMAS filas que el
                    contador del equipo (cero consultas nuevas) y lo ve TODO el
                    mundo, no solo el dueño desde Productividad: la queja fue
                    "para yo no tener que preguntarles". Se rotula "hoy por
                    asesora" y no "desglose": si dos trabajaron el mismo pedido,
                    cada una registra su gestión y la suma no da el total. */}
                {resumenAsesorasHoy.length > 0 && (
                  <div className="w-full flex flex-wrap items-center gap-1.5 pt-1 mt-1 border-t border-border/50">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold mr-1">
                      Hoy por asesora
                    </span>
                    {resumenAsesorasHoy.map((r) => (
                      <span
                        key={r.operatorId}
                        title={`${nombreDeAsesora(r.operatorId)}: ${r.conf} confirmados · ${r.canc} cancelados · ${r.noresp} no contestaron`}
                        className={`text-[11px] px-2 py-0.5 rounded-lg border inline-flex items-center gap-1.5 ${
                          r.operatorId === user?.id
                            ? 'bg-accent/10 border-accent/30 text-foreground font-semibold'
                            : 'bg-card/50 border-border text-muted-foreground'
                        }`}
                      >
                        <span className="truncate max-w-[110px]">{nombreDeAsesora(r.operatorId)}</span>
                        <span className="font-mono tabular-nums font-bold">{r.total}</span>
                        <span className="text-success font-mono tabular-nums" title="confirmados">✓{r.conf}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}

          {/* KPIs compactos + urgent pills inline. Antes el chip "N urgente
              (D4-6)" ocupaba su propia fila — en desktop quedaba ese pill
              suelto con 800px de aire al lado. Ahora va en la MISMA strip, al
              final, separado por un border-l. Ahorra una fila en desktop y
              mantiene la misma jerarquía en mobile (wrap natural). */}
          {(() => {
            // Misma base que el headline `pending`: sin los lockeados por otra
            // asesora. Sobre visibleQueue crudo el chip contaba pedidos que la
            // lista NO muestra ("1 cancelar (D7+)" imposible de encontrar) —
            // la misma divergencia ya corregida en el chip "Tu cola hoy".
            const accionables = visibleQueue.filter(
              o => !o.result && !isLockedByOther(o, user?.id ?? null, Date.now()),
            );
            const d7 = accionables.filter(o => diasReales(o) >= 7).length;
            const d46 = accionables.filter(o => { const d = diasReales(o); return d >= 4 && d <= 6; }).length;
            return (
              /* La tira plana de números en línea pasa a ser el bloque hero de
                 la pantalla: a la izquierda la cifra que manda —cuántos faltan
                 por confirmar— y a la derecha los tres resultados del día como
                 StatTile del DS (chip de ícono con glow, cifra contando, tono
                 propio). Los conteos y sus rótulos son EXACTAMENTE los mismos;
                 lo que cambia es que ahora se leen de un vistazo por color y
                 tamaño en vez de escanear una fila de texto. */
              <motion.div {...fadeUp(0.12)} className="grid grid-cols-1 md:grid-cols-12 gap-4 mb-4">
                <TiltCard
                  sheen
                  brackets
                  wrapperClassName="md:col-span-5"
                  className="bg-card/40 border border-border rounded-3xl p-6 shadow-card3d-lg h-full flex flex-col justify-between gap-4"
                >
                  <div className="tilt-layer-2 flex items-start justify-between gap-3">
                    <span className="w-9 h-9 rounded-xl bg-accent/14 border border-accent/30 text-accent glow-accent flex items-center justify-center flex-shrink-0" aria-hidden="true">
                      <Phone size={17} />
                    </span>
                    {(d7 > 0 || d46 > 0) && (
                      <div className="flex items-center gap-2 flex-wrap justify-end">
                        {d7 > 0 && (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-danger/14 border border-danger/30 text-danger">
                            <span className="w-1.5 h-1.5 rounded-full bg-danger glow-danger" aria-hidden="true" /> <span className="font-mono tabular-nums">{d7}</span> cancelar (D7+)
                          </span>
                        )}
                        {d46 > 0 && (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-warning/14 border border-warning/30 text-warning">
                            <span className="w-1.5 h-1.5 rounded-full bg-warning glow-warning" aria-hidden="true" /> <span className="font-mono tabular-nums">{d46}</span> urgente (D4-6)
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="tilt-layer-3">
                    <CountUp value={pending} className="text-[52px] font-extrabold text-accent leading-none num-glow-accent" />
                    <div className="hud-label mt-2">por confirmar</div>
                  </div>

                  {/* Los MISMOS conf/canc/noresp dibujados como partes de su
                      suma —`total`, que ya se muestra rotulada "gestionados"—.
                      No imprime ninguna cifra nueva: es la misma medición vista
                      como proporción. Con total = 0 no se dibuja nada: una
                      barra vacía se leería como "medí y dio cero". */}
                  {total > 0 && (
                    <div className="tilt-layer-1 h-2 rounded-full bg-foreground/10 overflow-hidden flex" aria-hidden="true">
                      <div className="h-full bg-gradient-to-r from-success to-success/60 transition-[width] duration-700" style={{ width: `${(counter.conf / total) * 100}%` }} />
                      <div className="h-full bg-gradient-to-r from-danger to-danger/60 transition-[width] duration-700" style={{ width: `${(counter.canc / total) * 100}%` }} />
                      <div className="h-full bg-muted-foreground/45 transition-[width] duration-700" style={{ width: `${(counter.noresp / total) * 100}%` }} />
                    </div>
                  )}
                </TiltCard>

                <div className="md:col-span-7 flex flex-col gap-2">
                  {/* Estos conteos son de TODA la tienda (todas las operadoras),
                      no personales. Se etiqueta para no confundir con "Tu cola hoy"
                      y con el banner personal de arriba. */}
                  <span className="hud-label text-muted-foreground/70">
                    equipo · toda la tienda
                  </span>
                  {/* Este bloque cuenta TODO lo confirmado HOY, incluidos pedidos
                      de días anteriores que estaban pendientes. Desde la unificación
                      del 30-jul (e6cd891, UNA sola matemática) el Dashboard y
                      Productividad cuentan EXACTAMENTE lo mismo — el rótulo viejo
                      anunciaba una diferencia que ya no existe y fabricaba la
                      contradicción que quería prevenir. */}
                  <span className="text-[10px] text-muted-foreground -mt-1 leading-snug">
                    confirmados <strong className="text-foreground/80">hoy</strong> · incluye pedidos de días anteriores que estaban pendientes
                    <span className="opacity-70"> · es el mismo número del Dashboard y Productividad (una sola matemática)</span>
                  </span>
                  <div className="grid grid-cols-1 min-[390px]:grid-cols-2 gap-3 flex-1">
                    <StatTile icon={CheckCircle2} label="conf" value={counter.conf} tone="success" />
                    <StatTile icon={XCircle} label="canc" value={counter.canc} tone="danger" />
                    <StatTile icon={PhoneOff} label="noresp" value={counter.noresp} tone="neutral" />
                    <StatTile icon={ClipboardCheck} label="gestionados" value={total} tone="accent" />
                  </div>
                  {/* El desglose de los "no contestó". El número solo (36) no
                      dice nada accionable, y peor: un pedido ENFRIANDO no
                      aparece en NINGUNA lista, así que el equipo cerraba el día
                      con decenas de llamadas del día sin usar creyendo que ya
                      no quedaba nada. Acá se ve a cuántos se puede llamar YA,
                      cuántos están esperando el enfriamiento (y cuándo vuelve el
                      primero) y cuántos agotaron sus 3 intentos. */}
                  {sinRespuestaHoy && sinRespuestaHoy.total > 0 && (
                    <div className="rounded-2xl border border-border bg-card/40 px-3.5 py-2.5 text-[11px] flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <span className="font-bold text-foreground">
                        De los {sinRespuestaHoy.total} que no contestaron:
                      </span>
                      <button
                        type="button"
                        onClick={() => setFilter(filter === 'retry' ? 'pending' : 'retry')}
                        disabled={sinRespuestaHoy.listos === 0}
                        className="font-bold text-success disabled:opacity-50 disabled:cursor-default hover:underline cursor-pointer"
                        title={sinRespuestaHoy.listos ? 'Ver los que ya se pueden llamar' : `Ninguno cumplió todavía la espera de ${COOLDOWN_LABEL}`}
                      >
                        {sinRespuestaHoy.listos} para llamar ya
                      </button>
                      {sinRespuestaHoy.enfriando > 0 && (
                        <span className="text-warning font-semibold">
                          {sinRespuestaHoy.enfriando} esperando {COOLDOWN_LABEL}
                          {sinRespuestaHoy.proximoEnMinutos != null && (
                            <span className="text-muted-foreground font-normal">
                              {' '}(el próximo en {sinRespuestaHoy.proximoEnMinutos} min)
                            </span>
                          )}
                        </span>
                      )}
                      {sinRespuestaHoy.agotados > 0 && (
                        <span className="text-muted-foreground">
                          {sinRespuestaHoy.agotados} ya {sinRespuestaHoy.agotados === 1 ? 'usó' : 'usaron'} sus {MAX_DAILY_ATTEMPTS}
                        </span>
                      )}
                      {sinRespuestaHoy.llamadasDisponibles > 0 && (
                        <span className="w-full text-muted-foreground">
                          {sinRespuestaHoy.llamadasDisponibles === 1 ? 'Queda' : 'Quedan'}{' '}
                          <strong className="text-foreground">
                            {sinRespuestaHoy.llamadasDisponibles} {sinRespuestaHoy.llamadasDisponibles === 1 ? 'llamada' : 'llamadas'}
                          </strong>{' '}
                          del día sin usar. Si nadie {sinRespuestaHoy.llamadasDisponibles === 1 ? 'la hace' : 'las hace'} hoy,{' '}
                          {sinRespuestaHoy.llamadasDisponibles === 1 ? 'ese cliente se pierde' : 'esos clientes se pierden'} el intento.
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </motion.div>
            );
          })()}

          {(() => {
            const retryOrders = visibleQueue.filter(o => o.retryCount && !o.result);
            if (!retryOrders.length) return null;
            const active = filter === 'retry';
            return (
              <button
                onClick={() => { setView('list'); setFilter(active ? 'pending' : 'retry'); }}
                aria-pressed={active}
                className={`relative w-full flex items-center gap-3 mb-4 rounded-2xl border px-4 py-3 pl-5 shadow-card3d text-left transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-warning focus-visible:outline-none ${
                  active ? 'bg-warning/20 border-warning/50' : 'bg-warning/10 border-warning/25 hover:bg-warning/15 hover:border-warning/40'
                }`}>
                <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-warning" aria-hidden="true" />
                <span className="w-9 h-9 rounded-xl bg-warning/20 glow-warning flex items-center justify-center flex-shrink-0 text-warning" aria-hidden="true">
                  <RotateCcw size={17} strokeWidth={2.25} />
                </span>
                <div className="min-w-0 flex-1">
                  <span className="text-xs font-bold text-warning">
                    <span className="font-mono tabular-nums">{retryOrders.length}</span> pedido{retryOrders.length > 1 ? 's' : ''} para reintentar
                  </span>
                  <span className="text-[11px] text-muted-foreground ml-2">
                    No contestaron antes — volver a llamar
                  </span>
                </div>
                <span className="text-[11px] font-semibold text-warning shrink-0">
                  {active ? 'Quitar filtro ✕' : 'Ver estos →'}
                </span>
              </button>
            );
          })()}

          {/* Card de controles: en mobile apila (fechas / view / filtros), en
              desktop pone fechas+view en la MISMA fila (gap chico, no
              justify-between → sin aire vacío al medio) y filtros debajo. Los
              botones de fecha pasan de h-7/text-[11px] (28px, casi
              indistinguibles del fondo) a h-9/text-xs con el ícono más visible
              — el popover trigger ya cubría todo el botón (asChild forwardea
              onClick), pero el target era demasiado chiquito. */}
          <motion.div {...fadeUp(0.18)} className="bg-card/40 border border-border rounded-2xl shadow-card3d hairline-top p-3 sm:p-4 mb-4 space-y-3">
            <div className="flex items-center flex-wrap gap-2">
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className={cn(
                    "h-9 gap-1.5 text-xs font-medium rounded-xl bg-card/40 border-border hover:border-border-strong cursor-pointer",
                    !dateFrom && "text-muted-foreground"
                  )}>
                    <CalendarIcon size={14} aria-hidden="true" />
                    {dateFrom ? format(new Date(dateFrom + 'T12:00:00'), 'dd MMM', { locale: es }) : 'Desde'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={dateFrom ? new Date(dateFrom + 'T12:00:00') : undefined}
                    onSelect={(d) => setDateFrom(d ? d.toISOString().split('T')[0] : '')}
                    initialFocus
                    className="p-3 pointer-events-auto"
                  />
                </PopoverContent>
              </Popover>
              <span className="text-xs text-muted-foreground/60" aria-hidden="true">—</span>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className={cn(
                    "h-9 gap-1.5 text-xs font-medium rounded-xl bg-card/40 border-border hover:border-border-strong cursor-pointer",
                    !dateTo && "text-muted-foreground"
                  )}>
                    <CalendarIcon size={14} aria-hidden="true" />
                    {dateTo ? format(new Date(dateTo + 'T12:00:00'), 'dd MMM', { locale: es }) : 'Hasta'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={dateTo ? new Date(dateTo + 'T12:00:00') : undefined}
                    onSelect={(d) => setDateTo(d ? d.toISOString().split('T')[0] : '')}
                    initialFocus
                    className="p-3 pointer-events-auto"
                  />
                </PopoverContent>
              </Popover>
              {(dateFrom || dateTo) && (
                <Button variant="ghost" size="sm" onClick={() => { setDateFrom(''); setDateTo(''); }}
                  aria-label="Limpiar rango de fechas"
                  className="h-9 w-9 p-0 text-muted-foreground hover:text-foreground rounded-lg cursor-pointer">
                  <X size={14} aria-hidden="true" />
                </Button>
              )}

              <div className="inline-flex flex-wrap gap-2 ml-auto">
                {([
                  { key: 'list' as const, icon: List, label: 'Lista' },
                  { key: 'call' as const, icon: Phone, label: 'Llamar' },
                ]).map(v => (
                  <button key={v.key} onClick={() => setView(v.key)}
                    aria-pressed={view === v.key}
                    className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ${
                      view === v.key
                        ? 'font-semibold bg-accent/16 border border-accent/40 text-accent shadow-glow3d'
                        : 'font-medium bg-card/40 border border-border text-muted-foreground hover:text-foreground hover:border-border-strong'
                    }`}>
                    <v.icon size={13} aria-hidden="true" /> {v.label}
                  </button>
                ))}
              </div>
            </div>

            <WorkFilters workQueue={visibleQueue} filter={filter} setFilter={setFilter} search={search} setSearch={setSearch} notesIndex={notesIndex} />
          </motion.div>

          {/* ⚠ DUPLICADOS VIVOS (incidente 2026-07-13, #6107398): el pedido viejo
              del par duplicado sigue ACTIVO en Dropi (no está cancelado ni
              reemplazado ni rechazado) → puede despacharse dos veces. Antes caía
              al panel pasivo de abajo, sin botones, y nadie lo podía cancelar.
              Acá va con acción directa: "Cancelar en Dropi" vía markResult('canc')
              (la cancelación se sincroniza con Dropi de verdad). */}
          {liveDups.length > 0 && (
            <div className="relative mb-4 rounded-2xl border border-destructive/40 bg-destructive/10 shadow-card3d overflow-hidden">
              <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-danger" aria-hidden="true" />
              <div className="px-4 py-3 pl-5 flex items-center gap-3 text-xs flex-wrap">
                <span className="w-9 h-9 rounded-xl bg-danger/20 glow-danger flex items-center justify-center flex-shrink-0 text-destructive" aria-hidden="true">
                  <AlertTriangle size={17} />
                </span>
                <span className="font-semibold text-foreground">
                  ⚠ {liveDups.length} DUPLICADO{liveDups.length > 1 ? 'S' : ''} VIVO{liveDups.length > 1 ? 'S' : ''} en Dropi
                </span>
                <span className="text-muted-foreground">— el pedido viejo sigue activo y puede despacharse dos veces</span>
              </div>
              <div className="border-t border-destructive/30 divide-y divide-border">
                {liveDups.map(o => {
                  const info = supersededMap.get(String(o.externalId));
                  return (
                    <div key={o.externalId || o.dbId} className="px-4 pl-5 py-2 flex items-center gap-2 text-xs flex-wrap transition-colors hover:bg-destructive/5">
                      <span className="font-medium text-foreground truncate">{o.nombre}</span>
                      <a href={`/pedido/${o.externalId}`} className="font-mono tabular-nums text-[10px] text-primary hover:underline">#{o.externalId}</a>
                      <span className="text-[9px] font-bold px-2 py-0.5 rounded-lg border bg-destructive/15 text-destructive border-destructive/30">
                        {o.estado}
                      </span>
                      <span className="text-muted-foreground truncate">{o.producto}</span>
                      <span className="font-mono tabular-nums text-muted-foreground">{formatCOP(Number(o.valor || 0))}</span>
                      {info && (
                        <span className="text-muted-foreground">
                          más nuevo:{' '}
                          <a href={`/pedido/${info.byExternalId}`} className="font-mono tabular-nums text-primary hover:underline">#{info.byExternalId}</a>
                        </span>
                      )}
                      <span className="ml-auto">
                        {o.result ? (
                          <span className="text-[10px] font-semibold text-muted-foreground">Gestionado</span>
                        ) : (
                          <Button
                            variant="destructive"
                            size="sm"
                            className="h-7 rounded-xl text-[11px]"
                            onClick={() => setDupToCancel(o)}
                          >
                            Cancelar en Dropi
                          </Button>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Confirmación de cancelación del duplicado vivo — AlertDialog (shadcn),
              mismo patrón que NotesPanel (estilizado, accesible, respeta el tema). */}
          <AlertDialog open={!!dupToCancel} onOpenChange={(op) => { if (!op) setDupToCancel(null); }}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>¿Cancelar el pedido #{dupToCancel?.externalId} en Dropi?</AlertDialogTitle>
                <AlertDialogDescription>
                  Es un duplicado: queda vivo el pedido #{dupToCancel ? (supersededMap.get(String(dupToCancel.externalId))?.byExternalId ?? '?') : ''} del mismo cliente. La cancelación se envía a Dropi de verdad.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Volver</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    if (!dupToCancel) return;
                    const nuevoId = supersededMap.get(String(dupToCancel.externalId))?.byExternalId ?? '?';
                    void markResult(dupToCancel, 'canc', `Duplicado — ya existe el pedido #${nuevoId} del mismo cliente`);
                    setDupToCancel(null);
                  }}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Cancelar en Dropi
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          {hiddenDeadDups.length > 0 && (
            <div className="relative mb-4 rounded-2xl border border-border bg-card/40 shadow-card3d overflow-hidden">
              <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-muted-foreground/40" aria-hidden="true" />
              <button onClick={() => setDupExpanded(e => !e)}
                className="w-full flex items-center gap-2 px-4 pl-5 py-2.5 text-left text-xs transition-colors hover:bg-foreground/5">
                <AlertTriangle size={14} className="text-muted-foreground shrink-0" aria-hidden="true" />
                <span className="font-semibold text-foreground">
                  {hiddenDeadDups.length} pedido{hiddenDeadDups.length > 1 ? 's' : ''} oculto{hiddenDeadDups.length > 1 ? 's' : ''} por duplicado
                </span>
                <span className="text-muted-foreground">— ya hay un pedido más nuevo del mismo cliente</span>
                <span className="ml-auto text-muted-foreground">{dupExpanded ? 'Ocultar' : 'Ver'}</span>
              </button>
              {dupExpanded && (
                <div className="border-t border-border divide-y divide-border">
                  {hiddenDeadDups.map(o => (
                    <div key={o.externalId || o.dbId} className="px-4 pl-5 py-2 flex items-center gap-3 text-xs transition-colors hover:bg-foreground/5">
                      <span className="font-medium text-foreground truncate">{o.nombre}</span>
                      <span className="font-mono tabular-nums text-[10px] text-muted-foreground">#{o.externalId}</span>
                      <span className="text-muted-foreground">{o.producto}</span>
                      <span className="ml-auto font-mono tabular-nums text-muted-foreground">{formatCOP(Number(o.valor || 0))}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Pares stub+reenvío: cada fila señala el pedido VIEJO de la cola con
              el chip "⚠ YA REENVIADO" y el # nuevo que sí hay que gestionar.
              Mismo patrón visual que los chips DUP/DE MÁS (PR #107) — acá va
              como strip pegado a la lista porque el pedido viejo NO se debe
              gestionar (es un aviso de exclusión, no un dato más de la fila). */}
          {resentOldInQueue.length > 0 && (
            <div className="relative mb-4 rounded-2xl border border-warning/40 bg-warning/10 shadow-card3d overflow-hidden">
              <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-warning" aria-hidden="true" />
              <div className="px-4 pl-5 py-3 flex items-center gap-3 text-xs flex-wrap">
                <span className="w-9 h-9 rounded-xl bg-warning/20 glow-warning flex items-center justify-center flex-shrink-0 text-warning" aria-hidden="true">
                  <AlertTriangle size={17} />
                </span>
                <span className="font-semibold text-foreground">
                  {resentOldInQueue.length} pedido{resentOldInQueue.length > 1 ? 's' : ''} viejo{resentOldInQueue.length > 1 ? 's' : ''} con reenvío activo
                </span>
                <span className="text-muted-foreground">— gestioná el # nuevo, no estos</span>
              </div>
              <div className="border-t border-warning/30 divide-y divide-border">
                {resentOldInQueue.map(({ order, nuevoId }) => (
                  <div key={order.externalId || order.dbId} className="px-4 pl-5 py-2 flex items-center gap-2 text-xs flex-wrap transition-colors hover:bg-warning/5">
                    <span className="font-medium text-foreground truncate">{order.nombre}</span>
                    <span className="font-mono tabular-nums text-[10px] text-muted-foreground">#{order.externalId}</span>
                    <span
                      title={`Este cliente ya tiene un pedido más nuevo activo (#${nuevoId}) — gestioná ese y no toques este`}
                      className="text-[9px] font-bold px-2 py-0.5 rounded-lg border bg-warning/15 text-warning border-warning/30 inline-flex items-center gap-0.5"
                    >
                      ⚠ YA REENVIADO — gestioná el #{nuevoId}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {clienteYaDespachado.length > 0 && (
            <div className="relative mb-4 rounded-2xl border border-danger/40 bg-danger/10 shadow-card3d overflow-hidden">
              <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-danger" aria-hidden="true" />
              <div className="px-4 pl-5 py-3 flex items-center gap-3 text-xs flex-wrap">
                <span className="w-9 h-9 rounded-xl bg-danger/20 flex items-center justify-center flex-shrink-0 text-danger" aria-hidden="true">
                  <AlertTriangle size={17} />
                </span>
                <span className="font-semibold text-foreground">
                  {clienteYaDespachado.length} cliente{clienteYaDespachado.length > 1 ? 's' : ''} con OTRO pedido ya despachado
                </span>
                <span className="text-muted-foreground">— revisá en Dropi antes de confirmar: puede terminar en doble envío</span>
              </div>
              <div className="border-t border-danger/30 divide-y divide-border">
                {clienteYaDespachado.map(({ order, otroId, otroEstado }) => (
                  <div key={order.externalId || order.dbId} className="px-4 pl-5 py-2 flex items-center gap-2 text-xs flex-wrap transition-colors hover:bg-danger/5">
                    <span className="font-medium text-foreground truncate">{order.nombre}</span>
                    <span className="font-mono tabular-nums text-[10px] text-muted-foreground">#{order.externalId}</span>
                    <span
                      title={`Este cliente ya tiene el pedido #${otroId} en ${otroEstado || 'curso'}. Puede ser una edición que dejó vivo el viejo, o una compra distinta: verificalo en Dropi antes de despachar.`}
                      className="text-[9px] font-bold px-2 py-0.5 rounded-lg border bg-danger/15 text-danger border-danger/30 inline-flex items-center gap-0.5"
                    >
                      ⚠ YA TIENE #{otroId} ({otroEstado || 'en curso'})
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {view === 'list' ? (
            <WorkList items={filteredItems} notesIndex={notesIndex} riesgoIndex={riesgoIndex} alerts={orderAlerts} gestionEquipo={gestionPorPedido} onOpenCall={(idx) => {
              // Abrir EL pedido clickeado, no el primer pendiente. CallView lee el
              // pedido activo de sessionStorage['confirmar:callOrderId'] en su
              // inicializador de useState al montarse. useSessionState persiste en
              // un useEffect (post-commit), que correría DESPUÉS de que CallView ya
              // leyó → abriría otro pedido. Por eso escribimos el id SINCRÓNICAMENTE
              // acá, antes del setView que monta CallView.
              const target = filteredItems[idx];
              const k = target?.externalId || target?.dbId || null;
              try { window.sessionStorage.setItem('confirmar:callOrderId', JSON.stringify(k ? String(k) : null)); } catch { /* storage off */ }
              setView('call');
            }} />
          ) : (
            <CallView items={filteredItems} alerts={orderAlerts} />
          )}
        </>
      )}
    </div>
  );
}

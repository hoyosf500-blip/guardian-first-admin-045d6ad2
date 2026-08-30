import { createContext, useContext, useState, useCallback, useEffect, useRef, useMemo, ReactNode } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './AuthContext';
import { useStore } from './StoreContext';
import { OrderData, dbToOrderData, isPendiente, isDespachado, isConfirmado, type DbOrderRow } from '@/lib/orderUtils';
import { compareConfirmar, cooldownHoursForAttempt, MAX_DAILY_ATTEMPTS, resumenSinRespuestaHoy, mismoResumen, type ResumenSinRespuesta, type FilaResultado } from '@/lib/confirmarQueue';
import { pollWhenVisible } from '@/lib/pollWhenVisible';
import { bogotaToday } from '@/lib/utils';
import { toast } from 'sonner';
import { useCelebration } from '@/hooks/useCelebration';
import { useDataLoader, smartMerge } from '@/hooks/useDataLoader';
import { useNovedades } from '@/hooks/useNovedades';
// COST-2 (2026-04-29): useAutoDropiSync removido — el sync automático
// cada hora consumía Cloud sin necesidad. Ahora el admin sincroniza
// manualmente con el botón "Sincronizar ahora" en Dashboard/Admin, y el
// cron server-side (`dropi-cron`) sigue corriendo independiente.
// import { useAutoDropiSync } from '@/hooks/useAutoDropiSync';
import { useRealtimeOrders } from '@/hooks/useRealtimeOrders';

// COST-3: ORDER_COLUMNS extraído a src/lib/orderColumns.ts para reutilizarse
// en ConfirmarTab y CallView (antes hacían select('*')).
import { ORDER_COLUMNS } from '@/lib/orderColumns';
import { fetchPendientesDeConfirmar } from '@/lib/fetchPendientes';
import { computeDailyCounter, computeDailyCounterByOperator, type ResumenAsesora } from '@/lib/computeDailyCounter';
import { buildGestionPorPedido, buildGestionSegPorTelefono, aplicarGestionEnVivo, mismaGestion, type GestionDelPedido } from '@/lib/gestionPorPedido';
import { onGestion } from '@/lib/eventosGestion';
import { aplicarPedidosTocados } from '@/lib/aplicarPedidosTocados';

/** Cuánto se juntan los avisos de realtime antes de ir a buscar. 5 s no se
 *  notan en el tablero y convierten una ráfaga del cron en UNA consulta. */
const VENTANA_PARCHE_MS = 5_000;
/** Más que esto en una sola ventana ya no es "un pedido se movió", es una
 *  barrida del cron: ahí conviene recargar de una. */
const MAX_IDS_PARCHE = 60;
/** Piso duro entre recargas completas. El peor caso pasa a ser una cada 90 s. */
const PISO_REFRESCO_TOTAL_MS = 90_000;

interface Counter { conf: number; canc: number; noresp: number; }

interface OrderState {
  allOrders: OrderData[];
  workQueue: OrderData[];
  segData: OrderData[];
  segLoaded: boolean;
  segLoading: boolean;
  segLastUpdate: Date | null;
  loadSegData: (force?: boolean) => Promise<void>;
  /** Último fallo de lectura de la cola de Seguimiento. Ver `useDataLoader`. */
  segError: string | null;
  // Rescate eliminado (2026-05-08): /seguimiento + listas SLA cubren todos
  // los casos. Las propiedades resData/resLoaded/resLoading/loadResData ya
  // no existen — usar segData con filtros de segLists.ts.
  novedadesQueue: OrderData[];
  novedadesLoading: boolean;
  /** Error de la ÚLTIMA carga de novedades (H4): con esto la pantalla puede
   *  distinguir "cola vacía porque no hay" de "cola vacía porque no cargó". */
  novedadesError: string | null;
  /** Gestiones de HOY de TODA LA TIENDA (equipo). Es lo que rotula "Equipo hoy"
   *  la CounterBar y lo que alimenta la barra de progreso de la cola compartida. */
  counter: Counter;
  /** Gestiones de HOY de ESTA operadora (operator_id = yo), misma dedup por
   *  order_id que `counter`.
   *
   *  Existen los DOS a propósito y no son intercambiables: `counter` es store-wide
   *  desde que la cola pasó a ser pool compartido (evita el parpadeo
   *  personal→equipo en la barra), pero todo lo que la operadora FIRMA — el cierre
   *  de turno que se guarda en daily_reports con su operator_id, el resumen que
   *  copia y el que manda por WhatsApp, y el tablero en modo "Yo" — tiene que
   *  salir de acá. Con 3 operadoras, firmar `counter` guardaba 3 cierres con los
   *  107 gestionados de la tienda cada uno (321 en un día de 107). */
  myCounter: Counter;
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
  /** Cobertura del DÍA de la operadora — para el chip "Tu cola hoy".
   *  - myConfirmTouchedToday: Set<order_id> de pedidos donde ESTA operadora
   *    insertó un order_results (module='confirmar') hoy (Bogotá). Se cruza
   *    contra workQueue para mostrar "X / Y llamados, Z sin tocar".
   *  - mySegTouchedToday: Set<phone> de pedidos donde ESTA operadora insertó
   *    un touchpoint (action ILIKE 'SEG:%') hoy. Touchpoints no tiene order_id
   *    → identificamos por phone. Se cruza contra segData. */
  myConfirmTouchedToday: Set<string>;
  mySegTouchedToday: Set<string>;
  /** Gestión del EQUIPO por pedido, hoy: quién llamó, cuántas veces y cuándo.
   *
   *  Es la contraparte de equipo de `myConfirmTouchedToday` (que es personal).
   *  Sin esto, la asesora leía "Te faltan 33 sin tocar" y volvía a llamar a los
   *  que una compañera ya había llamado esa mañana — para ELLA estaban sin
   *  tocar. El dato ya existía en order_results pero solo se veía ABRIENDO el
   *  pedido, así que en la práctica había que preguntarle al equipo.
   *
   *  Sale de las MISMAS filas que el cooldown (store-wide, 7 días): sin
   *  consultas nuevas. La clave es `order_id` (= `OrderData.dbId`). */
  gestionPorPedido: Map<string, GestionDelPedido>;
  /** ¿Ya corrió al menos una lectura buena de `order_results`? Si es false,
   *  el mapa vacío NO significa "nadie llamó" — significa que no sabemos. */
  gestionCargada: boolean;
  /** Igual que `gestionPorPedido` pero para Seguimiento, donde la clave es el
   *  TELÉFONO (touchpoints no guarda order_id). Contraparte de equipo de
   *  `mySegTouchedToday`, que es personal. */
  gestionSegPorTelefono: Map<string, GestionDelPedido>;
  /**
   * Última gestión de Seguimiento por teléfono en los 7 días ANTERIORES a hoy
   * (hoy queda fuera: vive en `gestionSegPorTelefono`, que además está vivo).
   *
   * Nunca bloquea ni cuenta como trabajo de hoy. Contesta *"¿alguien ya lo
   * trabajó, aunque no haya sido hoy?"* — el hueco por el que la asesora
   * repetía el reclamo de una compañera — y le da a `cicloContacto` los
   * intentos de días anteriores para que la etiqueta no diga "2º" sobre el 4º.
   */
  ultimaGestionSeg: Map<string, GestionDelPedido>;
  /** Como va HOY cada asesora (conf/canc/noresp), misma dedup que el contador
   *  del equipo. Lo ven todos: el dueno para no preguntar, y el equipo para
   *  saber como va la jornada sin entrar a Productividad. */
  resumenAsesorasHoy: ResumenAsesora[];
  /** Los que hoy NO contestaron: a cuantos se puede llamar YA, cuantos estan
   *  enfriando y cuando vuelve el proximo, y cuantos agotaron sus 3 intentos.
   *  Un pedido enfriando no aparece en NINGUNA lista: sin esto el equipo daba
   *  el dia por cerrado con decenas de llamadas sin usar. null = todavia no se
   *  leyo (no es "no hay"). */
  sinRespuestaHoy: ResumenSinRespuesta | null;
  /** ¿Falló la ÚLTIMA lectura de los sets de cobertura del día?
   *
   *  Un Set vacío es AMBIGUO: puede significar "la operadora todavía no gestionó
   *  nada" (cero medido, real) o "la consulta falló" (no sabemos nada). Antes los
   *  dos casos salían por el mismo `if (!data) return` y la UI pintaba el segundo
   *  como "Has llamado a 0" / "Gestionados 0 de 47" — un cero inventado que le
   *  decía a la operadora que no había trabajado.
   *
   *  Contrato para los consumidores:
   *  - flag `false` + set vacío → CERO REAL. Mostrar 0, es un dato medido.
   *  - flag `true`              → DATO AUSENTE. Mostrar "—" / "Sin datos" en tono
   *    NEUTRO (text-muted-foreground). Nunca rojo: no sabemos si está mal, no
   *    sabemos nada.
   *
   *  Se guardan separados POR FUENTE para que el éxito de una query no borre el
   *  error de la otra (con un solo boolean compartido ganaba el `.then` que
   *  resolviera último y podíamos "limpiar" un error real):
   *  - `coverageConfirmError` → solo myConfirmTouchedToday (order_results)
   *  - `coverageSegError`     → solo mySegTouchedToday (touchpoints)
   *  - `coverageError`        → cualquiera de las dos, para consumidores genéricos.
   *    Preferí el granular donde exista: el agregado apaga el chip de Confirmar
   *    aunque lo que haya fallado sea la query de Seguimiento.
   *
   *  Ojo: arrancan en `false`. Durante la primera carga (~ms) el set está vacío y
   *  el flag limpio — es un estado de "cargando", no de error. */
  coverageError: boolean;
  coverageConfirmError: boolean;
  coverageSegError: boolean;
  /** ¿Ya hubo UNA lectura buena de los contadores del día (`counter` /
   *  `myCounter`)? Mismo contrato que `gestionCargada`: mientras sea `false`,
   *  un `{conf:0, canc:0, noresp:0}` NO significa "hoy no se trabajó" —
   *  significa que no sabemos. Los consumidores pintan "—" en tono neutro.
   *
   *  Existe porque estos dos contadores son los que la operadora FIRMA en el
   *  cierre del día: un cero inventado ahí es un reclamo injusto por un dato
   *  que nunca se midió. */
  counterCargado: boolean;
  /** ¿Falló la ÚLTIMA lectura de la cola de Confirmar (`loadWorkQueue`)?
   *
   *  Una cola que dejó de refrescarse se ve EXACTAMENTE igual que una cola al
   *  día: sin toast, sin spinner, sin bandera. La asesora sigue llamando sobre
   *  una foto vieja. Con esto el hero puede decir "—" en vez de un número que
   *  aparenta estar medido. */
  colaConfirmarError: boolean;
}

const OrderContext = createContext<OrderState | undefined>(undefined);

export function OrderProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { activeStoreId } = useStore();
  const { checkMilestone, requestNotificationPermission, resetCelebrations } = useCelebration();
  const [allOrders, setAllOrdersState] = useState<OrderData[]>([]);
  const [workQueue, setWorkQueue] = useState<OrderData[]>([]);
  const [counter, setCounter] = useState<Counter>({ conf: 0, canc: 0, noresp: 0 });
  const [myCounter, setMyCounter] = useState<Counter>({ conf: 0, canc: 0, noresp: 0 });
  const [timerStart, setTimerStart] = useState(0);
  const [loading] = useState(false);
  const [excelLoaded, setExcelLoaded] = useState(false);
  const [lastMark, setLastMark] = useState<{ order: OrderData; result: string; reason?: string; resultId?: string; touchpointId?: string } | null>(null);
  // Cobertura del día — sets que se llenan con un query barato al cargar y
  // se mantienen al día por suscripción realtime a INSERT en order_results /
  // touchpoints filtrada por mi operator_id. Sirven para el chip "Tu cola
  // hoy" en ConfirmarTab y SeguimientoTab. No persiste entre sesiones porque
  // se recalcula del backend en cada loadWorkQueue/loadSegData.
  const [myConfirmTouchedToday, setMyConfirmTouchedToday] = useState<Set<string>>(new Set());
  const [gestionPorPedido, setGestionPorPedido] = useState<Map<string, GestionDelPedido>>(new Map());
  const [gestionCargada, setGestionCargada] = useState(false);
  const [gestionSegPorTelefono, setGestionSegPorTelefono] = useState<Map<string, GestionDelPedido>>(new Map());
  const [ultimaGestionSeg, setUltimaGestionSeg] = useState<Map<string, GestionDelPedido>>(new Map());
  const [resumenAsesorasHoy, setResumenAsesorasHoy] = useState<ResumenAsesora[]>([]);
  const [sinRespuestaHoy, setSinRespuestaHoy] = useState<ResumenSinRespuesta | null>(null);
  // El resumen de "no contestaron" es lo ÚNICO de esta pantalla que cambia solo
  // con el paso del tiempo: un pedido pasa de "enfriando" a "listo" sin que
  // nadie toque nada. Por eso se guardan las filas crudas — para poder
  // recalcularlo cada minuto contra el reloj sin volver a consultar la base — y
  // el último resultado, para comparar y no re-renderizar de gusto.
  const norespRowsRef = useRef<FilaResultado[] | null>(null);
  const sinRespuestaRef = useRef<ResumenSinRespuesta | null>(null);
  // Qué pedidos siguen PENDIENTES. Sin esto el resumen contaba como "llamable"
  // a un cliente cuyo pedido ya estaba CANCELADO en Dropi (esa cancelación no
  // deja fila en order_results, así que por ahí es invisible).
  const pedidosVivosRef = useRef<Set<string> | null>(null);
  /**
   * Tienda a la que corresponde lo que se está mostrando AHORA.
   *
   * `loadWorkQueue` era el único de los tres cargadores sin guard de tienda
   * (`useDataLoader` y `useNovedades` sí lo tienen). Si la asesora cambia de
   * tienda con un fetch en vuelo, la respuesta vieja llenaba la cola de
   * Confirmar con pedidos de Colombia bajo el encabezado de Ecuador — y llamar
   * a uno de esos escribe la gestión con el store_id de la tienda NUEVA sobre
   * un pedido de la vieja. Mezclar países está prohibido en esta operación.
   *
   * Antes la ventana era un solo viaje al servidor; desde que la cola pagina
   * (para no cortarse en mil filas) puede durar varios segundos, así que el
   * guard dejó de ser opcional.
   */
  const storeVigenteRef = useRef<string | null>(activeStoreId);

  // Al CAMBIAR DE TIENDA hay que vaciar estas tres poblaciones antes de que
  // llegue la lectura de la tienda nueva. Sin esto quedaban colgadas las de la
  // tienda anterior por unos segundos, y `resumenAsesorasHoy` es el peor caso:
  // muestra NOMBRES, así que en Colombia se leían las asesoras de Ecuador con
  // sus números. Mezclar tiendas en pantalla está prohibido en esta operación,
  // aunque dure un segundo. `gestionCargada` vuelve a false para que mientras
  // tanto la pantalla no afirme "nadie llamó a estos": no lo sabe todavía.
  useEffect(() => {
    setGestionPorPedido(new Map());
    setGestionSegPorTelefono(new Map());
    setResumenAsesorasHoy([]);
    setSinRespuestaHoy(null);
    // Los refs también: el ticker recalcula cada minuto sobre `norespRowsRef`,
    // así que dejarlo con las filas de la tienda anterior haría que Colombia
    // mostrara el panel de "no contestaron" de Ecuador hasta la próxima
    // lectura. Mezclar tiendas está prohibido en esta operación, aunque sea un
    // panel y aunque dure un minuto.
    norespRowsRef.current = null;
    sinRespuestaRef.current = null;
    pedidosVivosRef.current = null;
    setGestionCargada(false);
    // Misma razón que `gestionCargada`: los contadores de la tienda anterior no
    // describen a la nueva, y un 0 heredado se leería como "acá no se trabajó".
    setCounterCargado(false);
    setColaConfirmarError(false);
    // Tienda VIGENTE, para que un fetch en vuelo sepa que ya no le corresponde
    // aterrizar. Ver el guard de `loadWorkQueue`.
    storeVigenteRef.current = activeStoreId;
  }, [activeStoreId]);
  const [mySegTouchedToday, setMySegTouchedToday] = useState<Set<string>>(new Set());
  // ¿Se pudo LEER cada set de cobertura? Ver el doc del contrato en OrderState.
  // Booleans separados (no un objeto) a propósito: `ctxValue` está memoizado y un
  // objeto nuevo en cada render invalidaría el memo, re-renderizando a TODOS los
  // consumers de useOrders() — el mismo churn que smartMerge existe para evitar.
  const [coverageConfirmError, setCoverageConfirmError] = useState(false);
  const [coverageSegError, setCoverageSegError] = useState(false);
  const coverageError = coverageConfirmError || coverageSegError;
  // Ver el doc de `counterCargado` / `colaConfirmarError` en OrderState.
  const [counterCargado, setCounterCargado] = useState(false);
  const [colaConfirmarError, setColaConfirmarError] = useState(false);

  // Extracted hooks for data loading and novedades — ahora reciben storeId
  // para filtrar por la tienda activa (multi-tenant).
  const dataLoader = useDataLoader(user, activeStoreId);
  const novedades = useNovedades(user, activeStoreId);

  // Hidratar el contador del día desde la DB al montar.
  //
  // Antes `counter` arrancaba en {0,0,0} y SOLO subía con las acciones de la
  // sesión actual del navegador: la asesora confirmaba 20 pedidos, refrescaba
  // la página y el Dashboard y la CounterBar volvían a marcar 0.
  //
  // Auditoría 2026-07-31: la siembra usaba today_call_stats(), que es PERSONAL
  // (WHERE operator_id = auth.uid()), pero el recompute de buildWorkQueue lee
  // order_results de TODA la tienda — un solo estado con dos poblaciones:
  // CounterBar rotula "Equipo hoy" y el primer segundo mostraba un número
  // personal que "saltaba" al de equipo al llegar el recompute. Ahora la
  // siembra sale de la MISMA fuente store-wide con computeDailyCounter (misma
  // dedup por order_id): una sola población, cero parpadeo personal→equipo.
  //
  // La MISMA lectura sirve para el contador PERSONAL (`myCounter`): se trae
  // operator_id y se computa dos veces sobre las mismas filas. Un segundo query
  // filtrado por mí podría resolver en otro instante y dejar los dos contadores
  // describiendo momentos distintos del día.
  useEffect(() => {
    if (!user || !activeStoreId) return;
    let cancelled = false;
    void (async () => {
      const todayLocal = bogotaToday();
      const { data, error } = await supabase
        .from('order_results')
        .select('order_id, result, result_date, operator_id')
        .eq('store_id', activeStoreId)
        .eq('result_date', todayLocal)
        // Solo llamadas reales — mismo filtro que el recompute (isCallOutcome).
        // Un día de tienda (~150 filas) queda lejos del tope de 1000 filas.
        .in('result', ['conf', 'canc', 'noresp']);
      // ⛔ Un fallo acá NO puede dejar los contadores en 0 haciéndose pasar por
      // medidos: `counterCargado` sigue en false y los consumidores pintan "—".
      if (cancelled || error || !data) return;
      const rows = data as Array<Parameters<typeof computeDailyCounter>[0][number] & { operator_id: string | null }>;
      const next = computeDailyCounter(rows, todayLocal);
      // Idempotente: si el recompute de buildWorkQueue ya sembró los mismos
      // números, devolver `prev` evita un objeto nuevo (ctxValue memoizado).
      setCounter(prev => (
        prev.conf === next.conf && prev.canc === next.canc && prev.noresp === next.noresp
          ? prev
          : next
      ));
      const mine = computeDailyCounter(rows.filter(r => r.operator_id === user.id), todayLocal);
      setMyCounter(prev => (
        prev.conf === mine.conf && prev.canc === mine.canc && prev.noresp === mine.noresp
          ? prev
          : mine
      ));
      // Recién ACÁ un cero es un cero medido.
      setCounterCargado(true);
    })();
    return () => { cancelled = true; };
  }, [user, activeStoreId]);

  const loadWorkQueue = useCallback(async () => {
    if (!user || !activeStoreId) return;
    // Pool compartido: TODAS las operadoras ven TODOS los pendientes de la
    // tienda (sin lock por operadora). La coordinación es por el cooldown
    // compartido (abajo en buildWorkQueue) + la etiqueta de gestión, no por bloqueo.
    // Paginado: PostgREST corta en ~1000 filas SIN avisar. Con la cola por
    // encima de mil, los pendientes sobrantes desaparecían de la pantalla y
    // nadie los llamaba — sin ningún síntoma visible. Ver `paginarQuery`.
    const { filas: dbOrders, error, truncado } = await fetchPendientesDeConfirmar(
      activeStoreId,
      // Corta el paginado apenas cambia la tienda (ver `storeVigenteRef`).
      () => storeVigenteRef.current !== activeStoreId,
    );
    // Y otra vez al aterrizar: `cancelado` se mira ENTRE páginas, así que la
    // última puede llegar justo después del cambio.
    if (storeVigenteRef.current !== activeStoreId) return;
    // ⛔ Antes esto era `if (error) return;` a secas: la cola dejaba de
    // refrescarse y se veía EXACTAMENTE igual que una cola al día — sin toast,
    // sin spinner, sin bandera. La asesora seguía llamando sobre una foto vieja.
    // Los otros dos consumidores del mismo helper (ConfirmarTab) ya avisaban;
    // este camino era el único mudo.
    if (error) {
      setColaConfirmarError(true);
      toast.error('No se pudo refrescar la cola de pedidos — puede estar mostrando datos viejos', {
        id: 'work-queue-load-error', // sonner dedup por id → no se apilan
        duration: 8000,
      });
      return;
    }
    setColaConfirmarError(false);
    if (truncado) toast.warning('Hay tantos pendientes que no caben todos en pantalla. Avisá para subir el tope.');
    const orders = dbOrders.map((o, idx) => dbToOrderData(o, idx));
    // smartMerge (no reemplazo directo): en un refresh de realtime que trae los
    // MISMOS datos, devuelve el array previo intacto → `allOrders` no cambia de
    // referencia → `ctxValue` no cambia → NINGÚN consumer de useOrders()
    // (ConfirmarTab, CallView, CounterBar) re-renderiza. workQueue y counter ya
    // usaban este patrón; allOrders era el único que churneaba en cada refresh
    // y disparaba la cascada de re-render que reseteaba la pantalla.
    setAllOrdersState(prev => smartMerge(prev, orders));
    buildWorkQueue(orders);
    setExcelLoaded(true);
    // Cobertura: cargar set de pedidos de confirmar que YO toqué HOY (Bogotá).
    // Query barato — solo order_id, sin joins. La RLS ya garantiza que solo veo
    // mis filas. Si FALLA marcamos coverageConfirmError en vez de salir mudos:
    // antes el error y el "cargó vacío" compartían el mismo `if (!mine) return`,
    // así que una consulta caída se veía igual que una jornada sin gestionar y el
    // chip "Tu cola hoy" mostraba "Has llamado a 0" — un cero inventado.
    const todayStartIso = new Date(`${bogotaToday()}T00:00:00-05:00`).toISOString();
    void supabase
      .from('order_results')
      .select('order_id')
      .eq('store_id', activeStoreId)
      .eq('operator_id', user.id)
      .eq('module', 'confirmar')
      // Solo llamadas REALES. OrderEditorDialog inserta filas de auditoría con
      // module='confirmar' y result='edicion_orden': sin este filtro, editar un
      // pedido ANTES de llamarlo (p. ej. "Corregir a $X" del chip DE MÁS) lo
      // marcaba como "tocado hoy" y el toggle "Solo sin tocar" lo escondía de
      // la cola sin que nadie lo llamara — venta perdida en silencio.
      .in('result', ['conf', 'canc', 'noresp'])
      .gte('created_at', todayStartIso)
      .then(({ data: mine, error: mineErr }) => {
        if (mineErr || !mine) { setCoverageConfirmError(true); return; }
        const ids = (mine as { order_id: string | null }[])
          .map(r => r.order_id)
          .filter((id): id is string => !!id);
        setMyConfirmTouchedToday(new Set(ids));
        // Cargó bien → a partir de acá un set vacío SÍ significa "no gestionó nada".
        setCoverageConfirmError(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, activeStoreId]);

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
    loadWorkQueue,
  });
  useEffect(() => {
    refreshFnsRef.current = {
      loadNovedades: novedades.loadNovedades,
      loadSegData: dataLoader.loadSegData,
      loadWorkQueue,
    };
  });
  const debouncedRefreshAll = useCallback(() => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      ultimoRefrescoTotalRef.current = Date.now();
      void refreshFnsRef.current.loadNovedades(true);
      void refreshFnsRef.current.loadSegData(true);
      void refreshFnsRef.current.loadWorkQueue();
      refreshTimerRef.current = null;
    }, 800);
  }, []);

  // ── EL BUCLE QUE HACÍA PESADO AL CRM (cortado 28-ago-2026) ─────────────────
  //
  // Medido en producción con `/seguimiento` abierto y NADIE tocando nada:
  // **112 peticiones a la base en 60 segundos** — 65 a `orders`, y 53 de ellas
  // con `offset=`, o sea páginas de la descarga COMPLETA del tablero. Motivo:
  // cualquier UPDATE de `orders` llamaba a `debouncedRefreshAll`, que relanza
  // las ~20 páginas de `loadSegData` + novedades + la cola de Confirmar. El cron
  // de Dropi mueve pedidos sin parar, así que eso corría todo el día.
  //
  // Y se mordía la cola: abrir un pedido dispara `dropi-refresh-order` e
  // `importchat-chat`, que **escriben en `orders`** → otra recarga completa. La
  // ficha competía por el mismo pool del que dependía para cargar. De ahí los
  // "casi 2 minutos" para abrir un pedido.
  //
  // Ahora un UPDATE dice QUÉ pedido cambió y solo se va a buscar ese.
  const idsTocadosRef = useRef<Set<string>>(new Set());
  const flushTocadosRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ultimoRefrescoTotalRef = useRef(0);

  const traerPedidosTocados = useCallback(async (ids: string[]) => {
    if (!user || !activeStoreId || ids.length === 0) return;
    const { data, error } = await supabase
      .from('orders')
      .select(ORDER_COLUMNS)
      .eq('store_id', activeStoreId)
      .in('id', ids);
    // ⛔ Si falla, NO se toca nada: ni se quitan filas, ni se marca la cola como
    // fresca. Un parche fallido nunca puede convertirse en un vacío en pantalla.
    if (error || !Array.isArray(data)) return;
    const filas = data as unknown as DbOrderRow[];
    const frescos = filas.map((r, i) => dbToOrderData(r, i));
    dataLoader.setSegData((prev) => aplicarPedidosTocados(prev, frescos));
    // ⛔ El parche dirigido solo sabía aterrizar en la cola de SEGUIMIENTO.
    // Confirmar se salva de casualidad (`onResultChange` recarga la cola cada
    // vez que alguien marca algo), pero Novedades no tiene equivalente: la
    // transportadora abría una novedad a las 9:05 y la pantalla seguía
    // mostrando la lista anterior hasta el poll de 60 min. La asesora la veía
    // cuando el cliente ya había perdido la ventana de contacto del día.
    //
    // Misma población que `useNovedades.loadNovedades` (estado con NOVEDAD o
    // INTENTO DE ENTREGA + `novedad_sol` distinto de true). Solo se recarga si
    // alguna fila fresca CALIFICA: un pedido que se movió en tránsito no puede
    // costar una recarga de novedades.
    const esNovedadViva = (r: DbOrderRow) => {
      const e = String((r as { estado?: string | null }).estado ?? '').toUpperCase();
      if (!e.includes('NOVEDAD') && !e.includes('INTENTO DE ENTREGA')) return false;
      return (r as { novedad_sol?: boolean | null }).novedad_sol !== true;
    };
    if (filas.some(esNovedadViva)) void refreshFnsRef.current.loadNovedades(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, activeStoreId]);

  const handleOrderTouched = useCallback((id: string) => {
    idsTocadosRef.current.add(id);
    // Throttle TRAILING, no debounce: con el cron escribiendo sin parar, un
    // debounce que se reinicia dispara en huecos aleatorios y nunca se calma.
    // Así se junta todo lo que pase en la ventana y sale UNA sola consulta.
    if (flushTocadosRef.current) return;
    flushTocadosRef.current = setTimeout(() => {
      flushTocadosRef.current = null;
      const ids = [...idsTocadosRef.current];
      idsTocadosRef.current.clear();
      if (!ids.length) return;
      // Barrida grande del cron: ahí sí conviene recargar de una — pero con un
      // piso duro, para que el peor caso sea una recarga cada 90 s en vez de
      // una docena por minuto.
      if (ids.length > MAX_IDS_PARCHE) {
        if (Date.now() - ultimoRefrescoTotalRef.current > PISO_REFRESCO_TOTAL_MS) debouncedRefreshAll();
        return;
      }
      void traerPedidosTocados(ids);
    }, VENTANA_PARCHE_MS);
  }, [traerPedidosTocados, debouncedRefreshAll]);

  useEffect(() => () => {
    if (flushTocadosRef.current) clearTimeout(flushTocadosRef.current);
  }, []);

  // COST-2: auto-sync deshabilitado. Admin usa botón manual o cron server-side.
  // useAutoDropiSync(isAdmin, user?.id, debouncedRefreshAll);

  // Hallazgo 7: aviso de pedido nuevo para atacar los huecos muertos. Cuando
  // llega un INSERT de un PENDIENTE CONFIRMACION nuevo, disparamos una
  // Notification (si hay permiso) y prendemos un "flash" en el título de la
  // pestaña. notifiedOrderIdsRef deduplica para no re-notificar el mismo
  // pedido si realtime reenvía el evento.
  const notifiedOrderIdsRef = useRef<Set<string>>(new Set());
  const [newOrderFlash, setNewOrderFlash] = useState(0);
  const handleOrderInsert = useCallback((row: Record<string, unknown>) => {
    const estado = String(row.estado ?? '').toUpperCase();
    if (estado !== 'PENDIENTE CONFIRMACION') return;
    if (activeStoreId && row.store_id && row.store_id !== activeStoreId) return;
    const oid = String(row.id ?? row.external_id ?? '');
    if (oid && notifiedOrderIdsRef.current.has(oid)) return;
    if (oid) notifiedOrderIdsRef.current.add(oid);
    // Badge en el título de la pestaña — se recalcula en el effect de abajo.
    setNewOrderFlash(v => v + 1);
    // Notificación nativa (guard de permiso). El aviso trae de vuelta a la
    // operadora cuando la pestaña está en background.
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('Nuevo pedido — llamar ahora', {
          body: String(row.nombre ?? '') || 'Un cliente acaba de comprar',
          tag: oid || 'nuevo-pedido', // colapsa avisos repetidos del mismo pedido
        });
      }
    } catch {
      // Notification puede lanzar en contextos no seguros — no romper la app.
    }
  }, [activeStoreId]);

  // Realtime: cuando cualquier operadora cambia orders o inserta un
  // order_result, todos los caches se refrescan vía el mismo timer
  // debounced para evitar el ráfaga de fetches duplicados.
  useRealtimeOrders(user, {
    // INSERT/DELETE: hay que traer un pedido que NO está en memoria → recarga.
    onOrderChange: debouncedRefreshAll,
    // UPDATE: se parchea solo ese pedido. Ver el bloque de arriba.
    onOrderTouched: handleOrderTouched,
    // ⛔ Un `order_result` nuevo NO puede cambiar la población de Seguimiento ni
    // la de Novedades: es una gestión sobre un pedido que ya está en la cola. Lo
    // único que hay que recomputar es el `result`/`retryCount` de Confirmar. Con
    // `debouncedRefreshAll` cada confirmación costaba las tres cargas completas.
    onResultChange: () => { void refreshFnsRef.current.loadWorkQueue(); },
    // Hallazgo 6: al volver la pestaña visible, los eventos que se descartaron
    // mientras estaba oculta se recuperan con un catch-up explícito (mismo
    // refresh debounced que usan orders/results).
    onVisibleCatchUp: debouncedRefreshAll,
    // Hallazgo 7: aviso de pedido nuevo (notificación + badge en el título).
    onOrderInsert: handleOrderInsert,
  }, activeStoreId);

  // Hallazgo 7: badge "(N) Confirmar" en el título de la pestaña. N = pendientes
  // sin gestionar en la cola (result vacío). Se recalcula cuando cambia la cola
  // o llega un pedido nuevo (newOrderFlash). Al desmontar restaura el título.
  useEffect(() => {
    const original = document.title.replace(/^\(\d+\)\s*/, '');
    const sinGestionar = workQueue.filter(o => !o.result).length;
    document.title = sinGestionar > 0 ? `(${sinGestionar}) ${original}` : original;
    return () => { document.title = document.title.replace(/^\(\d+\)\s*/, ''); };
  }, [workQueue, newOrderFlash]);

  // Hallazgo 6 (poll de respaldo): la cola de Confirmar dependía 100% de
  // realtime. Un hueco de red o un evento perdido dejaba la cola congelada
  // indefinidamente. Igual que seg/novedades, agregamos un poll cada 5 min
  // (solo con la pestaña visible) que recarga el workQueue como red de
  // seguridad. loadWorkQueue ya hace smartMerge → sin datos nuevos no
  // re-renderiza (no hay parpadeo ni costo de churn).
  useEffect(() => {
    if (!user || !activeStoreId) return;
    // COST-2 2026-07-10: 5 → 30 min. Realtime cubre updates en vivo.
    return pollWhenVisible(() => { void loadWorkQueue(); }, 30 * 60 * 1000, { runOnVisible: false });
  }, [user, activeStoreId, loadWorkQueue]);

  // El panel de "no contestaron", contra el reloj (arreglo 31-jul).
  //
  // Todo lo demás de esta pantalla cambia porque ALGUIEN hace algo, y para eso
  // está el realtime. El enfriamiento no: un pedido pasa de "esperando" a "se
  // puede llamar ya" solo porque pasó el tiempo. Como el resumen se calculaba
  // una única vez dentro de loadWorkQueue, el cartel "el próximo en 12 min"
  // seguía diciendo 12 media hora después, y "3 para llamar ya" no crecía.
  // Justo al final del día —cuando nadie marca nada, no hay realtime y el poll
  // es de 30 min— era cuando más mentía, que es exactamente cuando el panel
  // existe para decidir si quedan llamadas por hacer.
  //
  // Se recalcula sobre las filas YA leídas: cero consultas nuevas.
  useEffect(() => {
    if (!user || !activeStoreId) return;
    const id = setInterval(() => {
      const filas = norespRowsRef.current;
      if (!filas) return;
      const next = resumenSinRespuestaHoy(filas, bogotaToday(), Date.now(), pedidosVivosRef.current);
      const prev = sinRespuestaRef.current;
      if (mismoResumen(prev, next)) return;
      // Si alguien cruzó el enfriamiento, la COLA también tiene que enterarse.
      // `retryCount` se calcula en el mismo loadWorkQueue, así que sin esto el
      // panel diría "3 para llamar ya" y el filtro de reintentos mostraría 0 —
      // prometer una llamada que la cola no entrega es peor que no avisar.
      if (prev && next.listos > prev.listos) void refreshFnsRef.current.loadWorkQueue();
      sinRespuestaRef.current = next;
      setSinRespuestaHoy(next);
    }, 60_000);
    return () => clearInterval(id);
  }, [user, activeStoreId]);

  // Set de Seguimiento del día (touchpoints SEG:* míos). touchpoints no tiene
  // order_id: el match contra segData es por phone.
  //
  // Está extraído en su propia función porque necesita un camino de REINTENTO.
  // El set de Confirmar se auto-cura solo (loadWorkQueue lo recarga en cada poll
  // de 30 min y en cada evento realtime); este se cargaba UNA sola vez por
  // [user, activeStoreId], así que un blip de red a las 8am dejaba
  // `coverageSegError` en true toda la jornada: el tablero de Seguimiento
  // mostraba como pendientes las tarjetas ya gestionadas y la asesora
  // re-trabajaba pedidos, hasta que a alguien se le ocurriera recargar.
  const loadSegCoverage = useCallback(async (): Promise<boolean> => {
    if (!user || !activeStoreId) return false;
    // Recalculada en cada intento, no capturada: un reintento que cruza la
    // medianoche Bogotá tiene que leer el día NUEVO.
    const todayStartIso = new Date(`${bogotaToday()}T00:00:00-05:00`).toISOString();
    // La consulta trae UNA semana; el corte de "hoy" se aplica en memoria (ver
    // abajo). Una semana de una tienda son unos cientos de filas y la
    // paginación ya está puesta, así que no cuesta una consulta más.
    const historiaDesdeIso = new Date(Date.parse(todayStartIso) - 7 * 86400000).toISOString();
    // Sin `.eq('operator_id', user.id)`: la MISMA consulta sirve para las dos
    // poblaciones (la mía y la del equipo) y se parte en memoria. Traer solo lo
    // mío era la razón por la que el tablero de Seguimiento le mostraba a una
    // asesora como "sin gestionar" un pedido que otra ya había trabajado esa
    // mañana. Un día de una tienda son decenas de filas, pero se pagina igual:
    // PostgREST corta en 1000 EN SILENCIO y un corte acá se vería como "nadie
    // lo gestionó" — el error más caro posible en esta pantalla.
    type TpRow = { phone: string; action: string; operator_id: string | null; created_at: string };
    const PAGE = 1000;
    const filas: TpRow[] = [];
    for (let desde = 0; ; desde += PAGE) {
      const { data, error: segErr } = await supabase
        .from('touchpoints')
        .select('phone, action, operator_id, created_at')
        .eq('store_id', activeStoreId)
        .ilike('action', 'SEG:%')
        .gte('created_at', historiaDesdeIso)
        .order('created_at', { ascending: false })
        .range(desde, desde + PAGE - 1);
      // "No se pudo leer" se marca, no se disfraza de cero.
      if (segErr || !data) { setCoverageSegError(true); return false; }
      filas.push(...(data as TpRow[]));
      if (data.length < PAGE || filas.length >= 10000) break;
    }
    // ⛔ HOY y la HISTORIA se separan acá, en memoria (una sola consulta).
    //
    // El dueño, mirando el tablero: *"esa Soledad, yo sé que Roberto la tocó y
    // no sale"*. Tenía razón. Medido en el pedido 6637528: tres gestiones
    // `SEG: Reclamé transportadora` del 27-ago y un "No respondió" del 21 — la
    // ventana era `todayStartIso`, así que la tarjeta no las veía y la asesora
    // volvía a trabajar un pedido que su compañera ya había reclamado.
    //
    // La ventana de la CONSULTA pasó a 7 días, pero lo que cuenta como "de hoy"
    // NO se toca: `mySegTouchedToday` y `gestionSegPorTelefono` siguen saliendo
    // solo de las filas de hoy. Mezclarlas haría que un pedido tocado anteayer
    // contara como trabajado hoy, y el cierre del día firmaría números falsos.
    const deHoy = filas.filter(r => r.created_at >= todayStartIso);
    setMySegTouchedToday(new Set(deHoy.filter(r => r.operator_id === user.id).map(r => r.phone)));
    setGestionSegPorTelefono(prev => {
      const next = buildGestionSegPorTelefono(deHoy);
      return mismaGestion(prev, next) ? prev : next;
    });
    // Lo de los días ANTERIORES a hoy. Nunca bloquea — un contacto de anteayer
    // no puede impedir trabajarlo hoy — y hace dos trabajos:
    //   · la tarjeta dice quién lo intentó cuando hoy no lo tocó nadie;
    //   · `cicloContacto` le suma sus `intentos` a los de hoy para que la
    //     etiqueta diga "4º intento" y no "2º" (decisión del dueño, 28-ago).
    //
    // ⛔ EXCLUYE hoy a propósito. Si trajera también las de hoy, la suma
    // `previa + hoy` contaría dos veces cada gestión de la mañana. Y no alcanza
    // con "restar": este mapa se arma UNA vez al cargar, mientras que el de hoy
    // sigue creciendo en vivo con cada clic — separados, los dos quedan bien
    // durante todo el turno.
    const previas = filas.filter(r => r.created_at < todayStartIso);
    setUltimaGestionSeg(prev => {
      const next = buildGestionSegPorTelefono(previas);
      return mismaGestion(prev, next) ? prev : next;
    });
    setCoverageSegError(false);
    return true;
  }, [user, activeStoreId]);

  // Reintento con backoff mientras la lectura siga fallando (2s, 4s, 8s… tope
  // 60s). Cuando entra bien, `coverageSegError` pasa a false y el effect se
  // apaga solo; el intento vuelve a cero para el próximo fallo.
  const [segRetryAttempt, setSegRetryAttempt] = useState(0);
  useEffect(() => {
    if (!coverageSegError || !user || !activeStoreId) return;
    const delay = Math.min(60_000, 2000 * 2 ** segRetryAttempt);
    const t = setTimeout(() => {
      void loadSegCoverage().then(ok => { setSegRetryAttempt(n => (ok ? 0 : n + 1)); });
    }, delay);
    return () => clearTimeout(t);
  }, [coverageSegError, segRetryAttempt, user, activeStoreId, loadSegCoverage]);

  // Cobertura del día (mySegTouchedToday inicial + realtime de los 2 sets).
  // Por qué un effect separado: estos sets son `myConfirmTouchedToday` y
  // `mySegTouchedToday`, no afectan al workQueue ni al counter, solo al chip
  // "Tu cola hoy". Si los cargáramos dentro de `loadWorkQueue`, no se
  // refrescarían cuando otra operadora confirma un pedido (esa rama ya no
  // pasa por mí). Aquí mantenemos los dos sets sincronizados vía realtime
  // sobre INSERT filtrado por operator_id=me.
  useEffect(() => {
    if (!user || !activeStoreId) return;
    const loadDay = bogotaToday();
    coverageDayRef.current = loadDay;
    const todayStartIso = new Date(`${loadDay}T00:00:00-05:00`).toISOString();

    // #16: si cruzamos la medianoche Bogotá con la pestaña abierta, los sets de
    // cobertura tienen el conteo de AYER. Antes de agregar cualquier fila nueva
    // (o en el chequeo periódico de abajo) reseteamos ambos sets al detectar el
    // cambio de día. Devuelve true si hubo reset (para no seguir con `prev` viejo).
    const rolloverIfNeeded = (): boolean => {
      const day = bogotaToday();
      if (day === coverageDayRef.current) return false;
      coverageDayRef.current = day;
      setMyConfirmTouchedToday(new Set());
      setMySegTouchedToday(new Set());
      // Las poblaciones de EQUIPO también son "de hoy" y también tienen que
      // vaciarse al cruzar la medianoche. Faltaban acá (bug del 31-jul): a las
      // 00:01 la cola seguía mostrando "Ana · No contestó · ayer" sobre pedidos
      // que nadie había llamado ese día, y peor — `aplicarGestionEnVivo` suma
      // sobre lo que encuentra, así que la PRIMERA llamada del día nuevo se
      // pintaba "intento 3 de 3" y la asesora dejaba de marcar a un cliente que
      // tenía sus tres intentos intactos. Se curaba solo, pero recién en el
      // siguiente loadWorkQueue: hasta 30 minutos después (el poll es de 30 min).
      setGestionPorPedido(new Map());
      setGestionSegPorTelefono(new Map());
      setResumenAsesorasHoy([]);
      setSinRespuestaHoy(null);
      sinRespuestaRef.current = null;
      norespRowsRef.current = null;
      pedidosVivosRef.current = null;
      // El mapa vuelve a estar vacío por FALTA DE DATOS, no por falta de
      // llamadas: hasta la próxima lectura la pantalla no puede afirmar
      // "a estos no los llamó nadie".
      setGestionCargada(false);
      return true;
    };

    // Hallazgo "cola-hoy": la carga inicial de myConfirmTouchedToday vivía SOLO
    // dentro de loadWorkQueue. Tras recargar la página en una ruta que no lo
    // dispara (o antes de que corra), el chip "Tu cola hoy" mostraba
    // "Has llamado a 0" hasta que llegara un evento realtime. Cargándolo también
    // aquí (mismo effect de cobertura que corre al montar) el chip arranca con
    // el número correcto. Query barato: solo order_id filtrado por mí + hoy.
    void supabase
      .from('order_results')
      .select('order_id')
      .eq('store_id', activeStoreId)
      .eq('operator_id', user.id)
      .eq('module', 'confirmar')
      // Igual que en loadWorkQueue: solo llamadas reales — las filas de
      // auditoría (result='edicion_orden') no cuentan como "tocado hoy".
      .in('result', ['conf', 'canc', 'noresp'])
      .gte('created_at', todayStartIso)
      .then(({ data: mine, error: mineErr }) => {
        // Mismo criterio que en loadWorkQueue: error ≠ vacío. Sin esta rama, una
        // consulta caída dejaba el set vacío y el chip afirmaba "0 llamados".
        if (mineErr || !mine) { setCoverageConfirmError(true); return; }
        const ids = (mine as { order_id: string | null }[])
          .map(r => r.order_id)
          .filter((id): id is string => !!id);
        setMyConfirmTouchedToday(new Set(ids));
        setCoverageConfirmError(false);
      });

    // Carga inicial del set de seguimiento (touchpoints SEG:* del día).
    void loadSegCoverage();

    // Realtime por TIENDA, no por operadora (arreglo 2026-07-31).
    //
    // El filtro era `operator_id=eq.<yo>`: solo llegaban MIS inserts. Con eso,
    // cuando Ana marcaba un pedido, la pantalla de Sofía NO se enteraba —
    // justo lo contrario de para lo que se hizo la vista de equipo. En
    // Seguimiento era peor: `gestionSegPorTelefono` solo se recarga en
    // [user, activeStoreId], así que la gestión de una compañera no aparecía
    // hasta recargar la página, y las dos podían contactar al mismo cliente.
    //
    // Ahora el filtro es por tienda y el handler parte las dos poblaciones:
    // si la fila es mía actualiza además el set PERSONAL; el mapa de EQUIPO se
    // actualiza siempre. Sigue sin costar consultas: la fila llega completa en
    // el payload. (Realtime no soporta ILIKE, así que module/action se siguen
    // filtrando en el cliente.)
    const channel = supabase
      .channel(`coverage-${activeStoreId}-${user.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'order_results',
          filter: `store_id=eq.${activeStoreId}`,
        },
        (payload) => {
          const row = payload.new as {
            order_id?: string; module?: string; store_id?: string; result?: string;
            operator_id?: string | null; reason?: string | null; created_at?: string;
          };
          if (row.module !== 'confirmar') return;
          // Igual que las cargas iniciales: una fila de auditoría (edición de
          // orden) NO es una llamada — no debe entrar al set de "tocados hoy".
          // La fila llega completa en el payload, cero queries extra.
          if (row.result !== 'conf' && row.result !== 'canc' && row.result !== 'noresp') return;
          if (row.store_id !== activeStoreId) return;
          if (!row.order_id) return;
          // Nuevo día → los sets se vacían; la fila de abajo (que ES de hoy)
          // se agrega sobre el set ya reseteado (setState funcional en orden).
          rolloverIfNeeded();
          // Mapa de EQUIPO: se actualiza sea de quien sea la llamada.
          setGestionPorPedido(prev => aplicarGestionEnVivo(prev, row.order_id!, {
            at: row.created_at || new Date().toISOString(),
            por: row.operator_id ?? null,
            result: row.result!,
            motivo: row.reason,
          }));
          // Set PERSONAL: solo si la llamada es mía.
          if (row.operator_id !== user.id) return;
          setMyConfirmTouchedToday(prev => {
            if (prev.has(row.order_id!)) return prev;
            const next = new Set(prev);
            next.add(row.order_id!);
            return next;
          });
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'touchpoints',
          filter: `store_id=eq.${activeStoreId}`,
        },
        (payload) => {
          const row = payload.new as {
            phone?: string; action?: string; store_id?: string;
            operator_id?: string | null; created_at?: string;
          };
          if (!row.action?.startsWith('SEG:')) return;
          if (row.store_id !== activeStoreId) return;
          if (!row.phone) return;
          rolloverIfNeeded();
          setGestionSegPorTelefono(prev => aplicarGestionEnVivo(prev, row.phone!, {
            at: row.created_at || new Date().toISOString(),
            por: row.operator_id ?? null,
            result: row.action!.replace(/^SEG:\s*/i, '').trim(),
          }));
          if (row.operator_id !== user.id) return;
          setMySegTouchedToday(prev => {
            if (prev.has(row.phone!)) return prev;
            const next = new Set(prev);
            next.add(row.phone!);
            return next;
          });
        },
      )
      .subscribe();

    // ⛔ Lo PROPIO no espera al realtime (bug del 27-ago-2026).
    //
    // El handler de `touchpoints` de arriba estaba escrito y correcto, pero la
    // tabla NUNCA se agregó a la publicación `supabase_realtime`: los INSERT no
    // llegaban y estos dos sets no crecían nunca. La asesora marcaba "Avisé: en
    // oficina" y el contador se quedaba clavado — *"sí le pongo pero no baja el
    // número"*. Se lo tomó por falta de trabajo.
    //
    // `useRecordGestion` emite este evento DESPUÉS de que la base confirmó la
    // fila, así que acá se aplica exactamente lo mismo que aplicaría el
    // realtime, sin depender de él. Cuando el realtime también llegue, el
    // segundo pase es inocuo: `aplicarGestionEnVivo` deduplica por `at`, que en
    // ese camino es el `created_at` REAL devuelto por el INSERT.
    //
    // ⛔ Salvo cuando el aviso es `optimista` (lo emiten los envíos de WhatsApp,
    // donde el touchpoint lo inserta la edge function y no vuelve la fila): ahí
    // el `at` es la hora del navegador y NO va a coincidir con el que traiga el
    // realtime, así que el intento se contaría dos veces — "2 gestiones" por un
    // solo mensaje, un dato inflado sobre el trabajo de alguien. En ese caso se
    // aplica solo el Set, que es idempotente por naturaleza y es lo que hace
    // bajar el contador; el conteo de intentos lo pone el realtime con el dato
    // bueno.
    const desuscribirGestion = onGestion((d) => {
      if (d.modulo !== 'SEG' || !d.phone) return;
      rolloverIfNeeded();
      if (!d.optimista) {
        setGestionSegPorTelefono(prev => aplicarGestionEnVivo(prev, d.phone, {
          at: d.at,
          por: d.operatorId,
          result: d.accion,
        }));
      }
      if (d.operatorId !== user.id) return;
      setMySegTouchedToday(prev => {
        if (prev.has(d.phone)) return prev;
        const next = new Set(prev);
        next.add(d.phone);
        return next;
      });
    });

    // Pestaña ociosa que cruza medianoche sin eventos: el chequeo periódico
    // vacía los sets al cambiar de día para que el chip no muestre lo de ayer.
    const dayCheck = setInterval(() => { rolloverIfNeeded(); }, 60 * 1000);

    return () => {
      clearInterval(dayCheck);
      desuscribirGestion();
      void supabase.removeChannel(channel);
    };
  }, [user, activeStoreId, loadSegCoverage]);

  // Prevents double-click race: tracks phones currently being processed by markResult.
  const markingInFlight = useRef(new Set<string>());
  // Coordinación undoLast ↔ markDropiFailure POR PEDIDO (dbId). Antes era un
  // único boolean compartido: con dos confirmaciones en vuelo (avance
  // inmediato + Dropi throttleado EC), el fallo de la 1ª ponía el flag en true
  // y el fallo de la 2ª retornaba temprano → toast colgado, sin aviso de error,
  // fila sin marcar failed (si era bot, el cron quemaba sus reintentos) =
  // fuga silenciosa. Un Set de dbId aísla cada confirmación.
  const revertedIds = useRef(new Set<string>());
  // Fix D4: cada llamada a buildWorkQueue incrementa este id. El fetch
  // async de order_results valida que el id siga siendo el suyo antes de
  // hacer setWorkQueue/setCounter — si llegó un build más nuevo (p. ej.
  // realtime trajo un cambio mientras la operadora hacía scroll), descarta
  // el resultado para no pisar estado fresco con datos viejos.
  const lastBuildIdRef = useRef(0);
  // Teléfonos cuyo aviso "disponible para reintentar" YA se mostró esta sesión.
  // Evita el spam del toast en cada poll/refresh (buildWorkQueue corre seguido).
  const announcedRetryPhonesRef = useRef<Set<string>>(new Set());
  // #16: día Bogotá con el que se cargaron los sets de cobertura del día
  // (myConfirmTouchedToday / mySegTouchedToday). Con una pestaña abierta que
  // cruza la medianoche, el chip "Has llamado a X" conservaba el conteo de
  // ayer. Comparamos contra este ref en cada evento realtime (y en un chequeo
  // periódico para la pestaña ociosa) y reseteamos los sets al cambiar de día.
  const coverageDayRef = useRef(bogotaToday());

  useEffect(() => {
    requestNotificationPermission();
  }, [requestNotificationPermission]);

  const setAllOrders = useCallback((orders: OrderData[]) => {
    setAllOrdersState(orders);
  }, []);

  const buildWorkQueue = useCallback((orders: OrderData[]) => {
    const buildId = ++lastBuildIdRef.current;
    const pendientes = orders.filter(o => isPendiente(o.estado));
    // Hallazgo 4: la cola de Confirmar NO usa calcPriority (compartido con
    // Seguimiento y que para un PENDIENTE fresco da ~0 → desempataba por
    // b.dias-a.dias = MÁS VIEJO primero, hundiendo al comprador de hace 5 min).
    // compareConfirmar prioriza recordatorio vencido → reintento listo →
    // FRESCOS de hoy (más nuevo primero) → viejos → D4+ "por cancelar" al fondo.
    pendientes.sort((a, b) => compareConfirmar(a, b));

    const seen = new Set<string>();
    const dedupPendientes = pendientes.filter(o => {
      // Prefer externalId as dedup key — it's unique per order in Dropi.
      // Fall back to phone+producto for orders loaded from Excel without externalId.
      const key = o.externalId || ((o.phone || '') + '|' + (o.producto || ''));
      if (!o.phone || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Fase 1 (síncrona): mostrar la cola YA. Pero los pendientes frescos del DB
    // NO traen `result`/`retryCount` (eso lo calcula la fase async de abajo desde
    // order_results). Sin conservar el estado ya conocido de `prev`, esta fase
    // "limpiaba" el result de los pedidos ya gestionados → el contador POR
    // CONFIRMAR parpadeaba (7→8→7) en CADA refresh hasta que la fase async lo
    // re-aplicaba. Carry-over: heredamos result/reason/retryCount de prev por
    // dbId para que smartMerge no vea cambio y el conteo quede estable.
    setWorkQueue(prev => {
      const prevById = new Map(prev.filter(p => p.dbId).map(p => [p.dbId, p]));
      const carried = dedupPendientes.map(o => {
        const old = o.dbId ? prevById.get(o.dbId) : undefined;
        return old && (old.result || old.retryCount)
          ? { ...o, result: old.result, reason: old.reason, retryCount: old.retryCount }
          : o;
      });
      return smartMerge(prev, carried);
    });
    // ANTES: aquí setSegData(smartMerge(prev, segNext)) con la lista
    // PENDIENTE-only. Pero esa lista NO contiene Seguimiento (filtra
    // por isPendiente arriba), así que `segNext` era un subconjunto
    // muy pequeño y `smartMerge` veía deletions → array nuevo
    // pisoteando la Seguimiento real. Resultado: cada evento Confirmar
    // hacía parpadear Seguimiento. Ahora Seguimiento solo se actualiza
    // por loadSegData() (su query propia), no por buildWorkQueue.

    if (user) {
      // BUG A fix: pull last 7 days so confirmations done late yesterday
      // (or near midnight) don't reappear in the queue today.
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);
      // Pool compartido: el cooldown/conteo de intentos es POR TIENDA (todas
      // las operadoras), no por operadora. Así el tope de llamadas del día y la
      // espera entre intentos se cuentan globalmente por pedido — sin doble
      // llamada. Los números viven en confirmarQueue.ts, no acá.
      //
      // Paginación (auditoría 2026-07-31): Supabase corta todo SELECT a ~1000
      // filas EN SILENCIO. Con ~100+ gestiones/día + reintentos noresp +
      // auditoría, 7 días superan ese tope y, sin ORDER BY, Postgres devolvía
      // 1000 filas arbitrarias — se perdían filas de HOY: pedidos ya marcados
      // "no contestó" volvían a la cola antes del cooldown y el contador del
      // día subcontaba. Mismo patrón .range() que loadSegData (useDataLoader),
      // ordenado más-nuevo-primero para que, si el tope duro llegara a cortar,
      // lo truncado sean filas VIEJAS (irrelevantes para cooldown/contador).
      type ResultRow = {
        order_id: string | null;
        phone: string;
        result: string;
        reason: string | null;
        result_time: string | null;
        result_date: string | null;
        created_at: string;
        // Solo para partir el contador del día en equipo vs. personal (myCounter).
        // No participa del cooldown ni del resultMap: la cola es pool compartido.
        operator_id: string | null;
      };
      const fetchResultRows = async (): Promise<ResultRow[]> => {
        const PAGE_SIZE = 1000;
        const HARD_LIMIT = 10000;
        const all: ResultRow[] = [];
        let fromIdx = 0;
        for (;;) {
          const { data, error } = await supabase.from('order_results')
            .select('order_id, phone, result, reason, result_time, result_date, created_at, operator_id')
            .eq('store_id', activeStoreId)
            // Solo resultados de llamada reales: las filas de auditoría
            // ('edicion_orden', 'cambio_transportadora') no afectan cooldown ni
            // contador (isCallOutcome ya las ignoraba client-side) y solo
            // quemaban presupuesto de filas de la paginación.
            .in('result', ['conf', 'canc', 'noresp'])
            .gte('result_date', sevenDaysAgo)
            .order('created_at', { ascending: false })
            .range(fromIdx, fromIdx + PAGE_SIZE - 1);
          // Lanzar (no tragar): datos PARCIALES aplicados como overlay son
          // peores que no aplicar nada — el .catch de abajo avisa y conserva
          // el estado previo (carry-over de la fase síncrona).
          if (error) throw error;
          const page = (data || []) as ResultRow[];
          all.push(...page);
          if (page.length < PAGE_SIZE || all.length >= HARD_LIMIT) break;
          fromIdx += PAGE_SIZE;
        }
        return all;
      };
      fetchResultRows()
        .then((data) => {
          // Si llegó un buildWorkQueue más nuevo mientras el fetch corría,
          // descarta este resultado — el estado ya fue reemplazado por
          // datos más frescos.
          if (buildId !== lastBuildIdRef.current) return;
          if (data) {
            const now = Date.now();
            // BUG 1/2 fix: only consider real call outcomes. Audit rows like
            // 'edicion_orden' must NOT mark a pedido as resuelto ni inflar el
            // counter de "no respondió".
            const isCallOutcome = (r: string) => r === 'conf' || r === 'canc' || r === 'noresp';
            const todayLocal = bogotaToday();
            // El cooldown es PLANO: `cooldownHoursForAttempt` devuelve lo mismo
            // sea el 1er o el 3er reintento (COOLDOWN_MINUTES, hoy 60 min). El
            // parámetro `todayCount` que se le pasa abajo sobrevive solo por
            // compatibilidad de firma. Este comentario decía lo contrario —
            // describía una escalera (0.4h → 1h → 2h) que se quitó por decisión
            // del dueño y que ya no existe en el código. El cap de 3 intentos/día
            // SÍ se mantiene (alineado con la RPC pending_retry_list, que asume 3).
            // MAX_DAILY_ATTEMPTS ahora vive en confirmarQueue.ts: la ficha de
            // llamada muestra "Hoy 2 de 3" y tiene que salir del MISMO numero
            // que aplica el cooldown, o la pantalla prometeria un intento que
            // el sistema no da.

            // Noresps de HOY agrupados por phone
            const todayNoresp = new Map<string, ResultRow[]>();
            (data as ResultRow[]).forEach(r => {
              if (r.result !== 'noresp') return;
              if (r.result_date !== todayLocal) return;
              if (!todayNoresp.has(r.phone)) todayNoresp.set(r.phone, []);
              todayNoresp.get(r.phone)!.push(r);
            });

            // resultMap: conf/canc siempre; noresp solo si alcanzó cap de hoy o
            // sigue en cooldown. El cooldown es PLANO de 1 h (COOLDOWN_MINUTES,
            // ajustado a la jornada 8-5): llamo 9 → vuelve 10 → 11, hasta 3.
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
              const cooldownHours = cooldownHoursForAttempt(todayCount);
              const hoursElapsed = (now - new Date(r.created_at).getTime()) / (1000 * 60 * 60);
              if (hoursElapsed < cooldownHours) {
                resultMap.set(r.order_id, { result: 'noresp', reason: r.reason || '' });
              }
            });

            // retryPhones: noresps de HOY con <3 intentos cuya última llamada ya
            // cumplió el cooldown (ver arriba).
            const retryPhones = new Map<string, number>();
            todayNoresp.forEach((results, phone) => {
              const count = results.length;
              if (count === 0 || count >= MAX_DAILY_ATTEMPTS) return;
              const latest = results.reduce((max, r) =>
                Math.max(max, new Date(r.created_at).getTime()), 0);
              const hoursSinceLatest = (now - latest) / (1000 * 60 * 60);
              if (hoursSinceLatest >= cooldownHoursForAttempt(count)) {
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
            // smartMerge (no reemplazo directo): si la ráfaga de realtime trajo
            // los MISMOS datos, smartMerge devuelve el array previo intacto y
            // React no re-renderiza la cola → mata el parpadeo. Los cambios
            // reales (result/reason/retryCount) pasan porque ya están en
            // fieldsChanged de smartMerge.
            setWorkQueue(prev => {
              // ⛔ CARRY-OVER, igual que la fase síncrona. Esta lectura NO es
              // autoritativa sobre lo que la asesora acaba de marcar: cualquier
              // `buildWorkQueue` que ya estuviera en vuelo cuando ella tocó
              // "Confirmó" resuelve DESPUÉS con filas anteriores a su marca, y
              // sin esto el pedido volvía a aparecer "Pendiente" un instante
              // después del toast. Si lo re-gestionaba salía "Confirmación local
              // falló: pedido no encontrado" sobre un pedido bien confirmado.
              // Un result que ya está en `prev` solo puede irse por `undoLast`.
              const prevById = new Map(prev.filter(x => x.dbId).map(x => [x.dbId, x]));
              const conservado = updated.map(o => {
                const old = o.dbId ? prevById.get(o.dbId) : undefined;
                return (!o.result && old?.result)
                  ? { ...o, result: old.result, reason: old.reason }
                  : o;
              });
              // Y RE-ORDENAR: `compareConfirmar` mira `retryCount` y
              // `nextReminderAt`, que no existían todavía en el sort de la fase
              // síncrona (se calculan acá). Sin esto el reintento listo se
              // habilitaba a la hora exacta pero quedaba enterrado por su edad
              // —a veces en la zona "por cancelar" del fondo— y solo se
              // encontraba tocando el banner naranja. Medido: se habilita a la
              // hora y se llama con mediana de 2,6 h.
              return smartMerge(prev, [...conservado].sort((a, b) => compareConfirmar(a, b)));
            });

            // Avisar SOLO por teléfonos nuevos (no re-mostrar en cada poll → no spam).
            // El banner naranja arriba de la lista ya muestra el conteo en vivo.
            if (retryPhones.size > 0) {
              const nuevos = [...retryPhones.keys()].filter(p => !announcedRetryPhonesRef.current.has(p));
              if (nuevos.length > 0) {
                nuevos.forEach(p => announcedRetryPhonesRef.current.add(p));
                toast.info(`${nuevos.length} pedido${nuevos.length > 1 ? 's' : ''} sin respuesta listo${nuevos.length > 1 ? 's' : ''} para reintentar`, {
                  description: 'Tocá el aviso naranja arriba de la lista para verlos',
                  duration: 6000,
                  id: 'retry-available', // sonner dedup por id → nunca se apilan
                });
                // Notificación NATIVA, además del toast. Medido el 13-ago (bloque
                // A del diagnóstico): el reintento vuelve a la cola a la hora
                // exacta, pero se llama con mediana de 2,6 h — porque cuando el
                // enfriamiento vence la asesora está en OTRA pestaña y el toast
                // no existe fuera de esta. Es el mismo aviso que ya trae de
                // vuelta a la operadora cuando entra un pedido nuevo (Hallazgo 7).
                try {
                  if ('Notification' in window && Notification.permission === 'granted') {
                    new Notification(
                      nuevos.length > 1
                        ? `${nuevos.length} clientes volvieron a la cola — llamar ahora`
                        : 'Un cliente volvió a la cola — llamar ahora',
                      {
                        body: 'No contestaron antes y ya cumplieron la hora de espera. Les quedan llamadas hoy.',
                        tag: 'retry-disponible', // colapsa avisos repetidos
                      },
                    );
                  }
                } catch {
                  // Notification puede lanzar en contextos no seguros — no romper la app.
                }
              }
            }

            // Contador solo de HOY para que cuadre con TasaMetaBanner y la meta
            // diaria. Dedup por order_id (espeja RPC operator_productivity_stats
            // v20260505184140): si la operadora marca "no contestó" 3 veces el
            // mismo pedido por el cooldown, cuenta como 1; y si después
            // confirma, ese pedido suma a conf y NO a noresp. Lógica
            // compartida en computeDailyCounter para que CounterBar y panel
            // admin nunca diverjan.
            // Idempotente: si los conteos no cambiaron, devolver `prev` para NO
            // crear un objeto nuevo. `counter` está en el value memoizado del
            // OrderContext, así que un objeto nuevo en cada refresh re-renderiza
            // a TODOS los consumers de useOrders (CounterBar, ConfirmarTab, …)
            // aunque los números sean idénticos — la causa principal del
            // "parpadeo de toda la página" bajo ráfagas de realtime.
            setCounter(prev => {
              const next = computeDailyCounter(data as Parameters<typeof computeDailyCounter>[0], todayLocal);
              return (prev.conf === next.conf && prev.canc === next.canc && prev.noresp === next.noresp)
                ? prev
                : next;
            });
            // Mismas filas otra vez: quién del EQUIPO llamó cada pedido hoy.
            // `mismaGestion` conserva la referencia previa cuando nada cambió —
            // si devolviéramos un Map nuevo en cada ráfaga de realtime,
            // re-renderizaríamos la cola entera para pintar lo mismo.
            setGestionPorPedido(prev => {
              const next = buildGestionPorPedido(data as Parameters<typeof buildGestionPorPedido>[0], todayLocal);
              return mismaGestion(prev, next) ? prev : next;
            });
            // Un mapa vacio es AMBIGUO: puede ser "nadie llamo nada todavia" o
            // "la consulta nunca corrio". Sin esta bandera, un fallo en la
            // primera carga haria decir "nadie llamo a estos 33" — y la asesora
            // repetiria 20 llamadas. Solo despues de UNA lectura buena se puede
            // afirmar que el vacio es real.
            setGestionCargada(true);
            // Mismas filas, cuarta poblacion: el estado de los "no contesto".
            // Se guardan las filas para poder re-evaluar el enfriamiento contra
            // el reloj cada minuto (ver el ticker) sin re-consultar la base.
            norespRowsRef.current = data as FilaResultado[];
            // Los que de verdad siguen esperando una llamada. `dedupPendientes`
            // son los PENDIENTE CONFIRMACION de esta tienda; lo cancelado en
            // Dropi ya no está acá y por eso deja de contarse.
            pedidosVivosRef.current = new Set(
              dedupPendientes.map(o => o.dbId).filter((id): id is string => !!id));
            const resumen = resumenSinRespuestaHoy(
              data as Parameters<typeof resumenSinRespuestaHoy>[0], todayLocal, Date.now(),
              pedidosVivosRef.current);
            sinRespuestaRef.current = resumen;
            setSinRespuestaHoy(resumen);
            // Mismas filas, tercera poblacion: como va cada asesora hoy.
            // Comparacion por contenido para no re-renderizar la cola entera
            // cuando los numeros no se movieron.
            setResumenAsesorasHoy(prev => {
              const next = computeDailyCounterByOperator(data as Parameters<typeof computeDailyCounterByOperator>[0], todayLocal);
              const igual = prev.length === next.length && prev.every((p, i) =>
                p.operatorId === next[i].operatorId && p.conf === next[i].conf
                && p.canc === next[i].canc && p.noresp === next[i].noresp);
              return igual ? prev : next;
            });
            // Mismas filas, población distinta: lo que gestionó QUIEN ESTÁ MIRANDO.
            // Es lo que firma el cierre de turno y lo que muestra el tablero en
            // modo "Yo"; el de arriba es la tienda entera.
            setMyCounter(prev => {
              const mineRows = (data as ResultRow[]).filter(r => r.operator_id === user.id);
              const next = computeDailyCounter(mineRows, todayLocal);
              return (prev.conf === next.conf && prev.canc === next.canc && prev.noresp === next.noresp)
                ? prev
                : next;
            });
            // Los dos contadores salieron de una lectura buena: a partir de acá
            // un cero es un cero MEDIDO. Ver `counterCargado` en OrderState.
            setCounterCargado(true);
          }
        })
        .catch(() => {
          // Principio de honestidad: antes este error se tragaba mudo y TODOS
          // los conf/canc/noresp del día volvían a verse "Pendiente" en la
          // cola — la operadora re-llamaba clientes ya gestionados sin ningún
          // aviso. No aplicamos overlay parcial (queda el carry-over previo) y
          // avisamos. El próximo poll/evento realtime reintenta solo.
          if (buildId !== lastBuildIdRef.current) return;
          toast.error('No se pudieron cargar los resultados del día — la cola puede mostrar pedidos ya gestionados', {
            id: 'work-queue-results-error', // sonner dedup por id → no se apilan
            duration: 8000,
          });
        });
    }
  }, [user, activeStoreId, dataLoader.setSegData]);

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
    revertedIds.current.delete(order.dbId);

    setWorkQueue(prev => prev.map(o => o.dbId === order.dbId ? { ...o, result, reason } : o));
    setCounter(prev => {
      // noresp NO se incrementa optimísticamente: si la operadora marca
      // "no contestó" 2 veces sobre el mismo pedido (separadas por el
      // cooldown), el +1 ingenuo lo contaba doble. Dejamos que el
      // recompute por realtime (~100ms después del INSERT) lo refleje
      // ya deduplicado por order_id. UX no requiere feedback instantáneo
      // para noresp (no impacta meta).
      const next = {
        conf: prev.conf + (result === 'conf' ? 1 : 0),
        canc: prev.canc + (result === 'canc' ? 1 : 0),
        noresp: prev.noresp,
      };
      const newTotal = next.conf + next.canc + next.noresp;
      setTimeout(() => checkMilestone(newTotal), 300);
      return next;
    });
    // El que marca soy YO: el contador personal se mueve con el mismo delta que
    // el de la tienda (y se revierte en los mismos puntos), si no el cierre de
    // turno quedaría atrás hasta el próximo recompute.
    setMyCounter(prev => ({
      conf: prev.conf + (result === 'conf' ? 1 : 0),
      canc: prev.canc + (result === 'canc' ? 1 : 0),
      noresp: prev.noresp,
    }));
    setLastMark({ order, result, reason });

    // Señal LOCAL de "acabo de gestionar" para el aviso suave de huecos
    // (`useSinGestionNudge`). Va acá, en la acción optimista, no tras el INSERT:
    // el asesor YA hizo el trabajo aunque Dropi/la base tarden o fallen. Es un
    // evento del navegador → instantáneo y sin depender del realtime.
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('guardian:mi-gestion'));

    // M4: setter funcional para evitar stale closure. El `markResult`
    // dentro de useCallback capturaba `timerStart=0` en el primer render;
    // si la operadora marcaba el primer pedido y luego el segundo antes
    // del re-render, el timer se reseteaba.
    setTimerStart(prev => prev || Date.now());

    const today = bogotaToday();
    const now = new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' });

    // Trazabilidad honesta del push: si este resultado va a disparar un push a
    // Dropi (conf/canc con externalId), la fila nace 'pending' y se promueve a
    // 'synced' SOLO cuando Dropi confirma (ver .then de cada invoke abajo).
    // Antes nacía 'synced' hardcodeado ANTES del push — mentía si Dropi fallaba.
    // 'pending' es un valor ya contemplado por dropi-cron (restore failed/pending).
    // Sin push que hacer (noresp, o pedido sin externalId) queda 'synced' directo.
    const willPushToDropi = (result === 'conf' || result === 'canc') && !!order.externalId;

    const { error, data: insertedResult } = await supabase.from('order_results').insert({
      order_id: order.dbId,
      phone: order.phone,
      result,
      reason: reason || '',
      operator_id: user.id,
      result_date: today,
      result_time: now,
      dropi_sync_status: willPushToDropi ? 'pending' : 'synced',
      // CRÍTICO: pasar store_id de la tienda activa. La columna tiene default
      // '00000...001' (CO legacy); sin esto, en tiendas Ecuador (u otras)
      // el INSERT viola la RLS `oresults_ins` (store_id IN auth_store_ids())
      // y la operadora ve "new row violates row-level security policy".
      store_id: activeStoreId,
      // Sin esto, `operator_productivity_stats` no contaba las
      // confirmaciones (filtra por r.module='confirmar') y el panel
      // de admin → Productividad mostraba "Sin actividad en este rango"
      // aunque las operadoras hubieran confirmado pedidos todo el día.
      module: 'confirmar',
    }).select('id').single();

    if (error) {
      // Revertir estado optimista + liberar lock para que la operadora pueda reintentar.
      setWorkQueue(prev => prev.map(o => o.dbId === order.dbId ? { ...o, result: undefined, reason: undefined } : o));
      setCounter(prev => ({
        conf: Math.max(0, prev.conf - (result === 'conf' ? 1 : 0)),
        canc: Math.max(0, prev.canc - (result === 'canc' ? 1 : 0)),
        noresp: prev.noresp,
      }));
      setMyCounter(prev => ({
        conf: Math.max(0, prev.conf - (result === 'conf' ? 1 : 0)),
        canc: Math.max(0, prev.canc - (result === 'canc' ? 1 : 0)),
        noresp: prev.noresp,
      }));
      markingInFlight.current.delete(order.dbId);
      toast.error(`Error guardando resultado: ${error.message}`);
      return;
    }

    if (!error && result === 'conf' && order.dbId) {
      // REG-3: usar RPC confirm_order_locally en vez de UPDATE directo.
      // MED-2: capturar error del RPC. Antes se ignoraba — si la RPC fallaba
      // (no autorizado, network), la operadora veía "Confirmado" pero el
      // pedido seguía como PENDIENTE CONFIRMACION en DB y reaparecía.
      const { data: rpcOk, error: rpcErr } = await (supabase.rpc as unknown as (
        fn: string, args: Record<string, unknown>
      ) => Promise<{ data: boolean | null; error: { message: string } | null }>)(
        'confirm_order_locally', { p_order_id: order.dbId }
      );
      if (rpcErr || rpcOk === false) {
        toast.error('Confirmación local falló: ' + (rpcErr?.message || 'pedido no encontrado'));
        // Revertir estado optimista del workQueue + counter
        setWorkQueue(prev => prev.map(o => o.dbId === order.dbId ? { ...o, result: undefined, reason: undefined } : o));
        setCounter(prev => ({ ...prev, conf: Math.max(0, prev.conf - 1) }));
        setMyCounter(prev => ({ ...prev, conf: Math.max(0, prev.conf - 1) }));
        // CRÍTICO: liberar el lock antes de salir. Sin esto, el dbId queda
        // permanentemente en markingInFlight y la operadora no puede
        // reintentar la confirmación hasta recargar la página.
        markingInFlight.current.delete(order.dbId);
        // #17 data-loss: si otra asesora ya confirmó el pedido, la fila
        // order_results 'conf' que insertamos arriba quedaría huérfana e
        // inflaría productividad/cobertura (y el cron la re-empujaría a Dropi).
        // La borramos. El touchpoint aún NO existe en este punto (se inserta
        // más abajo, tras el bloque conf), así que no hay nada más que limpiar.
        if (insertedResult?.id) {
          await supabase.from('order_results').delete().eq('id', insertedResult.id);
        }
        return;
      }
      setWorkQueue(prev => prev.map(o => o.dbId === order.dbId ? { ...o, estado: 'PENDIENTE' } : o));

      if (order.externalId) {
        const toastId = `dropi-${order.externalId}`;
        const insertedResultId = insertedResult?.id;
        // H9: toast unificado. CallView ya no muestra `toast.success("Confirmado")`
        // para conf — aquí mostramos el flujo entero (loading → ok/error)
        // con el mismo toastId, evitando toasts contradictorios.
        toast.loading(`Confirmando — ${order.nombre.split(' ')[0]}…`, { id: toastId });

        const markDropiFailure = async (errMsg: string, code?: string) => {
          if (revertedIds.current.has(order.dbId!)) return;
          revertedIds.current.add(order.dbId!);
          // BUG A fix: do NOT silently rollback. Keep the local confirmation,
          // mark the order_results row as failed so dropi-cron retries it,
          // and warn the operator with a destructive long-duration toast.
          if (insertedResultId) {
            const { data: upd } = await (supabase.from('order_results') as unknown as {
              update: (v: Record<string, unknown>) => {
                eq: (c: string, v: string) => { select: (c: string) => Promise<{ data: unknown[] | null }> };
              };
            }).update({
              dropi_sync_status: 'failed',
              // code 'pedido_bot' = la edge CONFIRMÓ (PUT + GET de integración)
              // que es un pedido del bot sin superficie API por-id. El prefijo
              // "BOT-SIN-API: " (MISMO string exacto que BOT_NOTES_PREFIX en
              // dropi-cron) lo excluye del retry del cron desde el primer tick
              // (sin quemar los 5 intentos del CAP) y el panel de fallos lo
              // muestra como badge informativo en vez de botón "Reintentar".
              result_notes: (code === 'pedido_bot' ? 'BOT-SIN-API: ' : '') +
                `Dropi sync pendiente - reintentar (${errMsg})`,
            }).eq('id', insertedResultId).select('id');
            // #706: .select detecta el no-op de RLS. Si 0 filas, la marca
            // 'failed' NO quedó — el cron no la reintentaría y la fuga sería silenciosa.
            if (!upd || upd.length === 0) {
              console.warn('[markDropiFailure] 0 filas al marcar failed (RLS sin aplicar?)', { id: insertedResultId });
            }
          }
          // Toast HONESTO. El texto viejo ("Aparecerá en la pestaña Novedades")
          // mentía — nada lee esas filas en Novedades. Los pedidos del bot de
          // Dropi (code 'pedido_bot') no se pueden actualizar por API NUNCA:
          // el retry del cron falla eterno, hay que ir al panel de Dropi.
          const honestMsg = code === 'pedido_bot'
            ? 'Pedido del bot de Dropi: la confirmación quedó en el CRM pero Dropi no permite actualizarlo por API — confirmalo en el panel de Dropi'
            : 'La confirmación quedó en el CRM pero NO llegó a Dropi — el sistema la reintenta solo cada 5 min. Si en una hora sigue fallando, gestionalo en el panel.';
          toast.error(honestMsg, { id: toastId, duration: 10000 });
        };

        // Audit H4: await en .catch para evitar floating promise — si el componente
        // se desmonta entre .catch y el DB write, la marca de "failed" se perdía.
        supabase.functions
          // storeId OBLIGATORIO: desde 20260820140000 el numero de pedido es
          // unico POR TIENDA, asi que dos empresas pueden tener el mismo. Sin
          // esto, la confirmacion podia empujarse al pedido de otro dueno.
          .invoke('dropi-update-order', { body: { externalId: order.externalId, storeId: activeStoreId } })
          .then(async (res) => {
            const data = res?.data as { ok?: boolean; error?: string; code?: string } | null | undefined;
            // Chequeo ESTRICTO: éxito SOLO si la función respondió ok:true.
            // Antes el criterio era `data?.ok === false` — un 200 sin campo
            // `ok` (función vieja, respuesta malformada) se celebraba como
            // confirmado sin haber tocado Dropi.
            if (res?.error || data?.ok !== true) {
              const msg = res?.error?.message || data?.error || 'la función Dropi no confirmó el cambio (respuesta sin ok:true)';
              await markDropiFailure(msg, data?.code);
            } else {
              // Dropi confirmó el push → promover la fila 'pending' a 'synced'
              // para que el retry del cron no la vuelva a tocar.
              if (insertedResultId) {
                const { data: upd } = await (supabase.from('order_results') as unknown as {
                  update: (v: Record<string, unknown>) => {
                    eq: (c: string, v: string) => { select: (c: string) => Promise<{ data: unknown[] | null }> };
                  };
                }).update({ dropi_sync_status: 'synced' }).eq('id', insertedResultId).select('id');
                // #706: 0 filas = la promoción a 'synced' no pegó (RLS) → el cron
                // seguiría reintentando un push ya aplicado. Lo dejamos visible.
                if (!upd || upd.length === 0) {
                  console.warn('[markResult conf] 0 filas al promover a synced (RLS sin aplicar?)', { id: insertedResultId });
                }
              }
              toast.success(`Confirmado — ${order.nombre.split(' ')[0]}`, { id: toastId, duration: 2500 });
            }
          })
          .catch(async (err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            await markDropiFailure(`red — ${msg}`);
          });
      }
    }
    if (!error && result === 'canc' && order.dbId && order.externalId) {
      // FASE 3: cancelar DE VERDAD en Dropi, no solo el overlay local. Antes la
      // cancelación era un order_results que caducaba a 7 días mientras Dropi
      // seguía enviando el pedido PENDIENTE → el cron lo re-importaba (fantasma).
      // Mismo patrón que la confirmación: guardamos local YA (el overlay 'canc'
      // ya lo escondió de la cola), empujamos a Dropi en segundo plano; si Dropi
      // falla, marcamos la fila 'failed' + avisamos, NUNCA en silencio.
      const toastId = `dropi-cancel-${order.externalId}`;
      const insertedResultId = insertedResult?.id;

      // GUARDA ATÓMICA (#9): flipear estado a CANCELADO server-side ANTES del
      // push saca el pedido de la cola de TODAS las asesoras vía realtime (no
      // solo del overlay client-side de ESTA pestaña). SOLO la primera gana
      // (FOUND); si otra ya lo confirmó/canceló, abortamos sin empujar a Dropi
      // ni dejar filas de ruido. Simétrico a confirm_order_locally (rama conf).
      const { data: cancOk, error: cancErr } = await (supabase.rpc as unknown as (
        fn: string, args: Record<string, unknown>
      ) => Promise<{ data: boolean | null; error: { message: string; code?: string } | null }>)(
        'cancel_order_locally', { p_order_id: order.dbId }
      );
      // BLINDAJE (auditoría 2026-07-14): si el RPC NO existe (migración
      // 20260714120000 aún no aplicada — Lovable publica el bundle pero NO
      // auto-aplica migraciones), NO abortamos: seguimos con el push directo
      // como pre-Tanda-D. Sin esto, un desfase de deploy tumbaría TODA
      // cancelación del día (fail-closed). PGRST202 = función inexistente.
      const rpcMissing = !!cancErr && (
        cancErr.code === 'PGRST202' ||
        /could not find the function|does not exist|schema cache/i.test(cancErr.message || '')
      );
      if (!rpcMissing && (cancErr || cancOk === false)) {
        // Otra asesora ya lo gestionó (o error real del RPC): revertir UI +
        // borrar la fila order_results huérfana + liberar el lock in-memory. No
        // se empuja a Dropi (evita el doble-cancel / cancelar-lo-que-otro-confirmó).
        if (insertedResult?.id) await supabase.from('order_results').delete().eq('id', insertedResult.id);
        setWorkQueue(prev => prev.map(o => o.dbId === order.dbId ? { ...o, result: undefined, reason: undefined } : o));
        setCounter(prev => ({ ...prev, canc: Math.max(0, prev.canc - 1) }));
        setMyCounter(prev => ({ ...prev, canc: Math.max(0, prev.canc - 1) }));
        markingInFlight.current.delete(order.dbId);
        toast.error(cancErr ? `Cancelación local falló: ${cancErr.message}` : 'Ese pedido ya fue gestionado por otra asesora', { id: toastId });
        return;
      }
      // Ganó la carrera (flip atómico OK) → reflejar CANCELADO local ya (realtime
      // lo propaga). Si el RPC faltaba (rpcMissing), NO flipeamos acá: lo hará el
      // .then de Dropi OK como pre-Tanda-D (y el push procede igual).
      if (!rpcMissing) {
        setWorkQueue(prev => prev.map(o => o.dbId === order.dbId ? { ...o, estado: 'CANCELADO' } : o));
      }
      toast.loading(`Cancelando en Dropi — ${order.nombre.split(' ')[0]}…`, { id: toastId });

      const markCancelFailure = async (errMsg: string) => {
        if (insertedResultId) {
          const { data: upd } = await (supabase.from('order_results') as unknown as {
            update: (v: Record<string, unknown>) => {
              eq: (c: string, v: string) => { select: (c: string) => Promise<{ data: unknown[] | null }> };
            };
          }).update({
            dropi_sync_status: 'failed',
            result_notes: `Cancelación en Dropi pendiente - reintentar (${errMsg})`,
          }).eq('id', insertedResultId).select('id');
          // #706: 0 filas = la marca 'failed' no pegó (RLS) → el cron no
          // reintentaría la cancelación y el pedido seguiría vivo en Dropi.
          if (!upd || upd.length === 0) {
            console.warn('[markCancelFailure] 0 filas al marcar failed (RLS sin aplicar?)', { id: insertedResultId });
          }
        }
        // Toast HONESTO: la cancelación NO llegó a Dropi y el pedido sigue
        // vivo allá; decirle a la operadora exactamente qué va a pasar.
        toast.error(
          'La cancelación quedó SOLO en el CRM — Dropi la rechazó. El sistema la reintenta cada 5 min; si el pedido sigue vivo en el panel en una hora, cancelalo a mano.',
          { id: toastId, duration: 10000 },
        );
      };

      supabase.functions
        .invoke('dropi-change-carrier', { body: { mode: 'cancel', externalId: order.externalId, storeId: activeStoreId, reason } })
        .then(async (res) => {
          const data = res?.data as { ok?: boolean; canceled?: boolean; dropiMissing?: boolean; error?: string } | null | undefined;
          // Degradación segura: solo es éxito si la función NUEVA confirmó con
          // canceled:true. Si el edge está sin redeployar, mode:'cancel' cae a
          // "quote" y devuelve ok:true SIN cancelar nada → lo tratamos como fallo
          // (mismo criterio que apply_edit/editApplied) para no esconder en falso
          // un pedido que sigue vivo en Dropi.
          if (res?.error || data?.ok === false || data?.canceled !== true) {
            const msg = res?.error?.message || data?.error ||
              (data?.canceled !== true ? 'la función Dropi no confirmó la cancelación (¿falta redeploy?)' : 'Error desconocido');
            await markCancelFailure(msg);
          } else {
            // Dropi confirmó la cancelación → promover la fila 'pending' a
            // 'synced' para que el cron no la trate como push pendiente.
            if (insertedResultId) {
              const { data: upd } = await (supabase.from('order_results') as unknown as {
                update: (v: Record<string, unknown>) => {
                  eq: (c: string, v: string) => { select: (c: string) => Promise<{ data: unknown[] | null }> };
                };
              }).update({ dropi_sync_status: 'synced' }).eq('id', insertedResultId).select('id');
              // #706: 0 filas = la promoción a 'synced' no pegó (RLS) → el cron
              // volvería a intentar cancelar un pedido ya cancelado.
              if (!upd || upd.length === 0) {
                console.warn('[markResult canc] 0 filas al promover a synced (RLS sin aplicar?)', { id: insertedResultId });
              }
            }
            // El edge ya marcó estado='CANCELADO' server-side; reflejarlo local ya.
            setWorkQueue(prev => prev.map(o => o.dbId === order.dbId ? { ...o, estado: 'CANCELADO' } : o));
            const nombre = order.nombre.split(' ')[0];
            // dropiMissing = era un fantasma (ya no estaba en Dropi) → se limpió local.
            toast.success(
              data?.dropiMissing ? `Pedido fantasma limpiado — ${nombre}` : `Cancelado en Dropi — ${nombre}`,
              { id: toastId, duration: 2500 },
            );
          }
        })
        .catch(async (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          await markCancelFailure(`red — ${msg}`);
        });
    }

    // NOTA: el viejo `if (error)` que envolvía este tramo era CÓDIGO MUERTO —
    // cualquier error del insert ya hizo `return` arriba (rama de error del
    // insert de order_results). Además su revert restaba `noresp`, que
    // markResult nunca incrementa optimísticamente. Eliminado.
    if (insertedResult?.id) {
      setLastMark(prev => prev ? { ...prev, resultId: insertedResult.id } : prev);
    }

    const { data: tpData } = await supabase.from('touchpoints').insert({
      phone: order.phone,
      action: result === 'conf' ? 'Confirmado' : result === 'canc' ? `Cancelado: ${reason || ''}` : 'No respondió',
      operator_id: user.id,
      action_date: today,
      action_time: now,
      store_id: activeStoreId,
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
    markingInFlight.current.delete(order.dbId);
  // MED-1: timerStart NO se lee dentro del callback (solo se setea con
  // setter funcional). Tenerlo en deps invalidaba ctxValue cada confirmación
  // y disparaba re-render en cascada en todos los consumers.
  // activeStoreId SÍ va: se usa para el store_id de order_results y del
  // touchpoint. Sin él, tras cambiar de tienda markResult quedaría con el
  // store viejo y escribiría a la tienda equivocada (mezcla CO/EC).
  }, [user, checkMilestone, activeStoreId]);

  const undoLast = useCallback(async () => {
    if (!lastMark || !user) return;
    if (lastMark.order.dbId && revertedIds.current.has(lastMark.order.dbId)) {
      setLastMark(null);
      toast.info('Ya fue revertido por el rollback de Dropi');
      return;
    }
    if (lastMark.order.dbId) revertedIds.current.add(lastMark.order.dbId);
    const { order, result, resultId, touchpointId } = lastMark;

    setWorkQueue(prev => prev.map(o => o.dbId === order.dbId ? { ...o, result: undefined, reason: undefined } : o));
    // `Math.max(0, …)` igual que `myCounter`: sin piso, deshacer la PRIMERA
    // marca del día antes de que aterrice la siembra dejaba el contador del
    // equipo en -1 y la barra de proporción descuadrada.
    setCounter(prev => ({
      conf: Math.max(0, prev.conf - (result === 'conf' ? 1 : 0)),
      canc: Math.max(0, prev.canc - (result === 'canc' ? 1 : 0)),
      noresp: Math.max(0, prev.noresp - (result === 'noresp' ? 1 : 0)),
    }));
    // El pedido deshecho DEJA de estar "tocado hoy": sin esto el toggle "Solo
    // los que nadie llamó" lo seguía escondiendo, así que deshacer lo sacaba
    // de la cola en vez de devolverlo. El realtime no lo arregla solo — solo
    // escucha INSERT, y esto es un DELETE.
    if (order.dbId) {
      setMyConfirmTouchedToday(prev => {
        if (!prev.has(order.dbId!)) return prev;
        const n = new Set(prev); n.delete(order.dbId!); return n;
      });
    }
    // Deshacer es siempre sobre una marca propia (lastMark es de esta sesión).
    setMyCounter(prev => ({
      conf: Math.max(0, prev.conf - (result === 'conf' ? 1 : 0)),
      canc: Math.max(0, prev.canc - (result === 'canc' ? 1 : 0)),
      noresp: Math.max(0, prev.noresp - (result === 'noresp' ? 1 : 0)),
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
    // Y que el contador vuelva a salir de la BASE en vez de quedar con la resta
    // hecha a mano: el realtime de `order_results` solo escucha INSERT, así que
    // un borrado no dispara ningún recálculo y el número quedaba mal hasta el
    // próximo poll (30 min).
    void refreshFnsRef.current.loadWorkQueue();
  }, [lastMark, user]);

  const resetOrders = useCallback(() => {
    setAllOrdersState([]);
    setWorkQueue([]);
    dataLoader.setSegData([]);
    dataLoader.setSegLoaded(false);
    novedades.setNovedadesQueue([]);
    setExcelLoaded(false);
    resetCelebrations();
  }, [resetCelebrations, dataLoader.setSegData, dataLoader.setSegLoaded, novedades.setNovedadesQueue]);

  // Rescate eliminado (2026-05-08): el filtro derivado se removió porque
  // /seguimiento + segLists.ts (8 listas SLA) cubren todos los casos.

  // C5: useMemo del value del Provider. Antes el objeto literal se
  // recreaba en CADA render de OrderProvider, lo que disparaba re-render
  // en TODOS los consumidores de useOrders() — incluso si la única razón
  // del render era un cambio que no les concernía (ej. counter cambia y
  // SeguimientoTab re-renderiza la lista entera).
  const ctxValue = useMemo(() => ({
    allOrders, workQueue,
    segData: dataLoader.segData, segLoaded: dataLoader.segLoaded, segLoading: dataLoader.segLoading, segError: dataLoader.segError,
    segLastUpdate: dataLoader.segLastUpdate, loadSegData: dataLoader.loadSegData,
    novedadesQueue: novedades.novedadesQueue, novedadesLoading: novedades.novedadesLoading,
    novedadesError: novedades.novedadesError,
    counter, myCounter, timerStart,
    loading, excelLoaded, setExcelLoaded, setAllOrders, buildWorkQueue, loadWorkQueue, markResult, undoLast, lastMark, resetOrders,
    loadNovedades: novedades.loadNovedades, resolveNovedad: novedades.resolveNovedad,
    myConfirmTouchedToday, mySegTouchedToday, gestionPorPedido, gestionCargada, gestionSegPorTelefono, ultimaGestionSeg, resumenAsesorasHoy, sinRespuestaHoy,
    coverageError, coverageConfirmError, coverageSegError, counterCargado, colaConfirmarError,
  }), [
    allOrders, workQueue,
    dataLoader.segData, dataLoader.segLoaded, dataLoader.segLoading, dataLoader.segError,
    dataLoader.segLastUpdate, dataLoader.loadSegData,
    novedades.novedadesQueue, novedades.novedadesLoading, novedades.novedadesError,
    counter, myCounter, timerStart,
    loading, excelLoaded, buildWorkQueue, loadWorkQueue, markResult, undoLast, lastMark, resetOrders,
    novedades.loadNovedades, novedades.resolveNovedad,
    myConfirmTouchedToday, mySegTouchedToday, gestionPorPedido, gestionCargada, gestionSegPorTelefono, ultimaGestionSeg, resumenAsesorasHoy, sinRespuestaHoy,
    coverageError, coverageConfirmError, coverageSegError, counterCargado, colaConfirmarError,
  ]);

  return (
    <OrderContext.Provider value={ctxValue}>
      {children}
    </OrderContext.Provider>
  );
}

export function useOrders() {
  const ctx = useContext(OrderContext);
  if (!ctx) throw new Error('useOrders must be inside OrderProvider');
  return ctx;
}

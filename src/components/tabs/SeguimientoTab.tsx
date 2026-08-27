import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useOrders } from '@/contexts/OrderContext';
import { useStore } from '@/contexts/StoreContext';
import { useAuth } from '@/contexts/AuthContext';
import { useChangeAlerts } from '@/hooks/useChangeAlerts';
import { OrderData, isWithinLastDays, isClosedOutByCloser } from '@/lib/orderUtils';
import { matchesQuery } from '@/lib/textSearch';
import { useSessionState } from '@/hooks/useSessionState';
import { useSegAsignaciones } from '@/hooks/useSegAsignaciones';
import { turnoDelEquipo } from '@/lib/turnoDelEquipo';
import TurnoDelEquipoPanel from '@/components/seguimiento/TurnoDelEquipoPanel';
import CierreSeguimientoDialog from '@/components/seguimiento/CierreSeguimientoDialog';
import { useSegTouchIndex } from '@/hooks/useSegTouchIndex';
import { useRiesgoChat } from '@/hooks/useRiesgoChat';
import { estadoConversacion } from '@/lib/actividadChat';
import { useRefreshVisibleOrders } from '@/hooks/useRefreshVisibleOrders';
import { Truck, RefreshCw, Cloud, Package, AlertTriangle, MapPin, RotateCcw, Tag, DollarSign, CheckCircle, Layers, CalendarIcon, X, ChevronRight, ChevronDown, Filter, ExternalLink, LayoutGrid, List, Search, User as UserIcon, Users, Moon } from 'lucide-react';
import { toast } from 'sonner';
import { motion } from 'framer-motion';
import CrmTable from '@/components/CrmTable';
import { TiltCard, CountUp, GaugeRing } from '@/components/ui3d';
import SegBoard from '@/components/seguimiento/SegBoard';
import { estaGestionadoHoy, contarGestionadosHoy, estaDetenido, asesorasEnSeguimientoHoy, horasSinMovimiento, HORAS_DETENIDO } from '@/lib/segPulso';
import { useOperatorNames } from '@/hooks/useOperatorNames';
import SegCounterBar from '@/components/SegCounterBar';
import GlobalOrderSearchPanel from '@/components/seguimiento/GlobalOrderSearchPanel';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import {
  SEG_LISTS,
  type SegListSlug,
  findSegList,
  isValidSegListSlug,
  seMuestraComoChip,
  esAccionable,
} from '@/lib/segLists';
import { classifySegEstado } from '@/lib/segStatus';
import { findSupersededInSeg } from '@/lib/duplicateOrders';

// Ventana por defecto de Seguimiento: ÚLTIMOS 45 DÍAS (calendario), rodante.
// Antes el default era el 1° del mes en curso y, al pasar de mes, los pedidos
// del mes anterior que SEGUÍAN en ruta se "quedaban atrás" (desaparecían de la
// vista hasta poner un rango manual). Una ventana rodante de 45 días arrastra el
// mes previo. Aplica a CO y EC por igual (decisión del dueño, 2026-06-26).
// OJO: esto solo OCULTA en la vista de operadora — la data sigue intacta en la
// DB para Logística/Finanzas, y se ve completa poniendo un rango de fechas
// explícito (los pickers "Desde/Hasta").
const DEFAULT_WINDOW_DAYS = 45;

// Punto de color por urgencia para los chips de listas SLA (mapea SegListDef.tone).
const LIST_TONE_DOT: Record<string, string> = {
  danger: 'bg-danger glow-danger',
  warning: 'bg-warning glow-warning',
  success: 'bg-success glow-success',
  info: 'bg-info glow-info',
  neutral: 'bg-muted-foreground/50',
};

/**
 * Tinte COMPLETO del chip por urgencia de la lista SLA. Antes las 8 listas se
 * dibujaban todas iguales (bg-card/40 + un punto de 1.5px) y "En oficina
 * (cliente recoge)" pesaba lo mismo que "Otros estados": el orden de prioridad
 * que documenta segLists.ts quedaba aplanado por el diseño. Ahora el chip
 * entero lleva el tono, con la fórmula invariable del lenguaje (fondo /10,
 * borde /30, texto pleno) y el conteo con el tratamiento de cifra del
 * Dashboard. `numGlow` solo existe para accent/success/danger en index.css —
 * las demás van sin glow en vez de inventar un token.
 */
const LIST_TONE_CHIP: Record<string, { idle: string; count: string; numGlow: string }> = {
  danger: {
    idle: 'bg-danger/10 border-danger/30 text-danger hover:border-danger/60 hover:bg-danger/16',
    count: 'text-danger',
    numGlow: 'num-glow-danger',
  },
  warning: {
    idle: 'bg-warning/10 border-warning/30 text-warning hover:border-warning/60 hover:bg-warning/16',
    count: 'text-warning',
    numGlow: '',
  },
  success: {
    idle: 'bg-success/10 border-success/30 text-success hover:border-success/60 hover:bg-success/16',
    count: 'text-success',
    numGlow: 'num-glow-success',
  },
  info: {
    idle: 'bg-info/10 border-info/30 text-info hover:border-info/60 hover:bg-info/16',
    count: 'text-info',
    numGlow: '',
  },
  neutral: {
    idle: 'bg-card/40 border-border text-muted-foreground hover:text-foreground hover:border-border-strong',
    count: 'text-foreground',
    numGlow: '',
  },
};

// Cascada de entrada del Dashboard: los bloques se arman de arriba abajo.
const fadeUp = (delay = 0) => ({
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35, delay, ease: 'easeOut' as const },
});

export default function SeguimientoTab() {
  const navigate = useNavigate();
  // Cached in OrderContext so the data survives route unmounts when the
  // operator navigates between CRM tabs. Without the cache they'd see
  // "Cargando seguimiento..." and lose all filter/selection state every
  // time they switched tabs.
  // `coverageSegError`: la lectura de "gestionados hoy" (touchpoints SEG:%)
  // FALLÓ → mySegTouchedToday viene vacío pero NO significa "cero gestionados".
  // Ver el contrato en OrderContext: flag true = dato AUSENTE, mostrar "—" en
  // tono neutro, nunca un 0 que parezca medido.
  const { segData, segLoaded, segLoading, segLastUpdate, loadSegData, mySegTouchedToday, gestionSegPorTelefono, coverageSegError } = useOrders();
  // El cutoff de "muertos" depende del país de la tienda activa (EC cicla más
  // lento que CO). Patrón de CrmCallView: leer activeStore?.country_code.
  const { activeStore, activeStoreId, isManagerOfActive } = useStore();
  // Nombre de cada asesora para la tarjeta "el equipo hoy" (cache compartido:
  // una sola lectura de profiles por sesión, no una por tarjeta).
  const { nameOf: nombreDeAsesora } = useOperatorNames();
  const { refreshNow, isRefreshing: isSyncingDropi } = useRefreshVisibleOrders();
  // Pedidos que el equipo ya CERRÓ (Resuelto/Devolución) → salen para siempre de
  // Seguimiento. Team-wide (set de phones de la tienda activa). Ver hook.
  const { closed: segClosedPhones, avisosAgencia } = useSegTouchIndex(activeStoreId);
  // Alerta de cambios (auditoría 14-ago-2026, artifact fa210631): el hook
  // existía COMPLETO desde F6 y nadie lo montaba — el aviso "N devoluciones
  // nuevas" era código muerto mientras el dueño reportaba "a veces no me
  // entero de las devoluciones". Vive acá porque /rescate (su tab original) se
  // eliminó y el trabajo de devoluciones/oficina hoy se hace en Seguimiento.
  // El banner dice lo que ENTRÓ desde la última vez que lo diste por visto; la
  // X marca visto (sin eso reaparecería en el próximo poll de 10 min).
  const { user } = useAuth();
  const { banner: alertaCambios, markSeen: marcarVisto, dismissBanner } = useChangeAlerts(user?.id, activeStoreId);
  const descartarAlerta = useCallback(() => {
    marcarVisto('seguimiento');
    marcarVisto('rescate');
    dismissBanner();
  }, [marcarVisto, dismissBanner]);

  // Filter state persisted to sessionStorage so it also survives tab
  // discards (Chrome Memory Saver) and internal route navigation.
  // Sin rango explícito por defecto (cadenas vacías) → aplica la ventana rodante
  // de 45 días (ver actionableData). Keys bumpeadas a :v2 para que los valores
  // viejos ("1° del mes") guardados en sessionStorage NO le ganen al nuevo
  // default (si no, la operadora seguiría con el bug del cambio de mes).
  const [dateFrom, setDateFrom] = useSessionState<string>('seg:dateFrom:v2', '');
  const [dateTo, setDateTo] = useSessionState<string>('seg:dateTo:v2', '');
  // Resumen por estado (las 14 tarjetas) colapsado por defecto. La forma
  // principal de priorizar pasó a ser las listas SLA (chips arriba); estas
  // tarjetas quedan como vista secundaria opcional.
  // (Se eliminó `showStatusSummary`: era el desplegable "Ver resumen por
  // estado". En Tablero repetía las columnas y en Lista el filtro pasó a ser
  // una fila de chips siempre visible, así que ya no hay nada que colapsar.)
  // Owns the status filter so the stat cards act as the single source of truth
  // (no duplicate pill row below).
  const [statusFilter, setStatusFilter] = useSessionState<string | null>('seg:statusFilter', null);
  // El hero (4 tarjetas + aro + notas) arranca PLEGADO detrás de una línea de
  // resumen. Se construyó bien y no se borra: solo deja de ser lo primero que
  // tapa la pantalla. El dueño reportó "mucho ruido visual", y con la barra
  // "Lo que sigue" arriba de todo, el hero pasó a ser el segundo lugar donde
  // se dice lo mismo.
  const [heroAbierto, setHeroAbierto] = useSessionState<boolean>('seg:heroAbierto', false);
  // Cierre del día. Estado local y NO de sesión: no es una preferencia, es un
  // diálogo que se abre una vez.
  const [cierreAbierto, setCierreAbierto] = useState(false);
  // Contador diario: por defecto OCULTAMOS del tablero los pedidos que YO ya
  // gestioné hoy (touchpoint SEG:* → mySegTouchedToday, set de phones del
  // OrderContext). Al gestionar un pedido (Contactado/Llamé/WhatsApp/… desde la
  // ficha o la lista) desaparece del tablero y "Te faltan N" baja, igual que la
  // cola de Confirmar. Key :v2 para activar el nuevo default aunque hubiera un
  // `false` viejo guardado. La LISTA (CrmTable) ya tiene su propio ocultado de
  // gestionados, por eso este filtro aplica al TABLERO.
  const [onlyUntouchedSeg, setOnlyUntouchedSeg] = useSessionState<boolean>('seg:autoHide:v2', true);
  // Asignación del día (pieza C). Es una ETIQUETA de responsabilidad, no un
  // candado: filtra la vista, nunca bloquea a nadie.
  const asig = useSegAsignaciones();
  const [soloMias, setSoloMias] = useSessionState<boolean>('seg:soloMias', false);

  // Cuántos filtros están puestos. Va en el botón "Filtros" porque ahora están
  // PLEGADOS: un filtro escondido que no se anuncia es peor que uno desplegado
  // — la asesora concluye "no hay pedidos" cuando en realidad los está filtrando.
  const filtrosActivos =
    (dateFrom ? 1 : 0) + (dateTo ? 1 : 0) + (statusFilter ? 1 : 0);
  // Vista: tablero Kommo (default, tarjetas en vivo por columna) o lista (CrmTable
  // clásico con búsqueda/owner/llamada). El tablero no quita features: es un toggle.
  const [viewMode, setViewMode] = useSessionState<'board' | 'list'>('seg:viewMode', 'board');
  // Buscador libre (nombre/teléfono/ciudad/guía/producto). Transitorio (no
  // persiste) para que no quede un filtro pegado entre sesiones.
  const [search, setSearch] = useState('');

  // Listas SLA estilo Boostec — selector de listas pre-clasificadas. La URL
  // y la sessionStorage se mantienen sincronizadas: ?lista=<slug> permite
  // deep-link, sessionStorage sobrevive remounts/discards.
  const [searchParams, setSearchParams] = useSearchParams();
  const urlLista = searchParams.get('lista');
  const [listaSlug, setListaSlugInternal] = useSessionState<SegListSlug | null>(
    'seg:listaSlug',
    isValidSegListSlug(urlLista) ? urlLista : null,
  );
  // Sync URL → state al montar (deep-link) y state → URL al cambiar
  useEffect(() => {
    if (isValidSegListSlug(urlLista) && urlLista !== listaSlug) {
      setListaSlugInternal(urlLista);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlLista]);
  const setListaSlug = (slug: SegListSlug | null) => {
    setListaSlugInternal(slug);
    const next = new URLSearchParams(searchParams);
    if (slug) next.set('lista', slug);
    else next.delete('lista');
    setSearchParams(next, { replace: true });
  };

  useEffect(() => { loadSegData(); }, [loadSegData]);

  // Pedidos accionables: por defecto mostramos los ÚLTIMOS 45 DÍAS (ventana
  // rodante por fecha del pedido) → al pasar de mes, los pedidos del mes anterior
  // que siguen en ruta NO se quedan atrás. Si el operador pone un rango de fechas
  // explícito, está explorando el histórico → mostramos todo lo de ese rango.
  // No se borra nada: la data vieja sigue en la DB para Logística/Finanzas.
  // `windowNowMs` es estable por carga de datos (no por render) para que la
  // ventana no "tiemble" en cada push de realtime, pero avance al entrar datos
  // nuevos (cada refresh de segData recomputa el corte).
  // `segData` en deps a propósito: queremos recomputar el corte cuando ENTRAN
  // datos nuevos (cada refresh), no que Date.now() lo haga en cada render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const windowNowMs = useMemo(() => Date.now(), [segData]);
  const actionableData = useMemo(() => {
    if (dateFrom || dateTo) return segData;
    return segData.filter(o => isWithinLastDays(o.fecha, DEFAULT_WINDOW_DAYS, windowNowMs));
  }, [segData, dateFrom, dateTo, windowNowMs]);

  // Cuántos pedidos viejos se ocultaron (solo en la vista por defecto), para
  // mostrar una nota sutil — transparencia: no desaparecen en silencio.
  const hiddenStaleCount = (!dateFrom && !dateTo) ? segData.length - actionableData.length : 0;

  // Filter by date range
  const filteredByDate = useMemo(() => {
    if (!dateFrom && !dateTo) return actionableData;
    return actionableData.filter(o => {
      const d = o.fecha?.trim();
      if (!d) return false;
      // Try to parse the date string to YYYY-MM-DD for comparison
      let dateStr = '';
      // Handle DD/MM/YYYY format
      const parts = d.split('/');
      if (parts.length === 3) {
        dateStr = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
      } else {
        // Try ISO or YYYY-MM-DD
        dateStr = d.slice(0, 10);
      }
      if (dateFrom && dateStr < dateFrom) return false;
      if (dateTo && dateStr > dateTo) return false;
      return true;
    });
  }, [actionableData, dateFrom, dateTo]);

  // Dedup de órdenes reemplazadas por Dropi (caso EC 2026-05-23: 5524001 →
  // 5529961, mismo cliente + mismo producto). Cuando Dropi edita un pedido
  // crea uno nuevo con `external_id` mayor; el viejo queda como PENDIENTE
  // stale en el DB hasta que el sync llegue al estado terminal. `findSuper-
  // sededInSeg` mira pares phone+producto contemporáneos y oculta el de id
  // menor. Aplicamos ANTES de filteredByList/stats para que el dedup se
  // refleje en TODO (Kanban, resumen por estado, listas SLA, total).
  const supersededIds = useMemo(
    () => findSupersededInSeg(filteredByDate),
    [filteredByDate],
  );
  const dedupedByDate = useMemo(
    () => {
      const deduped = supersededIds.size === 0
        ? filteredByDate
        : filteredByDate.filter((o) => !supersededIds.has(String(o.externalId ?? '')));
      // Saca PERMANENTEMENTE los pedidos que el equipo ya cerró (Resuelto/
      // Devolución): "si ya se entregó o se devolvió, no vuelve a salir". El panel
      // solo debe tener pedidos accionables → menos contaminación para las
      // operadoras. Team-wide; el cruce por fecha (isClosedOutByCloser) evita
      // esconder un pedido NUEVO de un cliente que ya tuvo un cierre viejo.
      return deduped.filter(
        (o) => !isClosedOutByCloser(o.fecha, o.phone ? segClosedPhones.get(o.phone) : undefined, o.estado),
      );
    },
    [filteredByDate, supersededIds, segClosedPhones],
  );
  const hiddenSupersededCount = supersededIds.size;
  const hiddenClosedCount = useMemo(
    () => filteredByDate.filter(o =>
      !supersededIds.has(String(o.externalId ?? '')) &&
      isClosedOutByCloser(o.fecha, o.phone ? segClosedPhones.get(o.phone) : undefined, o.estado),
    ).length,
    [filteredByDate, supersededIds, segClosedPhones],
  );

  // Lista SLA filter — se aplica DESPUÉS del filtro de fecha y del dedup. Si
  // la lista seleccionada tiene externalRoute (ej. /confirmar), no filtramos
  // acá: mostramos un banner-link en lugar de la tabla.
  const listaActiva = listaSlug ? findSegList(listaSlug) : undefined;
  const filteredByList = useMemo(() => {
    if (!listaActiva || listaActiva.externalRoute) return dedupedByDate;
    return dedupedByDate.filter((o) => listaActiva.matches(o));
  }, [dedupedByDate, listaActiva]);

  // Auto-sync suave contra Dropi al entrar a Seguimiento. El throttle de 4 min
  // vive en el hook (una sola query de lista con backoff), así no satura el
  // rate-limit de Dropi. El botón "Sincronizar Dropi" fuerza una corrida.
  useEffect(() => {
    if (!activeStoreId) return;
    const t = setTimeout(() => { void refreshNow(activeStoreId, { silent: true }); }, 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStoreId]);

  // Feed base que ve la LISTA (CrmTable): lista SLA activa (o el total
  // deduplicado). CrmTable ya oculta los gestionados con su propia lógica
  // (results + snooze 30d de cierres), así que NO lo pre-filtramos acá.
  const displayData = useMemo(() => {
    const base = listaActiva && !listaActiva.externalRoute ? filteredByList : dedupedByDate;
    if (!search.trim()) return base;
    // Filtra tablero Y lista (ambos derivan de displayData). El contador diario
    // usa su propio feedBase sin buscador → "Te faltan N" no se altera al buscar.
    return base.filter(o => matchesQuery([o.nombre, o.phone, o.ciudad, o.guia, o.producto, o.externalId], search));
  }, [listaActiva, filteredByList, dedupedByDate, search]);

  // Feed del TABLERO: contador diario. Oculta los pedidos que YO ya gestioné hoy
  // (mySegTouchedToday). El tablero no tiene la lógica de ocultado de CrmTable,
  // así que la aplicamos acá → al gestionar, la tarjeta desaparece y "Te faltan
  // N" baja. El toggle "Ocultar gestionados" del contador lo controla.
  // "Solo las mías": filtra por la asignación del día. Se aplica ANTES del
  // ocultado de gestionados para que "Te faltan N" hable de MI cola.
  const displayDataMias = useMemo(
    () => (soloMias ? displayData.filter((o) => asig.esMio(o.dbId)) : displayData),
    [displayData, soloMias, asig],
  );

  // Cuántos me tocaron hoy — el chip solo aparece si hay alguno mío.
  const misAsignadosHoy = useMemo(
    () => dedupedByDate.reduce((n, o) => (asig.esMio(o.dbId) ? n + 1 : n), 0),
    [dedupedByDate, asig],
  );

  // Reparto de la cola del día. Vive acá (y no dentro del panel) porque el
  // ORDEN importa: se manda la cola accionable ordenada por urgencia, para que
  // cada asesora reciba una mezcla parecida en vez de que una cargue con todo
  // lo que vence hoy. El panel es presentacional y no conoce los pedidos.
  const repartirColaDeHoy = useCallback(async () => {
    const ids = dedupedByDate
      .filter((o) => esAccionable(o) && o.dbId)
      .sort((a, b) => (horasSinMovimiento(b) ?? 0) - (horasSinMovimiento(a) ?? 0))
      .map((o) => String(o.dbId));
    const r = await asig.repartir(ids);
    if (!r) { toast.error('No se pudo repartir la cola'); return; }
    if (r.sinOperadores) {
      toast.error('No hay asesoras en esta tienda', {
        description: 'Agregá operadoras en Admin → Equipo para poder repartir.',
      });
      return;
    }
    if (r.asignados === 0) {
      toast.success('Ya estaba todo repartido', {
        description: 'Ningún pedido quedó sin dueño. Volver a repartir no le quita el trabajo a nadie.',
      });
      return;
    }
    toast.success(`${r.asignados} pedido${r.asignados === 1 ? '' : 's'} repartido${r.asignados === 1 ? '' : 's'}`, {
      description: `Entre ${asig.operadores.length} asesora${asig.operadores.length === 1 ? '' : 's'}.`
        + (r.ignorados > 0 ? ` ${r.ignorados} ya tenían dueño.` : ''),
    });
  }, [dedupedByDate, asig]);

  // Vista de dueño (pieza D). Se calcula sobre la COLA ACCIONABLE, la misma
  // población que el hero y que el guard de inactividad — si midiera otra cosa,
  // el dueño y su equipo estarían mirando números distintos del mismo día.
  const resumenTurno = useMemo(
    () => turnoDelEquipo({
      accionables: dedupedByDate.filter(esAccionable),
      asignaciones: asig.asignaciones,
      gestionEquipo: gestionSegPorTelefono,
      // Lo que registré yo cuenta igual que lo del equipo — es la MISMA
      // definición de "gestionado" que usa el hero de arriba y el filtro
      // "Ocultar gestionados". Sin esto, el panel contaba distinto que el hero
      // y la misma pantalla mostraba "9 de 32" y "21 de 32" a la vez.
      mios: mySegTouchedToday,
      operadores: asig.operadores,
      // `coverageSegError` = la lectura de gestiones del día falló. Sin esto,
      // "0 tocados" se leería como "no trabajaron" y el dueño reclamaría por un
      // dato que nunca se pudo leer.
      gestionCargada: !coverageSegError,
    }),
    [dedupedByDate, asig.asignaciones, asig.operadores, gestionSegPorTelefono, mySegTouchedToday, coverageSegError],
  );

  const boardData = useMemo(() => {
    const displayData = displayDataMias;
    if (!onlyUntouchedSeg) return displayData;
    // Si la lectura de "gestionados hoy" falló, el set viene vacío y filtrar
    // con él fingiría que nada se gestionó (los pedidos YA gestionados
    // reaparecerían como pendientes "medidos"). Se muestra todo explícitamente
    // y el hero avisa que no se pudo leer — la operadora sabe que puede estar
    // viendo pedidos que ya tocó, en vez de creer que el sistema los midió.
    if (coverageSegError) return displayData;
    // Esconde lo que gestionó CUALQUIERA, no solo yo. Antes miraba nada más
    // `mySegTouchedToday` mientras la tarjeta YA se pintaba como gestionada si
    // la trabajó una compañera: con "Ocultar gestionados" activo quedaba un
    // montón de tarjetas verdes a la vista que el interruptor prometía
    // esconder. El filtro tiene que usar la misma regla que la tarjeta.
    // Del equipo solo esconde lo que fue CONTACTO REAL. Un "No contesto" de una
    // companera deja la tarjeta a la vista: el pedido sigue necesitando trabajo
    // y esconderlo lo volvia invisible para todas hasta el dia siguiente.
    // Lo mio se sigue escondiendo igual que antes (ya lo trabaje).
    return displayData.filter((o) => !estaGestionadoHoy(o.phone, mySegTouchedToday, gestionSegPorTelefono));
  }, [displayDataMias, onlyUntouchedSeg, mySegTouchedToday, gestionSegPorTelefono, coverageSegError]);

  // ¿El tablero quedó vacío SOLO porque ocultamos los gestionados de hoy? (hay
  // pedidos en el feed pero todos están gestionados). Para mostrar un vacío
  // celebratorio en vez de "Sin pedidos".
  const allManagedToday = onlyUntouchedSeg && boardData.length === 0 && displayDataMias.length > 0;

  // Actividad de chat VERIFICADA contra ImporChat (la escribe importchat-sync
  // en orders.chat_saliente_at). Alimenta el chip "WhatsApp real: …" de las
  // tarjetas en Oficina — la respuesta a "me dicen que ya les escribieron,
  // ¿cómo verifico eso?" (dueño, 24-ago-2026). Va por query aparte (no por
  // ORDER_COLUMNS) para que una migración sin aplicar jamás tumbe la pantalla.
  const { activeStoreId: storeIdChat } = useStore();
  const boardIds = useMemo(
    () => boardData.map((o) => o.dbId).filter(Boolean) as string[],
    [boardData],
  );
  const { actividad: chatActividad } = useRiesgoChat(storeIdChat, boardIds);

  // Clientes con la MANO LEVANTADA: escribieron por WhatsApp y el último
  // mensaje del chat sigue siendo suyo — nadie les respondió. Es la señal más
  // accionable que trajo ImporChat y no vivía en ninguna pantalla.
  const esperandoRespuesta = useMemo(() => {
    const s = new Set<string>();
    for (const o of boardData) {
      if (!o.dbId) continue;
      if (estadoConversacion(chatActividad.get(String(o.dbId))) === 'espera_respuesta') s.add(String(o.dbId));
    }
    return s;
  }, [boardData, chatActividad]);
  const [soloEsperando, setSoloEsperando] = useSessionState<boolean>('seg:soloEsperando', false);
  // El filtro se aplica al DIBUJO, no a `boardData`: los ids que alimentan la
  // consulta de actividad salen de la lista completa, así que encender el
  // filtro no puede vaciar su propia fuente de datos.
  const boardDataMostrado = useMemo(
    () => (soloEsperando ? boardData.filter((o) => o.dbId && esperandoRespuesta.has(String(o.dbId))) : boardData),
    [boardData, soloEsperando, esperandoRespuesta],
  );

  const stats = useMemo(() => {
    const s = {
      procesamiento: 0, guia: 0, bodega_trans: 0, transito: 0, reparto: 0,
      novedad: 0, novedad_sol: 0, oficina: 0, rechazado: 0,
      devolucion_transito: 0, devolucion: 0, indemnizada: 0,
      entregado: 0, cancelado: 0, otros: 0,
      total: dedupedByDate.length,
    };
    // Los estados que el clasificador NO mapea, contados uno por uno con su
    // nombre real. Antes se sumaban todos a `otros` y ni siquiera había tarjeta
    // para ese bucket: los pedidos desaparecían del resumen y las tarjetas no
    // sumaban el total, sin ninguna explicación en pantalla.
    const sinMapear = new Map<string, number>();
    dedupedByDate.forEach(o => {
      // classifySegEstado vive en src/lib/segStatus.ts — mismo clasificador
      // que CrmTable (sin esto, el resumen perdía estados EC y mostraba 3 cards
      // mientras el Kanban abajo mostraba 5+ columnas reales).
      const cat = classifySegEstado(o.estado);
      if (cat in s) (s as Record<string, number>)[cat]++;
      if (cat === 'otros') {
        const etiqueta = (o.estado || '').trim() || 'Sin estado en Dropi';
        sinMapear.set(etiqueta, (sinMapear.get(etiqueta) ?? 0) + 1);
      }
    });
    return { ...s, sinMapear: Array.from(sinMapear.entries()).sort((a, b) => b[1] - a[1]) };
  }, [dedupedByDate]);

  // Chips en SINCRONÍA con la tabla: en vista Lista, CrmTable bufferiza los
  // cambios de realtime detrás del banner "N cambios — clic para actualizar",
  // pero los chips seguían la DB en vivo → el chip decía 10 mientras la tabla
  // mostraba 12 filas (auditoría 2026-07-07). CrmTable avisa vía onDataApplied
  // cada vez que APLICA data (carga inicial / cambio de vista / clic en el
  // banner) y acá capturamos el snapshot base de ese momento para los chips.
  // En vista Tablero (viva) los chips siguen la data en vivo, como siempre.
  const dedupedRef = useRef(dedupedByDate);
  dedupedRef.current = dedupedByDate;
  const [chipsBaseFrozen, setChipsBaseFrozen] = useState<OrderData[] | null>(null);
  const handleListDataApplied = useCallback(() => {
    setChipsBaseFrozen(dedupedRef.current);
  }, []);
  const chipsBase = viewMode === 'list' && chipsBaseFrozen ? chipsBaseFrozen : dedupedByDate;

  // Conteo por lista SLA (sobre los pedidos ya filtrados por fecha + deduped).
  // Alimenta los chips de listas — la forma principal de priorizar. Las
  // listas con externalRoute (ej. confirmación) no se cuentan acá: viven en
  // otra ruta.
  const listCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const l of SEG_LISTS) {
      counts[l.slug] = l.externalRoute ? 0 : chipsBase.filter(l.matches).length;
    }
    return counts;
  }, [chipsBase]);

  // "Sugerido": la lista NO-vacía de mayor urgencia (danger > warning > resto),
  // desempatando por el orden de SEG_LISTS (ya priorizado). Guía hacia dónde
  // empezar sin auto-filtrar.
  const suggestedSlug = useMemo<SegListSlug | null>(() => {
    const toneRank: Record<string, number> = { danger: 3, warning: 2, info: 1, success: 0, neutral: 0 };
    let best: { slug: SegListSlug; rank: number } | null = null;
    SEG_LISTS.forEach((l, i) => {
      if (l.externalRoute || (listCounts[l.slug] ?? 0) === 0) return;
      // -i para que, a igual tono, gane el de menor índice (más prioritario).
      const rank = (toneRank[l.tone] ?? 0) * 1000 - i;
      if (!best || rank > best.rank) best = { slug: l.slug, rank };
    });
    return best?.slug ?? null;
  }, [listCounts]);

  // HERO memoizado (auditoría 14-ago-2026, A3): estas cuentas recorren miles
  // de filas y vivían inline en el JSX — cada tecla del buscador las
  // recalculaba enteras aunque el hero ni mira `search`. Solo se rehacen
  // cuando cambia la data, la vista o la lista activa.
  const hero = useMemo(() => {
    // En vista Lista, el contador usa el snapshot congelado (chipsBase) para
    // no contradecir a la tabla bufferizada; en Tablero, la data en vivo.
    const counterSource = viewMode === 'list' ? chipsBase : dedupedByDate;
    // COLA DE HOY (14-ago-2026): sin lista activa, el día NO se mide contra
    // todo lo cargado — "150 por gestionar" con 120 viajando era una meta
    // imposible y la operadora la ignoraba. Se exige en 0 lo ACCIONABLE
    // (detenidos, agencia vencida, reparto/novedad, indemnizaciones, sin
    // guía): la MISMA población que el guard de inactividad ya considera
    // trabajo. El resto es monitoreo.
    const feedBase = listaActiva && !listaActiva.externalRoute
      ? counterSource.filter((o) => listaActiva.matches(o))
      : counterSource.filter(esAccionable);
    // "En ruta" = lo que sigue VIVO camino al cliente. Las devoluciones ahora
    // SÍ se cargan (auditoría 14-ago) pero no van en ruta hacia nadie: tienen
    // su chip "Se fue a devolución" — no engordan esta cifra.
    const enRuta = counterSource.filter((o) => {
      const f = classifySegEstado(o.estado || '');
      return f !== 'devolucion' && f !== 'devolucion_transito' && f !== 'indemnizada';
    }).length;
    const total = feedBase.length;
    // Gestionados por el EQUIPO, no solo por mí (arreglo 1-ago-2026). Sale de
    // `estaGestionadoHoy`, la MISMA función del filtro "Ocultar gestionados":
    // dos definiciones de "gestionado" en la misma pantalla fue justamente lo
    // que causó el bug del contador clavado en 222.
    const gestionados = contarGestionadosHoy(feedBase, mySegTouchedToday, gestionSegPorTelefono);
    const faltan = Math.max(0, total - gestionados);
    // Detenidos y asesoras se miden sobre feedBase —la misma población del
    // hero— y no sobre todo lo cargado: las tarjetas son vecinas y con
    // alcances distintos se leían como la misma métrica que "no cuadraba".
    const detenidos = feedBase.filter((o) => estaDetenido(o)).length;
    const asesorasHoy = asesorasEnSeguimientoHoy(feedBase, gestionSegPorTelefono);
    // Cola vacía = día cumplido: el aro se pinta lleno, no en 0%.
    // floor y no round: con 199 de 200 gestionados, round pintaba el aro LLENO
    // ("100%") con un pedido todavía por gestionar — la misma mentira del
    // pctConcluido de logística (fix 23-ago). El 100 solo llega en cero real.
    const pct = total > 0 ? Math.floor((gestionados / total) * 100) : 100;
    // LO QUE FIRMA EL CIERRE se calcula SIEMPRE sobre lo accionable, con o sin
    // lista SLA activa. El contrato del diálogo es "cola accionable de hoy",
    // pero total/gestionados cambian de población cuando hay una lista activa
    // (que además queda pegada en sessionStorage y en la URL): una asesora con
    // "Detenidos" en 0 y 15 accionables reales en otras listas firmaba un
    // cierre "en cero" sin motivo, y el correo del dueño decía que el día
    // quedó limpio. El hero puede mostrar la lista activa; el cierre no.
    const accionables = counterSource.filter(esAccionable);
    const colaCierre = accionables.length;
    const gestionadosCierre = contarGestionadosHoy(accionables, mySegTouchedToday, gestionSegPorTelefono);
    // El hero vive mientras haya pedidos cargados: una cola de hoy en 0 con
    // 150 en ruta es un LOGRO que se muestra en verde, no una pantalla vacía.
    return {
      enRuta, total, gestionados, faltan, detenidos, asesorasHoy, pct,
      colaCierre, gestionadosCierre, heroVisible: counterSource.length > 0,
    };
  }, [viewMode, chipsBase, dedupedByDate, listaActiva, mySegTouchedToday, gestionSegPorTelefono]);

  /**
   * Unified stat tone system — same 5 tones as CrmTable so the app reads as one
   * palette. Amber is reserved for the hot path ("En Reparto"); semantic tones
   * only apply where they carry real meaning (success/warning/danger).
   */
  type StatTone = 'neutral' | 'accent' | 'warning' | 'danger' | 'success' | 'muted';
  // (El mapa de tonos STAT_TONE se elimino el 1-ago-2026 junto con las 14
  // tarjetas del resumen por estado: ~60 lineas de estilos de un componente
  // que ya no existe. El filtro por estado ahora son chips en la vista Lista.)

  // `key` matches CrmTable.STATUS_COLUMNS[*].key so clicking a card drives the
  // table filter without translation.
  // MISMO orden de prioridad que BOARD_COLUMNS en SegBoard (oficina primero —
  // pedido del dueño, 24-ago-2026): los chips del filtro y el tablero tienen
  // que contar la misma historia, no dos órdenes distintos del mismo dato.
  const statCards: { key: string; label: string; value: number; icon: React.ReactNode; tone: StatTone }[] = [
    { key: 'oficina', label: 'En Oficina', value: stats.oficina, icon: <MapPin size={15} />, tone: 'warning' },
    { key: 'novedad', label: 'Novedad', value: stats.novedad, icon: <AlertTriangle size={15} />, tone: 'warning' },
    { key: 'reparto', label: 'En Reparto', value: stats.reparto, icon: <Truck size={15} />, tone: 'accent' },
    { key: 'novedad_sol', label: 'Nov. Solucionada', value: stats.novedad_sol, icon: <CheckCircle size={15} />, tone: 'success' },
    { key: 'guia', label: 'Guía Generada', value: stats.guia, icon: <Tag size={15} />, tone: 'neutral' },
    { key: 'bodega_trans', label: 'Bodega Transp.', value: stats.bodega_trans, icon: <Package size={15} />, tone: 'neutral' },
    { key: 'transito', label: 'En Tránsito', value: stats.transito, icon: <Truck size={15} />, tone: 'neutral' },
    { key: 'procesamiento', label: 'En Procesamiento', value: stats.procesamiento, icon: <Package size={15} />, tone: 'neutral' },
    { key: 'rechazado', label: 'Rechazado', value: stats.rechazado, icon: <AlertTriangle size={15} />, tone: 'danger' },
    { key: 'devolucion_transito', label: 'Dev. en Tránsito', value: stats.devolucion_transito, icon: <RotateCcw size={15} />, tone: 'danger' },
    { key: 'devolucion', label: 'Devolución', value: stats.devolucion, icon: <RotateCcw size={15} />, tone: 'danger' },
    { key: 'entregado', label: 'Entregado', value: stats.entregado, icon: <CheckCircle size={15} />, tone: 'success' },
    { key: 'indemnizada', label: 'Indemnizada', value: stats.indemnizada, icon: <DollarSign size={15} />, tone: 'muted' },
    { key: 'cancelado', label: 'Cancelado', value: stats.cancelado, icon: <Layers size={15} />, tone: 'muted' },
    // Una tarjeta POR ESTADO real para lo que no está mapeado, con su nombre de
    // Dropi. Así las tarjetas suman el total y el dueño ve el estado exacto de
    // todos sus pedidos, no una bolsa llamada "Otros". La `key` coincide con la
    // de la columna del tablero, así el filtro sigue funcionando de un clic.
    ...stats.sinMapear.map(([estado, value]) => ({
      key: `otros:${estado}`,
      label: estado,
      value,
      icon: <Layers size={15} />,
      tone: 'neutral' as StatTone,
    })),
  ];

  // Fullscreen loading only on the very first fetch. On subsequent refreshes
  // the existing data stays on screen and the Actualizar button shows the
  // spinner instead — no flash, no lost state.
  //
  // ⛔ Guard `!segLoaded && segData.length===0`, NO `&& segLoading` (fix 26-ago):
  // en el primer montaje (y en cada cambio de tienda, que resetea a
  // segLoaded=false/segData=[]) hay una ventana donde segLoading TODAVÍA es false
  // —el effect que llama loadSegData corre después del primer paint— y el tablero
  // pintaba "Sin pedidos en seguimiento" por un frame antes del esqueleto: un cero
  // falso, justo lo que la REGLA #2 prohíbe. La tienda VACÍA de verdad tiene
  // segLoaded=true → cae al "Sin pedidos" correcto, no al esqueleto. En error, el
  // loader ya reintenta a los 30s + toast, así que el esqueleto no se queda pegado.
  if (!segLoaded && segData.length === 0) {
    return (
      <div className="max-w-7xl mx-auto" role="status" aria-live="polite">
        {/* Esqueleto de la estructura REAL (cabecera + hero + carpetas) en vez
            de un spinner centrado: la asesora ya ve dónde va a estar cada cosa
            y no hay salto de layout cuando entran los datos. El aviso de texto
            se conserva íntegro para lectores de pantalla y para quien lee. */}
        <div className="mb-6 space-y-4">
          <div className="flex items-center gap-3">
            <span className="w-11 h-11 rounded-2xl bg-accent/14 border border-accent/30 text-accent glow-accent flex items-center justify-center shrink-0" aria-hidden="true">
              <Truck size={20} strokeWidth={2.25} />
            </span>
            <div className="space-y-2">
              <p className="text-sm font-semibold text-foreground flex items-center gap-2">
                <RefreshCw size={14} className="text-accent animate-spin" aria-hidden="true" />
                Cargando seguimiento...
              </p>
              <p className="text-xs text-muted-foreground">Recuperando pedidos desde la base de datos</p>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
            <div className="md:col-span-7 h-32 rounded-3xl border border-border bg-card/40 shadow-card3d-lg motion-safe:animate-pulse" aria-hidden="true" />
            <div className="md:col-span-5 h-32 rounded-2xl border border-border bg-card/40 shadow-card3d motion-safe:animate-pulse" aria-hidden="true" />
          </div>
        </div>
        <div className="flex gap-3 overflow-hidden" aria-hidden="true">
          {[0, 1, 2, 3].map(i => (
            <div
              key={i}
              className="shrink-0 w-[286px] rounded-2xl border border-border bg-card/40 shadow-card3d motion-safe:animate-pulse"
              style={{ height: `${320 - i * 40}px`, animationDelay: `${i * 120}ms` }}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto">
      <SegCounterBar />
      <div className="mb-6 space-y-3">
        {/* Título y controles en FILAS SEPARADAS, no lado a lado.
            El cluster de controles son 6 (toggle, buscador, rango de fechas,
            total, WhatsApp, sincronizar) y su ancho mínimo ronda los 1100px:
            al ponerlo en la misma fila que el título, no podía encogerse por
            debajo de ese mínimo y le dejaba al título ~100px, partiéndolo en
            una palabra por línea. Apilarlos lo hace imposible por construcción. */}
        <motion.header {...fadeUp(0)} className="flex flex-col gap-4">
          {/* Patrón HudTopbar del Dashboard: identidad a la izquierda, salud
              del dato a la derecha. El reloj de última sincronización vivía
              perdido al final de la fila de botones y oculto en <md — que es
              justo donde trabajan las asesoras. Sigue con su guard `&&`: si no
              hay dato NO se pinta una hora falsa. */}
          {/* Cabecera COMPRIMIDA (21-ago-2026). Antes ocupaba cuatro renglones
              —eyebrow, título con ícono de 44px, subtítulo y chip de reloj a la
              derecha— y era el primero de los TRECE bloques que había que pasar
              para ver un pedido. El subtítulo ("Pedidos en ruta — todos los
              estados de Dropi sincronizados") no le decía nada accionable a
              nadie, y el reloj de última sincronización bajó a la barra de
              mando, junto a los botones que lo mueven. */}
          <div className="flex items-center gap-3 min-w-0">
            <span className="w-9 h-9 rounded-xl bg-accent/14 border border-accent/30 text-accent glow-accent flex items-center justify-center shrink-0" aria-hidden="true">
              <Truck size={17} strokeWidth={2.25} />
            </span>
            <h1 className="text-xl font-bold tracking-tight text-foreground leading-none truncate">
              Seguimiento
            </h1>
          </div>
          {/* Fila de controles en TRES niveles de peso, en vez de seis grupos
              indistinguibles: (1) el modo de trabajo con superficie propia,
              (2) los filtros, (3) las acciones de datos empujadas al extremo. */}
          <div className="flex items-center gap-3 flex-wrap">
            {/* NIVEL 1 — Segmented control de vista: Tablero (Kommo, en vivo) ↔
                Lista (CrmTable). Es el switch que cambia TODA la pantalla, así
                que sale del pelotón de pills y toma superficie propia con la
                pastilla activa sólida (receta de toggles del Dashboard). */}
            <div
              className="inline-flex gap-[2px] p-[3px] rounded-xl bg-card/40 border border-border shadow-card3d"
              role="group"
              aria-label="Modo de trabajo"
            >
              <button
                type="button"
                onClick={() => setViewMode('board')}
                aria-pressed={viewMode === 'board'}
                className={cn(
                  'inline-flex items-center gap-1.5 px-4 py-2 rounded-[9px] text-sm transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none',
                  viewMode === 'board'
                    ? 'font-semibold bg-accent/16 border border-accent/40 text-accent shadow-glow3d'
                    : 'font-medium border border-transparent text-muted-foreground hover:text-foreground hover:bg-muted'
                )}
              >
                <LayoutGrid size={13} aria-hidden="true" /> Tablero
              </button>
              <button
                type="button"
                onClick={() => setViewMode('list')}
                aria-pressed={viewMode === 'list'}
                className={cn(
                  'inline-flex items-center gap-1.5 px-4 py-2 rounded-[9px] text-sm transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none',
                  viewMode === 'list'
                    ? 'font-semibold bg-accent/16 border border-accent/40 text-accent shadow-glow3d'
                    : 'font-medium border border-transparent text-muted-foreground hover:text-foreground hover:bg-muted'
                )}
              >
                <List size={13} aria-hidden="true" /> Lista
              </button>
            </div>
            <div className="h-6 w-px bg-border hidden sm:block" aria-hidden="true" />
            {/* NIVEL 2 — Buscador (nombre · teléfono · ciudad · guía · producto).
                Es lo que usa la asesora cuando el cliente llama y dice su
                nombre: se ensancha para tener rango de herramienta primaria. */}
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" aria-hidden="true" />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar…"
                aria-label="Buscar en seguimiento"
                className="h-11 w-44 sm:w-72 rounded-xl border border-border bg-card/40 pl-9 pr-9 text-sm text-foreground placeholder:text-muted-foreground hover:border-border-strong transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
              />
              {search && (
                <button type="button" onClick={() => setSearch('')} aria-label="Limpiar búsqueda"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  <X size={13} aria-hidden="true" />
                </button>
              )}
            </div>
            {/* FILTROS — un solo botón (21-ago-2026).
                Antes eran DOS filas separadas: acá dos selectores de fecha + un
                botón de limpiar, y treinta centímetros más abajo una fila de
                chips por estado. Las dos acotan la misma población con criterios
                distintos, así que ahora viven juntas detrás de un control.
                El botón lleva la cuenta de filtros activos: un filtro escondido
                que no se anuncia es peor que uno desplegado — la asesora
                concluye "no hay pedidos" cuando en realidad los está filtrando. */}
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    "inline-flex items-center gap-2 h-11 rounded-xl border px-3.5 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                    filtrosActivos > 0
                      ? "font-semibold bg-accent/16 border-accent/40 text-accent shadow-glow3d"
                      : "font-medium bg-card/40 border-border text-muted-foreground hover:text-foreground hover:border-border-strong",
                  )}
                >
                  <Filter size={14} aria-hidden="true" />
                  <span className="hidden sm:inline">Filtros</span>
                  {filtrosActivos > 0 && (
                    <span className="font-mono tabular-nums text-[13px] font-bold">{filtrosActivos}</span>
                  )}
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-[min(22rem,calc(100vw-2rem))] p-4 space-y-4" align="start">
                <div className="space-y-2">
                  <div className="hud-label">Rango de fechas</div>
                  <div className="flex items-center gap-2">
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button variant="outline" size="sm" className={cn("flex-1 h-10 gap-1.5 text-xs font-normal", !dateFrom && "text-muted-foreground")}>
                          <CalendarIcon size={12} />
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
                    <span className="text-[10px] text-muted-foreground/50">—</span>
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button variant="outline" size="sm" className={cn("flex-1 h-10 gap-1.5 text-xs font-normal", !dateTo && "text-muted-foreground")}>
                          <CalendarIcon size={12} />
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
                  </div>
                </div>

                {/* Estado: solo en LISTA. En Tablero las columnas SON el resumen
                    por estado y se filtran solas al enfocar una — repetirlo acá
                    era el mismo dato dos veces, que es de lo que se quejó el
                    dueño. La salida del filtro en Tablero sigue abajo. */}
                {viewMode === 'list' && statCards.some((c) => c.value > 0) && (
                  <div className="space-y-2">
                    <div className="hud-label">Estado</div>
                    <div className="flex flex-wrap gap-1.5 max-h-52 overflow-y-auto [scrollbar-width:thin]" role="group" aria-label="Filtrar por estado">
                      {statCards.filter((c) => c.value > 0).map((card) => {
                        const isActive = statusFilter === card.key;
                        return (
                          <button
                            key={card.key}
                            type="button"
                            aria-pressed={isActive}
                            aria-label={`Filtrar por ${card.label}: ${card.value} pedidos`}
                            onClick={() => setStatusFilter(isActive ? null : card.key)}
                            className={cn(
                              "inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none",
                              isActive
                                ? 'bg-accent/15 border-accent/40 text-accent font-semibold'
                                : 'bg-card/40 border-border text-muted-foreground hover:text-foreground hover:border-border-strong',
                            )}
                          >
                            <span className="truncate max-w-[150px]">{card.label}</span>
                            <span className="font-mono tabular-nums font-bold">{card.value}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {filtrosActivos > 0 && (
                  <button
                    type="button"
                    onClick={() => { setDateFrom(''); setDateTo(''); setStatusFilter(null); }}
                    className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-card/40 px-3 py-2 text-xs font-semibold text-muted-foreground hover:text-foreground hover:border-border-strong transition-colors"
                  >
                    <X size={12} aria-hidden="true" /> Quitar todos los filtros
                  </button>
                )}
              </PopoverContent>
            </Popover>

            {/* ACCIONES DE DATOS — un botón con menú (21-ago-2026).
                Antes eran dos botones lado a lado, "Sincronizar Dropi" y
                "Actualizar", que hacen cosas distintas y nadie sabía cuál
                apretar. Ahora la acción PRINCIPAL (traer el estado real desde
                Dropi) es el botón, y la secundaria (releer la base) vive en el
                menú, con su explicación al lado.

                Los DOS indicadores de carga se conservan: `isSyncingDropi` y
                `segLoading` son estados independientes y fusionarlos dejaría a
                la asesora sin saber cuál de los dos corrió. El botón muestra el
                que esté activo, con su propio texto. */}
            <div className="flex items-center gap-2 sm:ml-auto">
              {segLastUpdate && (
                <span
                  className="hidden md:inline-flex items-center gap-1.5 text-xs text-muted-foreground shrink-0"
                  title="Hora de la última lectura de datos"
                >
                  <span className="w-2 h-2 rounded-full bg-success glow-success motion-safe:animate-gb-pulse" aria-hidden="true" />
                  <span className="font-mono tabular-nums">
                    {segLastUpdate.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </span>
              )}
              <div className="inline-flex items-stretch rounded-xl overflow-hidden shadow-card3d">
                <button
                  onClick={() => refreshNow(activeStoreId, { force: true })}
                  disabled={isSyncingDropi || segLoading}
                  title="Trae el estado real de Dropi de los pedidos recientes ahora mismo"
                  className="btn-accent-3d inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold disabled:opacity-50 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none rounded-none"
                >
                  {segLoading && !isSyncingDropi
                    ? <RefreshCw size={14} className="animate-spin" aria-hidden="true" />
                    : <Cloud size={14} className={isSyncingDropi ? 'animate-pulse' : ''} aria-hidden="true" />}
                  <span className="hidden sm:inline">
                    {isSyncingDropi ? 'Sincronizando…' : segLoading ? 'Actualizando…' : 'Sincronizar'}
                  </span>
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label="Más opciones de datos"
                      className="btn-accent-3d inline-flex items-center px-2 border-l border-black/15 disabled:opacity-50 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none rounded-none"
                    >
                      <ChevronDown size={14} aria-hidden="true" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-72">
                    <DropdownMenuItem
                      disabled={isSyncingDropi}
                      onClick={() => refreshNow(activeStoreId, { force: true })}
                      className="flex flex-col items-start gap-0.5"
                    >
                      <span className="font-semibold">Sincronizar con Dropi</span>
                      <span className="text-[11px] text-muted-foreground leading-snug">
                        Le pregunta a Dropi el estado real de los pedidos recientes.
                      </span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={segLoading}
                      onClick={() => loadSegData(true)}
                      className="flex flex-col items-start gap-0.5"
                    >
                      <span className="font-semibold">Volver a leer la base</span>
                      <span className="text-[11px] text-muted-foreground leading-snug">
                        No consulta a Dropi: solo recarga lo que Guardian ya tiene guardado.
                      </span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </div>
        </motion.header>

        {/* ALERTA DE CAMBIOS — "N devoluciones / en oficina nuevas" desde la
            última vez que se dio por visto. Es LA alerta que faltaba: un pedido
            que se va a devolución desaparecía del tablero en silencio. */}
        {/* Adelgazado a UNA línea (21-ago-2026): la explicación de dónde
            aparecen ("en el chip Se fue a devolución; lo de oficina, en su
            columna") pasó al `title`. El aviso es el número, no el párrafo. */}
        {alertaCambios && (
          <motion.div {...fadeUp(0.02)}>
            <div
              role="status"
              title="Las devoluciones aparecen en el chip «Se fue a devolución»; lo de oficina, en su columna."
              className="inline-flex items-center gap-2 rounded-full border border-danger/30 bg-danger/10 px-3 py-1"
            >
              <RotateCcw size={13} className="text-danger shrink-0" aria-hidden="true" />
              <p className="text-xs text-foreground leading-snug min-w-0">
                <strong className="font-semibold">{alertaCambios}</strong>
                <span className="text-muted-foreground"> desde tu última revisión</span>
              </p>
              <button
                type="button"
                onClick={descartarAlerta}
                aria-label="Entendido — marcar como visto"
                title="Entendido — marcar como visto"
                className="p-1.5 -m-0.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-foreground/10 transition-colors shrink-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <X size={13} aria-hidden="true" />
              </button>
            </div>
          </motion.div>
        )}

        {/* Búsqueda en la BASE (todo el histórico de la tienda). La lista de
            abajo solo puede filtrar lo descargado; esto evita concluir "no
            existe" cuando el pedido está fuera de la ventana de fechas. */}
        {search.trim() && (
          <GlobalOrderSearchPanel storeId={activeStoreId} query={search} />
        )}



        {/* ─────────────────────────────────────────────────────────────
            HERO — "cómo voy hoy" antes que cualquier filtro.
            El contador diario vivía ENTERRADO debajo de los chips y del
            resumen por estado, aunque es la única pieza que ya usaba
            TiltCard+CountUp (el hero del Dashboard). Sube arriba del todo y
            toma el molde completo: aro con el % del día (el pct ya estaba
            calculado, solo no se dibujaba) + la cifra contando + la barra de
            meta. Al lado, el Total con anatomía de StatTile.
            ───────────────────────────────────────────────────────────── */}
        {/* HERO + TURNO agrupados como UN solo bloque (26-ago-2026): la cifra
            del día y el panel del turno se leen pegados (space-y-2) en vez de
            dos tarjetas sueltas separadas por el aire del contenedor externo.
            Es solo un wrapper de markup — el cierre y los chips SLA quedan fuera. */}
        <div className="space-y-2">
        {(() => {
          // Las cuentas pesadas viven en el memo `hero` (arriba) — acá solo
          // quedan derivaciones baratas de estilo.
          const { enRuta, total, gestionados, faltan, detenidos, asesorasHoy, pct, heroVisible } = hero;
          const done = faltan === 0;
          const tone = done
            ? 'success'
            : faltan >= Math.max(1, Math.ceil(total / 2)) ? 'danger' : 'warning';
          const borderTone = tone === 'success' ? 'border-success/30' : tone === 'warning' ? 'border-warning/30' : 'border-danger/30';
          const barTone = tone === 'success' ? 'bg-success' : tone === 'warning' ? 'bg-warning' : 'bg-danger';
          const faltanTone = tone === 'success' ? 'text-success' : tone === 'warning' ? 'text-warning' : 'text-danger';
          // num-glow solo existe para success/danger en index.css — warning va
          // sin glow en vez de inventar un token que no está definido.
          const faltanGlow = tone === 'success' ? 'num-glow-success' : tone === 'danger' ? 'num-glow-danger' : '';
          return (
            <div className="space-y-2">
            {/* Resumen en UNA línea. Es lo único que se ve por defecto: dice el
                estado del día sin ocupar media pantalla. Los mismos números que
                el hero, sin los aros ni las tarjetas. */}
            <motion.div
              {...fadeUp(0.05)}
              className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-2xl border border-border bg-card/40 px-4 py-2.5 shadow-card3d"
            >
              {heroVisible && !coverageSegError && (
                <span className="flex items-baseline gap-1.5">
                  <span className={cn('text-lg font-mono tabular-nums font-bold leading-none', faltanTone)}>{faltan}</span>
                  <span className="text-[11px] text-muted-foreground">por gestionar hoy</span>
                </span>
              )}
              {heroVisible && !coverageSegError && (
                <span className="text-[11px] text-muted-foreground">
                  <span className="font-mono tabular-nums font-semibold text-foreground">{gestionados}</span> de{' '}
                  <span className="font-mono tabular-nums">{total}</span> gestionados
                </span>
              )}
              {heroVisible && coverageSegError && (
                <span className="text-[11px] text-muted-foreground">
                  No se pudo leer lo gestionado hoy — los pedidos ya trabajados pueden reaparecer.
                </span>
              )}
              {/* «N detenidos» se quitó de acá (27-ago-2026): el mismo número ya
                  está en la pastilla clicable «Detenidos» de Listas de trabajo —
                  salía dos veces y el dueño lo marcó como ruido. */}
              <span className="text-[11px] text-muted-foreground">
                <span className="font-mono tabular-nums">{enRuta}</span> en ruta
              </span>
              {/* El final del día. Va acá, pegado a los números que va a
                  firmar, y no en la barra de mando: es una acción de una vez
                  al día y no compite con lo que se usa todo el tiempo.
                  NO bloquea nada — ver CierreSeguimientoDialog. */}
              <button
                type="button"
                onClick={() => setCierreAbierto(true)}
                className="ml-auto shrink-0 inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-lg border border-border bg-card/60 text-muted-foreground hover:text-foreground hover:border-border-strong transition-colors"
                title="Deja registrado cómo terminó la cola de hoy: o quedó en cero, o queda escrito por qué no."
              >
                <Moon size={11} aria-hidden="true" /> Cerrar el día
              </button>
              <button
                type="button"
                onClick={() => setHeroAbierto((v) => !v)}
                className="shrink-0 text-[11px] font-semibold px-2.5 py-1 rounded-lg border border-border bg-card/60 text-muted-foreground hover:text-foreground hover:border-border-strong transition-colors"
              >
                {heroAbierto ? 'Ocultar detalle' : 'Ver detalle'}
              </button>
            </motion.div>

            {heroAbierto && (
            <motion.div {...fadeUp(0.05)} className="grid grid-cols-1 md:grid-cols-12 gap-4">
              {/* HONESTIDAD: si la query de touchpoints del día falló, "Gestionados
                  0 de N" sería un cero inventado (la operadora leería "no
                  trabajaste"). Se reemplaza el aro/contador por un "—" en tono
                  NEUTRO (contrato de coverageSegError en OrderContext: no sabemos
                  si está mal — no sabemos nada, así que nada de rojo) y se avisa
                  que los pedidos ya gestionados pueden reaparecer en el tablero. */}
              {heroVisible && coverageSegError && (
                <TiltCard
                  sheen
                  wrapperClassName="md:col-span-7"
                  className="relative bg-card/40 border border-border rounded-3xl p-6 shadow-card3d-lg h-full"
                >
                  <div className="flex items-start gap-4 tilt-layer-2">
                    <span className="w-11 h-11 rounded-2xl bg-muted/60 border border-border text-muted-foreground flex items-center justify-center shrink-0" aria-hidden="true">
                      <AlertTriangle size={20} />
                    </span>
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <span className="text-4xl font-extrabold leading-none font-mono text-muted-foreground" aria-hidden="true">—</span>
                        <span className="text-sm font-semibold text-foreground">No se pudieron leer tus gestiones de hoy</span>
                      </div>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        Esto NO significa que no gestionaste nada: no se pudo leer la base. Hay{' '}
                        <strong className="font-mono tabular-nums text-foreground">{enRuta}</strong>{' '}
                        {enRuta === 1 ? 'pedido' : 'pedidos'} en la vista, pero no sabemos cuáles ya
                        gestionaste — los que ya trabajaste hoy pueden aparecer de nuevo en el tablero.
                        Recargá la página; si sigue igual, avisá.
                      </p>
                    </div>
                  </div>
                </TiltCard>
              )}
              {heroVisible && !coverageSegError && (
                <TiltCard
                  sheen
                  brackets
                  wrapperClassName="md:col-span-7"
                  className={`relative bg-card/40 border ${borderTone} rounded-3xl p-6 pl-7 shadow-card3d-lg h-full`}
                >
                  <span className={`absolute left-0 top-5 bottom-5 w-1 rounded-full ${barTone}`} aria-hidden="true" />
                  <div className="flex items-center gap-5 flex-wrap sm:flex-nowrap tilt-layer-2">
                    {/* Aro del día: el mismo % que llena la barra, dibujado con
                        el gauge del Dashboard. Antes el pct solo existía como
                        una barra de 1.5px al pie de la tarjeta. */}
                    <div className="shrink-0 mx-auto sm:mx-0">
                      {/* El aro toma el MISMO tono que el resto de la tarjeta:
                          es el elemento más grande y con la rampa índigo fija
                          presidía "sano" una tarjeta en rojo. */}
                      <GaugeRing value={pct} size={132} thickness={13} tone={tone} />
                    </div>
                    <div className="min-w-0 flex-1 space-y-2.5 tilt-layer-3">
                      <div className="flex items-baseline gap-2 min-w-0 flex-wrap">
                        <CountUp value={faltan} className={`text-4xl font-extrabold leading-none ${faltanTone} ${faltanGlow}`} />
                        <span className="text-sm font-semibold text-foreground">
                          {done
                            ? (listaActiva && !listaActiva.externalRoute ? '¡Lista en 0! ✓' : '¡Cola del día en 0! ✓')
                            : listaActiva && !listaActiva.externalRoute
                              ? `${faltan === 1 ? 'pedido' : 'pedidos'} por gestionar en esta lista`
                              : `en la cola de HOY — se deja en 0`}
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground flex items-baseline gap-x-1.5 flex-wrap">
                        <span>Gestionados</span>
                        <strong className="font-mono tabular-nums text-foreground">{gestionados}</strong>
                        <span>de</span>
                        <strong className="font-mono tabular-nums text-foreground">{total}</strong>
                        {!listaActiva && (
                          <span
                            className="cursor-help"
                            title="La cola de HOY junta solo lo accionable: detenidos, agencia sin retirar, reparto/novedad, indemnizaciones vencidas y pendientes de guía. Un paquete viajando normal no es una tarea — se vigila, no se exige."
                          >
                            · {enRuta} en ruta en total
                          </span>
                        )}
                      </div>
                      {/* Barra de progreso del día — se llena a medida que gestionás. */}
                      <div className="h-1.5 w-full rounded-full bg-foreground/10 overflow-hidden" aria-hidden="true">
                        <div className={`h-full rounded-full ${barTone} transition-all duration-300`} style={{ width: `${pct}%` }} />
                      </div>
                      {viewMode === 'board' && (
                        <label className="inline-flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none pt-0.5">
                          <input
                            type="checkbox"
                            checked={onlyUntouchedSeg}
                            onChange={(e) => setOnlyUntouchedSeg(e.target.checked)}
                            className="h-3.5 w-3.5 rounded border-border accent-accent cursor-pointer"
                          />
                          Ocultar gestionados
                        </label>
                      )}
                    </div>
                  </div>
                </TiltCard>
              )}

              {/* TOTAL — anatomía de StatTile: chip con glow, cifra contando,
                  hud-label bajo la cifra. Las tres notas de transparencia
                  ("viejos ocultos" / "reemplazados Dropi" / "resueltos ocultos")
                  son las que explican por qué el total no cuadra con Dropi:
                  bajan a una línea propia legible en vez de quedar apretadas en
                  10px al lado del número. Sus condiciones y sus `title` van
                  intactos. */}
              <TiltCard
                perspective={1200}
                wrapperClassName={heroVisible ? 'md:col-span-5' : 'md:col-span-12'}
                className="bg-card/40 border border-border rounded-2xl p-5 shadow-card3d h-full"
              >
                <div className="flex items-start justify-between gap-2 tilt-layer-2">
                  <span className={`w-9 h-9 rounded-xl border flex items-center justify-center flex-shrink-0 ${
                    detenidos > 0
                      ? 'bg-danger/14 border-danger/30 text-danger glow-danger'
                      : 'bg-success/14 border-success/30 text-success glow-success'
                  }`}>
                    {detenidos > 0
                      ? <AlertTriangle size={17} aria-hidden="true" />
                      : <Package size={17} aria-hidden="true" />}
                  </span>
                  {(dateFrom || dateTo) && stats.total !== segData.length && (
                    <span className="text-[11px] font-medium text-muted-foreground font-mono tabular-nums">
                      / {segData.length}
                    </span>
                  )}
                </div>
                {/* DETENIDOS reemplaza al viejo "Total" (1-ago-2026).
                    Ese Total repetía el mismo 222 del hero y del chip "Todas" —
                    tres veces el mismo número y ninguna respuesta nueva. El
                    paquete que no se mueve hace días es el que termina en
                    devolución, y hasta ahora solo existía como puntito de color
                    dentro de cada tarjeta: para contarlos había que recorrer 15
                    columnas a ojo. El total no se pierde: baja a la línea de
                    contexto de abajo, que es su peso real. */}
                <div className={`text-2xl font-bold leading-none mt-3 tilt-layer-3 ${detenidos > 0 ? 'text-danger' : 'text-success'}`}>
                  <CountUp value={detenidos} />
                </div>
                <div
                  className="hud-label text-subtle mt-2 tilt-layer-1"
                  title={`Pedidos en juego que llevan ${Math.round(HORAS_DETENIDO / 24)} días o más sin moverse en Dropi. Los entregados, cancelados y devueltos no cuentan: ya llegaron a su desenlace.`}
                >
                  {detenidos === 1 ? 'Detenido' : 'Detenidos'} · +{Math.round(HORAS_DETENIDO / 24)} días quieto{detenidos === 1 ? '' : 's'}
                </div>

                {/* EL EQUIPO HOY. La otra pregunta que la pantalla no contestaba.
                    El 31-jul Ecuador registró UNA gestión en todo el día con 229
                    pedidos en la calle y no había forma de verlo desde acá: el
                    dueño se enteró porque se lo contaron. Un cero explícito es
                    justamente la señal. */}
                <div className="mt-3 pt-3 border-t border-border/50 tilt-layer-1">
                  <div className="flex items-baseline gap-1.5 flex-wrap text-xs">
                    <span className="text-muted-foreground">Gestionó el equipo hoy:</span>
                    <strong className={`font-mono tabular-nums ${gestionados > 0 ? 'text-foreground' : 'text-warning'}`}>
                      {gestionados}
                    </strong>
                    <span className="text-muted-foreground">de {total}</span>
                  </div>
                  {asesorasHoy.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {asesorasHoy.map((a) => (
                        <span
                          key={a.operatorId}
                          title={`${nombreDeAsesora(a.operatorId)} trabajó ${a.pedidos} ${a.pedidos === 1 ? 'pedido' : 'pedidos'} hoy`}
                          className="text-[11px] px-2 py-0.5 rounded-lg border bg-card/50 border-border text-muted-foreground inline-flex items-center gap-1.5"
                        >
                          <span className="truncate max-w-[110px]">{nombreDeAsesora(a.operatorId)}</span>
                          <span className="font-mono tabular-nums font-bold text-foreground">{a.pedidos}</span>
                        </span>
                      ))}
                    </div>
                  ) : (
                    // El regaño amarillo solo tiene sentido EN horario laboral:
                    // a las 00:47 "Nadie ha tocado Seguimiento hoy" es ruido que
                    // grita en rojo un día que todavía no empezó (captura del
                    // dueño, 14-ago-2026). Fuera de 9–21 baja a tono neutro.
                    (() => {
                      const h = new Date().getHours();
                      return h >= 9 && h < 21;
                    })() ? (
                      <p className="mt-1.5 text-[11px] text-warning leading-relaxed">
                        Nadie ha tocado Seguimiento hoy.
                      </p>
                    ) : (
                      <p className="mt-1.5 text-[11px] text-muted-foreground leading-relaxed">
                        Sin gestiones registradas todavía.
                      </p>
                    )
                  )}
                </div>

                {/* Notas de transparencia (por qué la cuenta no cuadra con
                    Dropi). Antes eran hasta 4 renglones apilados — el dueño
                    pidió quitar ruido: bajan a UNA línea que envuelve, mismo
                    contenido, mismos tooltips. La honestidad no se negocia;
                    el espacio sí. */}
                <div className="mt-3 pt-3 border-t border-border/50 flex flex-wrap gap-x-3 gap-y-1 tilt-layer-1">
                  <span
                    className="text-[11px] text-muted-foreground font-mono tabular-nums cursor-help"
                    title="Todos los pedidos cargados en la vista actual (con los filtros de fecha aplicados). El número grande de la izquierda cuenta solo la cola de trabajo activa."
                  >
                    · {stats.total} cargados
                  </span>
                    {hiddenStaleCount > 0 && (
                      <span
                        className="text-[11px] text-muted-foreground font-mono tabular-nums cursor-help"
                        title={`${hiddenStaleCount} pedidos con más de ${DEFAULT_WINDOW_DAYS} días (fuera de la ventana por defecto de los últimos ${DEFAULT_WINDOW_DAYS} días). No se borraron — vé el histórico completo poniendo un rango de fechas.`}
                      >
                        · {hiddenStaleCount} viejos ocultos
                      </span>
                    )}
                    {hiddenSupersededCount > 0 && (
                      <span
                        className="text-[11px] text-warning font-mono tabular-nums cursor-help"
                        title={`${hiddenSupersededCount} pedido${hiddenSupersededCount > 1 ? 's' : ''} reemplazados por Dropi (mismo cliente + producto, nueva versión más reciente). Se ocultan para no duplicar la cola — el más reciente sí aparece.`}
                      >
                        · {hiddenSupersededCount} reemplazados
                      </span>
                    )}
                    {hiddenClosedCount > 0 && (
                      <span
                        className="text-[11px] text-muted-foreground font-mono tabular-nums cursor-help"
                        title={`${hiddenClosedCount} pedido${hiddenClosedCount > 1 ? 's' : ''} cerrados (Resuelto/Devolución) ocultos. No se borraron — aparecen en el histórico con un rango de fechas más amplio.`}
                      >
                        · {hiddenClosedCount} resueltos ocultos
                      </span>
                    )}
                  </div>
              </TiltCard>
            </motion.div>
            )}
            </div>
          );
        })()}

        {/* Asignación del día (pieza C del protocolo del turno).
            La etiqueta es de RESPONSABILIDAD, NUNCA un candado: filtra la vista
            y nada más. Cualquiera puede seguir gestionando cualquier pedido —
            convertirla en bloqueo fue el error que hizo apagar la
            auto-asignación en mayo-2026 ("Atendido por X — no puedes ejecutar
            acciones"). Si la migración no está aplicada, `soportado` es false y
            toda esta fila no existe, en vez de un botón que revienta. */}
        {/* El botón "Repartir" se mudó DENTRO de este panel (21-ago-2026): es la
            respuesta directa a leer «N sin dueño», y tenerlo en una fila aparte
            obligaba a cruzar la pantalla entre el dato y su acción. Y "Solo las
            mías" bajó a la fila de chips, que es donde viven los filtros de la
            cola. Con eso desaparece una fila entera para la asesora, que no ve
            este panel. */}
        {asig.soportado && isManagerOfActive && (
          <motion.div {...fadeUp(0.09)}>
            <TurnoDelEquipoPanel
              resumen={resumenTurno}
              nombreDe={nombreDeAsesora}
              onRepartir={repartirColaDeHoy}
              repartiendo={asig.repartiendo}
            />
          </motion.div>
        )}
        </div>

        {/* El cierre del día. `gestionados` va en null si la lectura falló:
            el diálogo se niega a firmar números que nadie midió.
            OJO: firma `colaCierre`/`gestionadosCierre` (SIEMPRE lo accionable),
            NO `total`/`gestionados` del hero, que con una lista SLA activa
            miden solo esa lista — y una lista en 0 no es el día en 0. */}
        <CierreSeguimientoDialog
          open={cierreAbierto}
          onClose={() => setCierreAbierto(false)}
          storeId={activeStoreId}
          cola={hero.colaCierre}
          gestionados={coverageSegError ? null : hero.gestionadosCierre}
        />

        {/* Listas de trabajo (SLA) — forma PRINCIPAL de priorizar. Reemplaza
            al viejo dropdown + banner de atrasados: una sola fila de chips
            ordenados por urgencia, con conteo y un "Sugerido" hacia dónde
            empezar. Solo se muestran las listas con pedidos (+ las que linkean
            a otra ruta, ej. confirmación). */}
        <motion.div {...fadeUp(0.12)} className="space-y-2">
          <div className="flex items-center gap-1.5 hud-label">
            <Filter size={12} aria-hidden="true" /> Listas de trabajo
            {/* Quien no sabe qué es "En agencia" lo lee sin salir de la
                operación. Con una lista activa el link cae en SU párrafo: la
                explicación llega donde nació la duda, no en un menú aparte. */}
            <button
              type="button"
              onClick={() => navigate(
                listaActiva ? `/como-se-trabaja#lista-${listaActiva.slug}` : '/como-se-trabaja',
              )}
              className="ml-1 normal-case tracking-normal text-[11px] font-normal text-muted-foreground underline underline-offset-2 hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
            >
              {listaActiva ? '¿qué es esta lista?' : '¿qué significan?'}
            </button>
          </div>
          {/* Una fila horizontal scrolleable en TODOS los tamaños (27-ago-2026).
              Antes en sm+ envolvía a 2 filas y empujaba los pedidos hacia abajo;
              el dueño pidió menos ruido, así que ahora también en desktop es un
              solo renglón que se corre de lado. Ninguna lista se esconde: se
              llega a todas scrolleando, y las más urgentes quedan a la izquierda. */}
          <div className="flex gap-2 overflow-x-auto snap-x snap-mandatory pb-1 -mx-1 px-1 [scrollbar-width:thin]">
            <button
              type="button"
              onClick={() => setListaSlug(null)}
              aria-pressed={!listaSlug}
              className={cn(
                "snap-start shrink-0 inline-flex items-center gap-2.5 rounded-xl border px-4 min-h-[44px] text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                !listaSlug
                  ? "font-semibold bg-accent/16 border-accent/40 text-accent shadow-glow3d"
                  : "font-medium bg-card/40 border-border text-muted-foreground hover:text-foreground hover:border-border-strong"
              )}
            >
              Todas
              {/* chipsBase (no dedupedByDate): en vista Lista respira con el
                  mismo snapshot congelado que los demás chips y la tabla. */}
              <span className={cn(
                "font-mono tabular-nums text-[13px] font-bold",
                !listaSlug ? "text-accent num-glow-accent" : "text-foreground",
              )}>{chipsBase.length}</span>
            </button>

            {/* "Solo las mías" es un FILTRO de la cola, así que vive con los
                demás filtros y no en una fila propia (21-ago-2026). Solo
                aparece si hay algo asignado a quien mira: un chip en 0 que
                nunca se puede prender es ruido.
                No bloquea nada — la asignación es etiqueta, no candado.
                ⛔ Pero si el filtro ya está PRENDIDO se muestra aunque el conteo
                sea 0 (misma trampa que "Ver solo estos", 26-ago): al cambiar a
                una tienda sin asignados —la key no es por tienda— o al cerrarse
                mis pedidos, el chip desaparecía y `soloMias` seguía activo →
                cola vacía sin forma de apagarlo. Así siempre queda el escape. */}
            {asig.soportado && (misAsignadosHoy > 0 || soloMias) && (
              <button
                type="button"
                onClick={() => setSoloMias((v) => !v)}
                aria-pressed={soloMias}
                title="Los pedidos que te tocaron hoy. No bloquea nada: podés seguir gestionando cualquier otro."
                className={cn(
                  "snap-start shrink-0 inline-flex items-center gap-2.5 rounded-xl border px-4 min-h-[44px] text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  soloMias
                    ? "font-semibold bg-accent/16 border-accent/40 text-accent shadow-glow3d"
                    : "font-medium bg-card/40 border-border text-muted-foreground hover:text-foreground hover:border-border-strong",
                )}
              >
                <UserIcon size={13} aria-hidden="true" />
                Mías
                <span className={cn(
                  "font-mono tabular-nums text-[13px] font-bold",
                  soloMias ? "text-accent num-glow-accent" : "text-foreground",
                )}>{misAsignadosHoy}</span>
              </button>
            )}
            {SEG_LISTS
              // Fuera las que ESPEJAN el Tablero: "En tránsito 72" arriba y
              // "72 EN TRÁNSITO" en la columna de abajo era el mismo dato dos
              // veces. Lo que queda son las listas que el Tablero NO puede
              // decir, porque está organizado por fase y estas miran el RELOJ:
              // qué está vencido y qué lleva días sin moverse. La lógica de las
              // ocultas sigue viva — la usa el guard de inactividad.
              .filter(seMuestraComoChip)
              .filter((l) => l.externalRoute || (listCounts[l.slug] ?? 0) > 0)
              .map((l) => {
                const active = listaSlug === l.slug;
                const count = listCounts[l.slug] ?? 0;
                const suggested = l.slug === suggestedSlug;
                // Tinte completo por urgencia: el chip ENTERO habla, no un punto
                // de 1.5px. Las listas ya vienen ordenadas por prioridad de
                // embudo en segLists.ts — el diseño ahora lo respeta.
                const lt = LIST_TONE_CHIP[l.tone] ?? LIST_TONE_CHIP.neutral;
                return (
                  <button
                    key={l.slug}
                    type="button"
                    onClick={() => setListaSlug(active ? null : l.slug)}
                    aria-pressed={active}
                    title={l.label}
                    className={cn(
                      "snap-start shrink-0 inline-flex items-center gap-2.5 rounded-xl border px-4 min-h-[44px] text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                      active
                        ? "font-semibold bg-accent/16 border-accent/40 text-accent shadow-glow3d"
                        : cn("font-medium", lt.idle),
                    )}
                  >
                    {l.externalRoute
                      ? <ExternalLink size={13} aria-hidden="true" />
                      : <span className={cn("w-2 h-2 rounded-full shrink-0", active ? "bg-accent glow-accent" : LIST_TONE_DOT[l.tone])} aria-hidden="true" />}
                    <span className="truncate max-w-[15rem]">{l.label}</span>
                    {/* El conteo SOLO se pinta en listas que se cuentan acá. Las
                        que viven en otra ruta (confirmación) tienen count 0 por
                        construcción: mostrarlo sería un 0 mentiroso. */}
                    {!l.externalRoute && (
                      <span className={cn(
                        "font-mono tabular-nums text-[13px] font-bold",
                        active ? "text-accent num-glow-accent" : cn(lt.count, lt.numGlow),
                      )}>{count}</span>
                    )}
                    {suggested && !active && (
                      <span className="inline-flex items-center px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-accent/14 border border-accent/30 text-accent glow-accent shrink-0">
                        Sugerido
                      </span>
                    )}
                  </button>
                );
              })}
          </div>
        </motion.div>

        {/* La fila de chips por estado se mudó DENTRO del botón "Filtros"
            (21-ago-2026): acotaba la misma población que el rango de fechas,
            pero vivía en otra fila y con otro tratamiento visual.
            Lo que SÍ queda acá es la SALIDA cuando hay un estado filtrado: sin
            este botón el tablero se queda con una sola columna y sin forma
            visible de volver, que es una trampa. Va en las dos vistas, porque
            ahora el filtro está plegado y hay que anunciarlo. */}
        {statusFilter && (
          <div>
            <button
              type="button"
              onClick={() => setStatusFilter(null)}
              className="inline-flex items-center gap-1.5 rounded-xl bg-accent/10 border border-accent/30 px-3 py-1.5 text-xs font-semibold text-accent hover:bg-accent/15 transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
            >
              Mostrando solo {statCards.find((c) => c.key === statusFilter)?.label ?? statusFilter}
              <span aria-hidden="true">·</span> Ver todas ✕
            </button>
          </div>
        )}
      </div>

      {/* Banner solo para listas que viven en OTRA ruta (ej. confirmación).
          Las demás listas ya muestran su estado activo + conteo en los chips
          de arriba, así que no necesitan banner aparte. */}
      {listaActiva?.externalRoute && (
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          // Adelgazado a UNA línea (21-ago-2026): era un banner de cuatro
          // renglones con un ícono de 44px para decir "esto se hace en otra
          // pantalla, andá". El detalle largo pasó al `title`.
          title={`Los pedidos pendientes de confirmación se gestionan desde la cola de llamadas, en ${listaActiva.externalRoute}.`}
          className="mb-4 rounded-xl border border-accent/30 bg-card/40 px-3.5 py-2 flex items-center gap-2.5"
        >
          <ExternalLink size={14} className="text-accent shrink-0" aria-hidden="true" />
          <span className="text-xs text-foreground min-w-0 flex-1 truncate">
            <strong className="font-semibold">{listaActiva.label}</strong>
            <span className="text-muted-foreground"> se gestiona en otra pantalla</span>
          </span>
          <Link
            to={listaActiva.externalRoute}
            className="btn-accent-3d inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold no-underline shrink-0"
          >
            Ir
            <ChevronRight size={13} aria-hidden="true" />
          </Link>
        </motion.div>
      )}

      {/* El contador diario ("Te faltan N") ya NO vive acá: subió al hero, junto
          al título, para que la asesora vea "cómo voy hoy" ANTES de cualquier
          filtro — igual que el aro de confirmación del Dashboard. Misma fuente
          (chipsBase en Lista / dedupedByDate en Tablero), misma fórmula. */}

      {/* Clientes esperando respuesta — "la mano levantada". Es un BOTÓN: toca y
          el tablero muestra solo esos. Aparece en AMBAS vistas (antes solo en
          Tablero, así que en Lista la operadora no veía que un cliente escribió).
          Desde Lista lleva al Tablero ya filtrado, porque el filtro vive ahí.
          Un cero no se anuncia. Reforzado (pedido del dueño 25-ago): siempre en
          rojo, no en gris tenue — es lo más urgente que puede pasar.
          ⛔ El botón TAMBIÉN se dibuja si el filtro está prendido aunque el conteo
          sea 0 (trampa hallada 26-ago): si respondés a todos, la cuenta cae a 0,
          el botón desaparecía y `soloEsperando` seguía activo → tablero vacío
          "Sin pedidos" SIN forma de salir (persistía al recargar/cambiar tienda).
          Ahora siempre queda el escape "Ver todo". */}
      {(esperandoRespuesta.size > 0 || (viewMode === 'board' && soloEsperando)) && (
        <button
          type="button"
          onClick={() => {
            if (viewMode !== 'board') { setViewMode('board'); setSoloEsperando(true); return; }
            setSoloEsperando((v) => !v);
          }}
          aria-pressed={viewMode === 'board' && soloEsperando}
          title="Un cliente escribió por WhatsApp y su mensaje es el último del chat: nadie le respondió. Tocá para verlos."
          className={cn(
            // Chip compacto (26-ago-2026): era un banner de ancho completo con
            // border-2 y padding grande — el mayor foco de ruido rojo del tope.
            // Mismos tokens rojos, ahora inline y fino. Handlers/condición intactos.
            'mb-3 inline-flex items-center gap-2 rounded-xl border px-3 py-1.5 text-left transition-colors',
            viewMode === 'board' && soloEsperando
              ? 'bg-danger/20 border-danger/60 text-danger'
              : 'bg-danger/10 border-danger/40 text-foreground hover:bg-danger/15 hover:border-danger/60',
          )}
        >
          <span className="w-2 h-2 rounded-full bg-danger glow-danger shrink-0" aria-hidden="true" />
          <span className="font-mono tabular-nums text-sm font-bold text-danger">{esperandoRespuesta.size}</span>
          <span className="text-xs min-w-0 truncate font-medium">
            {esperandoRespuesta.size === 0
              ? 'Ya les respondiste a todos — quitá el filtro para ver el tablero'
              : `${esperandoRespuesta.size === 1 ? 'cliente te escribió' : 'clientes te escribieron'} y nadie les contestó`}
          </span>
          <span className="text-[11px] font-bold shrink-0 rounded-lg bg-danger/20 text-danger px-2 py-1">
            {viewMode !== 'board' ? 'Ir a verlos' : soloEsperando ? 'Ver todo' : 'Ver solo estos'}
          </span>
        </button>
      )}

      {viewMode === 'board' ? (
        <SegBoard
            avisosAgencia={avisosAgencia}
          actividadChat={chatActividad}
          data={boardDataMostrado}
          countryCode={activeStore?.country_code}
          statusFilter={statusFilter}
          // Para que "Gestioné hoy" sepa si el pedido YA se gestionó hoy: al
          // destildar "Ocultar gestionados" las tarjetas vuelven, y sin este set
          // el botón renacía como pendiente y permitía duplicar touchpoints.
          touchedTodayPhones={mySegTouchedToday}
          gestionEquipo={gestionSegPorTelefono}
          celebratory={allManagedToday}
          emptyTitle={allManagedToday ? '¡Todo gestionado hoy! ✓' : undefined}
          emptyDesc={allManagedToday
            ? 'Ya gestionaste todos los pedidos de hoy. Destildá "Ocultar gestionados" en el contador para verlos de nuevo, o vuelve mañana para el próximo ciclo.'
            : undefined}
        />
      ) : (
        <CrmTable
          data={displayDataMias}
          module="SEG"
          emptyIcon={<Truck size={28} className="text-muted-foreground" />}
          emptyTitle="Sin pedidos en seguimiento"
          emptyDesc="Los pedidos sincronizados desde Dropi aparecerán aquí organizados por estado."
          controlledStatusFilter={statusFilter}
          onControlledStatusFilterChange={setStatusFilter}
          // Vista del operador = tienda activa + Lista SLA + búsqueda. Al
          // cambiarla, la tabla se actualiza al instante (sin banner de "N
          // cambios"). storeId incluido: sin él, el cambio de tienda dejaba la
          // tabla y los chips congelados con la tienda ANTERIOR detrás del
          // banner (review 2026-07-07).
          viewKey={`${activeStoreId ?? ''}|${listaSlug ?? 'all'}|${search}`}
          onDataApplied={handleListDataApplied}
        />
      )}
    </div>
  );
}

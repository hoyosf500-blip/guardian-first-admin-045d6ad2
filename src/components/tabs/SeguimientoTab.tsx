import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useOrders } from '@/contexts/OrderContext';
import { useStore } from '@/contexts/StoreContext';
import { OrderData, isWithinLastDays, isClosedOutByCloser } from '@/lib/orderUtils';
import { matchesQuery } from '@/lib/textSearch';
import { useSessionState } from '@/hooks/useSessionState';
import { useSegClosedPhones } from '@/hooks/useSegClosedPhones';
import { useRefreshVisibleOrders } from '@/hooks/useRefreshVisibleOrders';
import { Truck, RefreshCw, Cloud, Package, AlertTriangle, MapPin, RotateCcw, Tag, DollarSign, CheckCircle, Layers, CalendarIcon, X, ChevronRight, ChevronDown, Filter, ExternalLink, LayoutGrid, List, Search } from 'lucide-react';
import { motion } from 'framer-motion';
import CrmTable from '@/components/CrmTable';
import { TiltCard, CountUp, GaugeRing } from '@/components/ui3d';
import SegBoard from '@/components/seguimiento/SegBoard';
import SegCounterBar from '@/components/SegCounterBar';
import WaInbox from '@/components/seguimiento/WaInbox';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import {
  SEG_LISTS,
  type SegListSlug,
  findSegList,
  isValidSegListSlug,
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
  // Cached in OrderContext so the data survives route unmounts when the
  // operator navigates between CRM tabs. Without the cache they'd see
  // "Cargando seguimiento..." and lose all filter/selection state every
  // time they switched tabs.
  const { segData, segLoaded, segLoading, segLastUpdate, loadSegData, mySegTouchedToday } = useOrders();
  // El cutoff de "muertos" depende del país de la tienda activa (EC cicla más
  // lento que CO). Patrón de CrmCallView: leer activeStore?.country_code.
  const { activeStore, activeStoreId } = useStore();
  const { refreshNow, isRefreshing: isSyncingDropi } = useRefreshVisibleOrders();
  // Pedidos que el equipo ya CERRÓ (Resuelto/Devolución) → salen para siempre de
  // Seguimiento. Team-wide (set de phones de la tienda activa). Ver hook.
  const segClosedPhones = useSegClosedPhones(activeStoreId);

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
  const [showStatusSummary, setShowStatusSummary] = useSessionState<boolean>('seg:showStatusSummary', false);
  // Owns the status filter so the stat cards act as the single source of truth
  // (no duplicate pill row below).
  const [statusFilter, setStatusFilter] = useSessionState<string | null>('seg:statusFilter', null);
  // Contador diario: por defecto OCULTAMOS del tablero los pedidos que YO ya
  // gestioné hoy (touchpoint SEG:* → mySegTouchedToday, set de phones del
  // OrderContext). Al gestionar un pedido (Contactado/Llamé/WhatsApp/… desde la
  // ficha o la lista) desaparece del tablero y "Te faltan N" baja, igual que la
  // cola de Confirmar. Key :v2 para activar el nuevo default aunque hubiera un
  // `false` viejo guardado. La LISTA (CrmTable) ya tiene su propio ocultado de
  // gestionados, por eso este filtro aplica al TABLERO.
  const [onlyUntouchedSeg, setOnlyUntouchedSeg] = useSessionState<boolean>('seg:autoHide:v2', true);
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
  const boardData = useMemo(() => {
    if (!onlyUntouchedSeg) return displayData;
    return displayData.filter((o) => !o.phone || !mySegTouchedToday.has(o.phone));
  }, [displayData, onlyUntouchedSeg, mySegTouchedToday]);

  // ¿El tablero quedó vacío SOLO porque ocultamos los gestionados de hoy? (hay
  // pedidos en el feed pero todos están gestionados). Para mostrar un vacío
  // celebratorio en vez de "Sin pedidos".
  const allManagedToday = onlyUntouchedSeg && boardData.length === 0 && displayData.length > 0;

  const stats = useMemo(() => {
    const s = {
      procesamiento: 0, guia: 0, bodega_trans: 0, transito: 0, reparto: 0,
      novedad: 0, novedad_sol: 0, oficina: 0, rechazado: 0,
      devolucion_transito: 0, devolucion: 0, indemnizada: 0,
      entregado: 0, cancelado: 0, otros: 0,
      total: dedupedByDate.length,
    };
    dedupedByDate.forEach(o => {
      // classifySegEstado vive en src/lib/segStatus.ts — mismo clasificador
      // que CrmTable (sin esto, el resumen perdía estados EC y mostraba 3 cards
      // mientras el Kanban abajo mostraba 5+ columnas reales).
      const cat = classifySegEstado(o.estado);
      if (cat in s) (s as Record<string, number>)[cat]++;
    });
    return s;
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

  /**
   * Unified stat tone system — same 5 tones as CrmTable so the app reads as one
   * palette. Amber is reserved for the hot path ("En Reparto"); semantic tones
   * only apply where they carry real meaning (success/warning/danger).
   */
  type StatTone = 'neutral' | 'accent' | 'warning' | 'danger' | 'success' | 'muted';
  /**
   * Cada tono usa tokens semánticos del DS (success/danger/warning/
   * accent) — coherentes con dark/light mode automático. El active
   * state suma ring + bg tonal sin sombras pesadas (look más limpio).
   *
   * El chip de ícono usa la fórmula INVARIABLE del lenguaje del Dashboard
   * (fondo /14 · borde /30 · texto pleno · clase glow-<tono>), que es la firma
   * visual de todo KPI de la app. Antes cada tono llevaba su propio alpha
   * (accent/15, warning/12, muted/40) y ningún chip tenía glow: el resumen por
   * estado parecía de otra aplicación que el resto del CRM.
   *
   * `numGlow` solo se declara donde index.css define el token
   * (accent/success/danger). Para warning/neutral/muted va vacío en vez de
   * inventar una clase que no existe.
   */
  const STAT_TONE: Record<StatTone, {
    iconBg: string; iconText: string; glow: string;
    numberColor: string; numGlow: string; cardHover: string;
    activeRing: string; activeBg: string;
  }> = {
    neutral: {
      iconBg: 'bg-muted/60 border-border', iconText: 'text-muted-foreground', glow: '',
      numberColor: 'text-foreground', numGlow: '',
      cardHover: 'hover:border-border-strong hover:bg-muted/20',
      activeRing: 'ring-2 ring-accent/60 border-accent/60',
      activeBg: 'bg-accent/5',
    },
    accent: {
      iconBg: 'bg-accent/14 border-accent/30', iconText: 'text-accent', glow: 'glow-accent',
      numberColor: 'text-accent', numGlow: 'num-glow-accent',
      cardHover: 'hover:border-accent/40 hover:bg-accent/8',
      activeRing: 'ring-2 ring-accent border-accent',
      activeBg: 'bg-accent/12',
    },
    warning: {
      iconBg: 'bg-warning/14 border-warning/30', iconText: 'text-warning', glow: 'glow-warning',
      numberColor: 'text-warning', numGlow: '',
      cardHover: 'hover:border-warning/40 hover:bg-warning/5',
      activeRing: 'ring-2 ring-warning/70 border-warning/70',
      activeBg: 'bg-warning/10',
    },
    danger: {
      iconBg: 'bg-danger/14 border-danger/30', iconText: 'text-danger', glow: 'glow-danger',
      numberColor: 'text-danger', numGlow: 'num-glow-danger',
      cardHover: 'hover:border-danger/40 hover:bg-danger/5',
      activeRing: 'ring-2 ring-danger/70 border-danger/70',
      activeBg: 'bg-danger/10',
    },
    success: {
      iconBg: 'bg-success/14 border-success/30', iconText: 'text-success', glow: 'glow-success',
      numberColor: 'text-success', numGlow: 'num-glow-success',
      cardHover: 'hover:border-success/40 hover:bg-success/5',
      activeRing: 'ring-2 ring-success/70 border-success/70',
      activeBg: 'bg-success/10',
    },
    muted: {
      iconBg: 'bg-muted/60 border-border', iconText: 'text-muted-foreground', glow: '',
      numberColor: 'text-muted-foreground', numGlow: '',
      cardHover: 'hover:border-border-strong hover:text-foreground',
      activeRing: 'ring-2 ring-border-strong border-border-strong',
      activeBg: 'bg-muted/30',
    },
  };

  // `key` matches CrmTable.STATUS_COLUMNS[*].key so clicking a card drives the
  // table filter without translation.
  const statCards: { key: string; label: string; value: number; icon: React.ReactNode; tone: StatTone }[] = [
    { key: 'procesamiento', label: 'En Procesamiento', value: stats.procesamiento, icon: <Package size={15} />, tone: 'neutral' },
    { key: 'guia', label: 'Guía Generada', value: stats.guia, icon: <Tag size={15} />, tone: 'neutral' },
    { key: 'bodega_trans', label: 'Bodega Transp.', value: stats.bodega_trans, icon: <Package size={15} />, tone: 'neutral' },
    { key: 'transito', label: 'En Tránsito', value: stats.transito, icon: <Truck size={15} />, tone: 'neutral' },
    { key: 'reparto', label: 'En Reparto', value: stats.reparto, icon: <Truck size={15} />, tone: 'accent' },
    { key: 'novedad', label: 'Novedad', value: stats.novedad, icon: <AlertTriangle size={15} />, tone: 'warning' },
    { key: 'novedad_sol', label: 'Nov. Solucionada', value: stats.novedad_sol, icon: <CheckCircle size={15} />, tone: 'success' },
    { key: 'oficina', label: 'En Oficina', value: stats.oficina, icon: <MapPin size={15} />, tone: 'warning' },
    { key: 'rechazado', label: 'Rechazado', value: stats.rechazado, icon: <AlertTriangle size={15} />, tone: 'danger' },
    { key: 'devolucion_transito', label: 'Dev. en Tránsito', value: stats.devolucion_transito, icon: <RotateCcw size={15} />, tone: 'danger' },
    { key: 'devolucion', label: 'Devolución', value: stats.devolucion, icon: <RotateCcw size={15} />, tone: 'danger' },
    { key: 'indemnizada', label: 'Indemnizada', value: stats.indemnizada, icon: <DollarSign size={15} />, tone: 'muted' },
    { key: 'entregado', label: 'Entregado', value: stats.entregado, icon: <CheckCircle size={15} />, tone: 'success' },
    { key: 'cancelado', label: 'Cancelado', value: stats.cancelado, icon: <Layers size={15} />, tone: 'muted' },
  ];

  // Fullscreen loading only on the very first fetch. On subsequent refreshes
  // the existing data stays on screen and the Actualizar button shows the
  // spinner instead — no flash, no lost state.
  if (!segLoaded && segLoading) {
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
      <div className="mb-6 space-y-4">
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
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0 space-y-1.5">
              <div className="hud-label whitespace-nowrap truncate mb-1">
                CRM · Operadora
              </div>
              <h1 className="text-2xl font-bold tracking-tight text-foreground leading-none flex items-center gap-3">
                <span className="w-11 h-11 rounded-2xl bg-accent/14 border border-accent/30 text-accent glow-accent flex items-center justify-center shrink-0" aria-hidden="true">
                  <Truck size={20} strokeWidth={2.25} />
                </span>
                Seguimiento
              </h1>
              <p className="text-sm text-muted-foreground">
                Pedidos en ruta — todos los estados de Dropi sincronizados.
              </p>
            </div>
            {segLastUpdate && (
              <span className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-card/40 border border-border shadow-card3d text-xs text-muted-foreground shrink-0 self-start sm:self-end">
                <span className="w-2 h-2 rounded-full bg-success glow-success motion-safe:animate-gb-pulse" aria-hidden="true" />
                <span className="font-mono tabular-nums">
                  {segLastUpdate.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })}
                </span>
              </span>
            )}
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
            {/* Date range filter */}
            <div className={cn(
              "flex items-center gap-2 rounded-xl px-2 py-1 transition-colors",
              (dateFrom || dateTo)
                ? "bg-accent/10 border border-accent/40 shadow-glow3d"
                : "bg-card/40 border border-border hover:border-border-strong"
            )}>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="sm" className={cn(
                    "h-11 gap-1.5 text-[11px] font-normal px-2",
                    !dateFrom && "text-muted-foreground"
                  )}>
                    <CalendarIcon size={12} />
                    {dateFrom ? format(new Date(dateFrom + 'T12:00:00'), 'dd MMM', { locale: es }) : 'Desde'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="end">
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
                  <Button variant="ghost" size="sm" className={cn(
                    "h-11 gap-1.5 text-[11px] font-normal px-2",
                    !dateTo && "text-muted-foreground"
                  )}>
                    <CalendarIcon size={12} />
                    {dateTo ? format(new Date(dateTo + 'T12:00:00'), 'dd MMM', { locale: es }) : 'Hasta'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="end">
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
                  aria-label="Quitar filtro de fechas"
                  className="h-11 w-11 p-0 text-muted-foreground hover:text-foreground">
                  <X size={13} aria-hidden="true" />
                </Button>
              )}
            </div>

            {/* NIVEL 3 — Acciones de datos, empujadas al extremo con ml-auto
                para que no compitan con los filtros. Se conservan los DOS
                botones (y por lo tanto los dos indicadores de carga): isSyncing-
                Dropi y segLoading son estados independientes, y fusionarlos
                dejaría a la asesora sin saber cuál de los dos corrió. */}
            <div className="flex items-center gap-2 flex-wrap sm:ml-auto">
              <WaInbox storeId={activeStoreId} />
              {/* Sincronizar EN VIVO con Dropi: trae el estado REAL de los pedidos
                  visibles ahora (vs "Actualizar" que solo re-lee la base). */}
              <button
                onClick={() => refreshNow(activeStoreId, { force: true })}
                disabled={isSyncingDropi}
                title="Trae el estado real de Dropi de los pedidos recientes ahora mismo"
                className="btn-accent-3d inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold disabled:opacity-50 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
              >
                <Cloud size={14} className={isSyncingDropi ? 'animate-pulse' : ''} aria-hidden="true" />
                <span className="hidden sm:inline">{isSyncingDropi ? 'Sincronizando...' : 'Sincronizar Dropi'}</span>
              </button>
              <button
                onClick={() => loadSegData(true)}
                disabled={segLoading}
                className="inline-flex items-center gap-2 rounded-xl border border-border bg-card/40 px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:border-border-strong transition-colors duration-200 disabled:opacity-50 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
              >
                <RefreshCw size={14} className={segLoading ? 'animate-spin' : ''} aria-hidden="true" />
                <span className="hidden sm:inline">{segLoading ? 'Actualizando...' : 'Actualizar'}</span>
              </button>
            </div>
          </div>
        </motion.header>

        {/* ─────────────────────────────────────────────────────────────
            HERO — "cómo voy hoy" antes que cualquier filtro.
            El contador diario vivía ENTERRADO debajo de los chips y del
            resumen por estado, aunque es la única pieza que ya usaba
            TiltCard+CountUp (el hero del Dashboard). Sube arriba del todo y
            toma el molde completo: aro con el % del día (el pct ya estaba
            calculado, solo no se dibujaba) + la cifra contando + la barra de
            meta. Al lado, el Total con anatomía de StatTile.
            ───────────────────────────────────────────────────────────── */}
        {(() => {
          // En vista Lista, el contador usa el snapshot congelado (chipsBase) para
          // no contradecir a la tabla bufferizada; en Tablero, la data en vivo.
          const counterSource = viewMode === 'list' ? chipsBase : dedupedByDate;
          const feedBase = listaActiva && !listaActiva.externalRoute
            ? counterSource.filter((o) => listaActiva.matches(o))
            : counterSource;
          const total = feedBase.length;
          // Se conserva EXACTA la condición original (`total === 0` → sin hero):
          // no se inventa un estado vacío que afirme algo que no se midió.
          const heroVisible = total > 0;
          const gestionados = feedBase.filter(o => o.phone && mySegTouchedToday.has(o.phone)).length;
          const faltan = Math.max(0, total - gestionados);
          const pct = total > 0 ? Math.round((gestionados / total) * 100) : 0;
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
            <motion.div {...fadeUp(0.05)} className="grid grid-cols-1 md:grid-cols-12 gap-4">
              {heroVisible && (
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
                            ? '¡Todo gestionado hoy! ✓'
                            : `${faltan === 1 ? 'pedido' : 'pedidos'} por gestionar${listaActiva && !listaActiva.externalRoute ? ' en esta lista' : ''} hoy`}
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground flex items-baseline gap-x-1.5 flex-wrap">
                        <span>Gestionados</span>
                        <strong className="font-mono tabular-nums text-foreground">{gestionados}</strong>
                        <span>de</span>
                        <strong className="font-mono tabular-nums text-foreground">{total}</strong>
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
                  <span className="w-9 h-9 rounded-xl border flex items-center justify-center flex-shrink-0 bg-accent/14 border-accent/30 text-accent glow-accent">
                    <Package size={17} aria-hidden="true" />
                  </span>
                  {(dateFrom || dateTo) && stats.total !== segData.length && (
                    <span className="text-[11px] font-medium text-muted-foreground font-mono tabular-nums">
                      / {segData.length}
                    </span>
                  )}
                </div>
                {/* Cifra deliberadamente MÁS CHICA que la del hero. Las dos son
                    grandes, adyacentes y de alcance distinto: el hero cuenta la
                    LISTA SLA activa (feedBase) y este Total cuenta todo lo
                    cargado (dedupedByDate). A igual peso tipográfico se leían
                    como la misma métrica y "no cuadraban". El hero es el
                    protagonista; este es contexto. */}
                <div className="text-2xl font-bold leading-none mt-3 text-accent tilt-layer-3">
                  <CountUp value={stats.total} />
                </div>
                <div className="hud-label text-subtle mt-2 tilt-layer-1">Total</div>
                {(hiddenStaleCount > 0 || hiddenSupersededCount > 0 || hiddenClosedCount > 0) && (
                  <div className="mt-3 pt-3 border-t border-border/50 flex flex-col gap-1 tilt-layer-1">
                    {hiddenStaleCount > 0 && (
                      <span
                        className="text-[11px] text-muted-foreground font-mono tabular-nums"
                        title={`${hiddenStaleCount} pedidos con más de ${DEFAULT_WINDOW_DAYS} días (fuera de la ventana por defecto de los últimos ${DEFAULT_WINDOW_DAYS} días). No se borraron — vé el histórico completo poniendo un rango de fechas.`}
                      >
                        · {hiddenStaleCount} viejos ocultos
                      </span>
                    )}
                    {hiddenSupersededCount > 0 && (
                      <span
                        className="text-[11px] text-warning font-mono tabular-nums"
                        title={`${hiddenSupersededCount} pedido${hiddenSupersededCount > 1 ? 's' : ''} reemplazados por Dropi (mismo cliente + producto, nueva versión más reciente). Se ocultan para no duplicar la cola — el más reciente sí aparece.`}
                      >
                        · {hiddenSupersededCount} reemplazados Dropi
                      </span>
                    )}
                    {hiddenClosedCount > 0 && (
                      <span
                        className="text-[11px] text-muted-foreground font-mono tabular-nums"
                        title={`${hiddenClosedCount} pedido${hiddenClosedCount > 1 ? 's' : ''} cerrados (Resuelto/Devolución) ocultos. No se borraron — aparecen en el histórico con un rango de fechas más amplio.`}
                      >
                        · {hiddenClosedCount} resueltos/devueltos ocultos
                      </span>
                    )}
                  </div>
                )}
              </TiltCard>
            </motion.div>
          );
        })()}

        {/* Listas de trabajo (SLA) — forma PRINCIPAL de priorizar. Reemplaza
            al viejo dropdown + banner de atrasados: una sola fila de chips
            ordenados por urgencia, con conteo y un "Sugerido" hacia dónde
            empezar. Solo se muestran las listas con pedidos (+ las que linkean
            a otra ruta, ej. confirmación). */}
        <motion.div {...fadeUp(0.12)} className="space-y-2">
          <div className="flex items-center gap-1.5 hud-label">
            <Filter size={12} aria-hidden="true" /> Listas de trabajo
          </div>
          {/* En mobile, las 8 listas apiladas (flex-wrap) ocupaban ~250px
              verticales antes del dato. Ahora un carrusel horizontal con snap
              (shrink-0 + overflow-x-auto + snap-x): 1 fila scrolleable
              lateralmente. En sm+ vuelve a flex-wrap (espacio sobra). */}
          <div className="flex gap-2 overflow-x-auto snap-x snap-mandatory pb-1 -mx-1 px-1 sm:overflow-visible sm:flex-wrap sm:mx-0 sm:px-0 sm:pb-0 [scrollbar-width:thin]">
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
            {SEG_LISTS
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

        {/* Resumen por estado — vista SECUNDARIA, colapsada por defecto. Las
            listas de trabajo (arriba) son la forma principal de priorizar;
            estas tarjetas quedan como desglose opcional por estado. Siguen
            siendo filtros clicables al expandirse. */}
        <div>
          <button
            type="button"
            onClick={() => setShowStatusSummary(v => !v)}
            aria-expanded={showStatusSummary}
            className="inline-flex items-center gap-1.5 rounded-xl bg-card/40 border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:border-border-strong transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          >
            <ChevronDown size={13} className={cn("transition-transform", showStatusSummary && "rotate-180")} aria-hidden="true" />
            {showStatusSummary ? 'Ocultar resumen por estado' : 'Ver resumen por estado'}
            {statusFilter && !showStatusSummary && (
              <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-accent">filtro activo</span>
            )}
          </button>
        </div>
        {showStatusSummary && (
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7 gap-2">
          {statCards.filter(c => c.value > 0).map((card, i) => {
            const t = STAT_TONE[card.tone];
            const isActive = statusFilter === card.key;
            return (
              <motion.button
                key={card.key}
                type="button"
                aria-pressed={isActive}
                aria-label={`Filtrar por ${card.label}: ${card.value} pedidos`}
                onClick={() => setStatusFilter(isActive ? null : card.key)}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.05 + i * 0.04, duration: 0.25 }}
                whileTap={{ scale: 0.97 }}
                className={`group relative bg-card/40 border rounded-2xl p-4 flex flex-col items-start shadow-card3d hairline-top transition-all duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background text-left ${
                  isActive
                    ? `${t.activeRing} ${t.activeBg}`
                    : `border-border ${t.cardHover}`
                }`}
              >
                {/* Anatomía de StatTile: chip de ícono 36px con la fórmula de
                    glow del lenguaje · cifra contando en el color del tono ·
                    rótulo BAJO la cifra (nunca encima). Antes era chip plano +
                    número estático centrado: la misma información dibujada sin
                    ninguna de las señales del Dashboard. */}
                <span className={`w-9 h-9 rounded-xl border flex items-center justify-center flex-shrink-0 transition-transform duration-200 group-hover:scale-110 ${t.iconBg} ${t.iconText} ${t.glow}`}>
                  {card.icon}
                </span>
                <span className={`font-mono text-[26px] font-bold leading-none tabular-nums mt-3 ${t.numberColor} ${t.numGlow}`}>
                  <CountUp value={card.value} />
                </span>
                <span className={`hud-label leading-tight mt-2 ${
                  isActive ? t.numberColor : 'text-subtle'
                }`}>
                  {card.label}
                </span>
              </motion.button>
            );
          })}
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
          className="mb-4 rounded-2xl border border-accent/30 bg-card/40 p-4 shadow-card3d flex items-center justify-between gap-4"
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-11 h-11 rounded-2xl bg-accent/14 border border-accent/30 text-accent glow-accent flex items-center justify-center shrink-0">
              <ExternalLink size={18} className="text-accent" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-bold text-foreground">{listaActiva.label}</div>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Esta lista vive en {listaActiva.externalRoute} — los pedidos pendientes de confirmación se gestionan desde la cola de llamadas.
              </p>
            </div>
          </div>
          <Link
            to={listaActiva.externalRoute}
            className="btn-accent-3d inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold no-underline shrink-0"
          >
            Ir a {listaActiva.externalRoute}
            <ChevronRight size={14} aria-hidden="true" />
          </Link>
        </motion.div>
      )}

      {/* El contador diario ("Te faltan N") ya NO vive acá: subió al hero, junto
          al título, para que la asesora vea "cómo voy hoy" ANTES de cualquier
          filtro — igual que el aro de confirmación del Dashboard. Misma fuente
          (chipsBase en Lista / dedupedByDate en Tablero), misma fórmula. */}

      {viewMode === 'board' ? (
        <SegBoard
          data={boardData}
          countryCode={activeStore?.country_code}
          statusFilter={statusFilter}
          celebratory={allManagedToday}
          emptyTitle={allManagedToday ? '¡Todo gestionado hoy! ✓' : undefined}
          emptyDesc={allManagedToday
            ? 'Ya gestionaste todos los pedidos de hoy. Destildá "Ocultar gestionados" en el contador para verlos de nuevo, o vuelve mañana para el próximo ciclo.'
            : undefined}
        />
      ) : (
        <CrmTable
          data={displayData}
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

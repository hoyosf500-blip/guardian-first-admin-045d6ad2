import { useEffect, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useOrders } from '@/contexts/OrderContext';
import { useStore } from '@/contexts/StoreContext';
import { OrderData, isWithinLastDays, isClosedOutByCloser } from '@/lib/orderUtils';
import { useSessionState } from '@/hooks/useSessionState';
import { useSegClosedPhones } from '@/hooks/useSegClosedPhones';
import { useRefreshVisibleOrders } from '@/hooks/useRefreshVisibleOrders';
import { Truck, RefreshCw, Cloud, Package, AlertTriangle, MapPin, RotateCcw, Tag, DollarSign, CheckCircle, Layers, CalendarIcon, X, ChevronRight, ChevronDown, Filter, ExternalLink, LayoutGrid, List } from 'lucide-react';
import { motion } from 'framer-motion';
import CrmTable from '@/components/CrmTable';
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
  danger: 'bg-danger',
  warning: 'bg-warning',
  success: 'bg-success',
  info: 'bg-info',
  neutral: 'bg-muted-foreground/50',
};

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
        (o) => !isClosedOutByCloser(o.fecha, o.phone ? segClosedPhones.get(o.phone) : undefined),
      );
    },
    [filteredByDate, supersededIds, segClosedPhones],
  );
  const hiddenSupersededCount = supersededIds.size;
  const hiddenClosedCount = useMemo(
    () => filteredByDate.filter(o =>
      !supersededIds.has(String(o.externalId ?? '')) &&
      isClosedOutByCloser(o.fecha, o.phone ? segClosedPhones.get(o.phone) : undefined),
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
    return listaActiva && !listaActiva.externalRoute ? filteredByList : dedupedByDate;
  }, [listaActiva, filteredByList, dedupedByDate]);

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

  // Conteo por lista SLA (sobre los pedidos ya filtrados por fecha + deduped).
  // Alimenta los chips de listas — la forma principal de priorizar. Las
  // listas con externalRoute (ej. confirmación) no se cuentan acá: viven en
  // otra ruta.
  const listCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const l of SEG_LISTS) {
      counts[l.slug] = l.externalRoute ? 0 : dedupedByDate.filter(l.matches).length;
    }
    return counts;
  }, [dedupedByDate]);

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
   */
  const STAT_TONE: Record<StatTone, {
    iconBg: string; iconText: string;
    numberColor: string; cardHover: string;
    activeRing: string; activeBg: string;
  }> = {
    neutral: {
      iconBg: 'bg-muted/40', iconText: 'text-muted-foreground',
      numberColor: 'text-foreground',
      cardHover: 'hover:border-border-strong hover:bg-muted/20',
      activeRing: 'ring-2 ring-accent/60 border-accent/60',
      activeBg: 'bg-accent/5',
    },
    accent: {
      iconBg: 'bg-accent/15', iconText: 'text-accent',
      numberColor: 'text-accent',
      cardHover: 'hover:border-accent/40 hover:bg-accent/8',
      activeRing: 'ring-2 ring-accent border-accent',
      activeBg: 'bg-accent/12',
    },
    warning: {
      iconBg: 'bg-warning/12', iconText: 'text-warning',
      numberColor: 'text-warning',
      cardHover: 'hover:border-warning/40 hover:bg-warning/5',
      activeRing: 'ring-2 ring-warning/70 border-warning/70',
      activeBg: 'bg-warning/10',
    },
    danger: {
      iconBg: 'bg-danger/12', iconText: 'text-danger',
      numberColor: 'text-danger',
      cardHover: 'hover:border-danger/40 hover:bg-danger/5',
      activeRing: 'ring-2 ring-danger/70 border-danger/70',
      activeBg: 'bg-danger/10',
    },
    success: {
      iconBg: 'bg-success/12', iconText: 'text-success',
      numberColor: 'text-success',
      cardHover: 'hover:border-success/40 hover:bg-success/5',
      activeRing: 'ring-2 ring-success/70 border-success/70',
      activeBg: 'bg-success/10',
    },
    muted: {
      iconBg: 'bg-muted/40', iconText: 'text-muted-foreground',
      numberColor: 'text-muted-foreground',
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
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col items-center justify-center py-16 gap-4" role="status" aria-live="polite">
          <RefreshCw size={32} className="text-accent animate-spin" aria-hidden="true" />
          <div className="text-center">
            <p className="text-sm font-semibold text-foreground">Cargando seguimiento...</p>
            <p className="text-xs text-muted-foreground mt-1">Recuperando pedidos desde la base de datos</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto">
      <SegCounterBar />
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="mb-6 space-y-4"
      >
        <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0 space-y-1.5">
            <div className="text-[11px] uppercase tracking-[0.12em] font-semibold text-muted-foreground">
              CRM · Operadora
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground leading-none flex items-center gap-2.5">
              <Truck size={22} className="text-accent" aria-hidden="true" strokeWidth={2.25} />
              Seguimiento
            </h1>
            <p className="text-sm text-muted-foreground">
              Pedidos en ruta — todos los estados de Dropi sincronizados.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap shrink-0">
            {/* Toggle de vista: Tablero (Kommo, en vivo) ↔ Lista (CrmTable) */}
            <div className="inline-flex rounded-lg border border-border bg-surface p-0.5">
              <button
                type="button"
                onClick={() => setViewMode('board')}
                aria-pressed={viewMode === 'board'}
                className={cn(
                  'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold transition-colors',
                  viewMode === 'board' ? 'bg-accent text-accent-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <LayoutGrid size={13} aria-hidden="true" /> Tablero
              </button>
              <button
                type="button"
                onClick={() => setViewMode('list')}
                aria-pressed={viewMode === 'list'}
                className={cn(
                  'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold transition-colors',
                  viewMode === 'list' ? 'bg-accent text-accent-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <List size={13} aria-hidden="true" /> Lista
              </button>
            </div>
            {/* Date range filter */}
            <div className={cn(
              "flex items-center gap-1.5 rounded-xl px-2 py-1 transition-colors",
              (dateFrom || dateTo)
                ? "bg-primary/10 border border-primary/30 ring-1 ring-primary/20"
                : "bg-card border border-border"
            )}>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="sm" className={cn(
                    "h-7 gap-1.5 text-[11px] font-normal px-2",
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
                    "h-7 gap-1.5 text-[11px] font-normal px-2",
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
                  className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground">
                  <X size={13} />
                </Button>
              )}
            </div>

            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
              <Package size={13} className="text-muted-foreground" aria-hidden="true" />
              <span className="text-xs text-muted-foreground">Total</span>
              <span className="text-sm font-semibold text-foreground font-mono tabular-nums">{stats.total}</span>
              {(dateFrom || dateTo) && stats.total !== segData.length && (
                <span className="text-[10px] text-muted-foreground/70 font-mono">/ {segData.length}</span>
              )}
              {hiddenStaleCount > 0 && (
                <span
                  className="text-[10px] text-muted-foreground/70 font-mono"
                  title={`${hiddenStaleCount} pedidos con más de ${DEFAULT_WINDOW_DAYS} días (fuera de la ventana por defecto de los últimos ${DEFAULT_WINDOW_DAYS} días). No se borraron — vé el histórico completo poniendo un rango de fechas.`}
                >
                  · {hiddenStaleCount} viejos ocultos
                </span>
              )}
              {hiddenSupersededCount > 0 && (
                <span
                  className="text-[10px] text-warning/80 font-mono"
                  title={`${hiddenSupersededCount} pedido${hiddenSupersededCount > 1 ? 's' : ''} reemplazados por Dropi (mismo cliente + producto, nueva versión más reciente). Se ocultan para no duplicar la cola — el más reciente sí aparece.`}
                >
                  · {hiddenSupersededCount} reemplazados Dropi
                </span>
              )}
              {hiddenClosedCount > 0 && (
                <span
                  className="text-[10px] text-muted-foreground/70 font-mono"
                  title={`${hiddenClosedCount} pedido${hiddenClosedCount > 1 ? 's' : ''} cerrados (Resuelto/Devolución) ocultos. No se borraron — aparecen en el histórico con un rango de fechas más amplio.`}
                >
                  · {hiddenClosedCount} resueltos/devueltos ocultos
                </span>
              )}
            </div>
            <WaInbox storeId={activeStoreId} />
            {/* Sincronizar EN VIVO con Dropi: trae el estado REAL de los pedidos
                visibles ahora (vs "Actualizar" que solo re-lee la base). */}
            <button
              onClick={() => refreshNow(activeStoreId, { force: true })}
              disabled={isSyncingDropi}
              title="Trae el estado real de Dropi de los pedidos recientes ahora mismo"
              className="inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-accent-foreground hover:bg-accent/90 transition-colors duration-200 disabled:opacity-50 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
            >
              <Cloud size={14} className={isSyncingDropi ? 'animate-pulse' : ''} aria-hidden="true" />
              <span className="hidden sm:inline">{isSyncingDropi ? 'Sincronizando...' : 'Sincronizar Dropi'}</span>
            </button>
            <button
              onClick={() => loadSegData(true)}
              disabled={segLoading}
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm font-semibold text-foreground hover:bg-card hover:border-border-strong transition-colors duration-200 disabled:opacity-50 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
            >
              <RefreshCw size={14} className={segLoading ? 'animate-spin' : ''} aria-hidden="true" />
              <span className="hidden sm:inline">{segLoading ? 'Actualizando...' : 'Actualizar'}</span>
            </button>
            {segLastUpdate && (
              <span className="text-[11px] text-muted-foreground tabular-nums hidden md:inline">
                {segLastUpdate.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </div>
        </header>

        {/* Listas de trabajo (SLA) — forma PRINCIPAL de priorizar. Reemplaza
            al viejo dropdown + banner de atrasados: una sola fila de chips
            ordenados por urgencia, con conteo y un "Sugerido" hacia dónde
            empezar. Solo se muestran las listas con pedidos (+ las que linkean
            a otra ruta, ej. confirmación). */}
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
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
                "snap-start shrink-0 inline-flex items-center gap-2 rounded-xl border px-3 min-h-[36px] text-[12px] font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                !listaSlug
                  ? "bg-accent text-accent-foreground border-accent shadow-sm"
                  : "bg-card border-border text-foreground hover:border-border-strong"
              )}
            >
              Todas
              <span className="font-mono tabular-nums text-[11px] opacity-80">{dedupedByDate.length}</span>
            </button>
            {SEG_LISTS
              .filter((l) => l.externalRoute || (listCounts[l.slug] ?? 0) > 0)
              .map((l) => {
                const active = listaSlug === l.slug;
                const count = listCounts[l.slug] ?? 0;
                const suggested = l.slug === suggestedSlug;
                return (
                  <button
                    key={l.slug}
                    type="button"
                    onClick={() => setListaSlug(active ? null : l.slug)}
                    aria-pressed={active}
                    title={l.label}
                    className={cn(
                      "snap-start shrink-0 inline-flex items-center gap-2 rounded-xl border px-3 min-h-[36px] text-[12px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                      active
                        ? "bg-accent text-accent-foreground border-accent shadow-sm"
                        : "bg-card border-border text-foreground hover:border-border-strong"
                    )}
                  >
                    {l.externalRoute
                      ? <ExternalLink size={12} className={active ? '' : 'text-muted-foreground'} aria-hidden="true" />
                      : <span className={cn("w-1.5 h-1.5 rounded-full", active ? "bg-accent-foreground" : LIST_TONE_DOT[l.tone])} aria-hidden="true" />}
                    <span className="truncate max-w-[15rem]">{l.label}</span>
                    {!l.externalRoute && (
                      <span className="font-mono tabular-nums text-[11px] opacity-80">{count}</span>
                    )}
                    {suggested && !active && (
                      <span className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-danger/15 text-danger border border-danger/30">
                        Sugerido
                      </span>
                    )}
                  </button>
                );
              })}
          </div>
        </div>

        {/* Resumen por estado — vista SECUNDARIA, colapsada por defecto. Las
            listas de trabajo (arriba) son la forma principal de priorizar;
            estas tarjetas quedan como desglose opcional por estado. Siguen
            siendo filtros clicables al expandirse. */}
        <div>
          <button
            type="button"
            onClick={() => setShowStatusSummary(v => !v)}
            aria-expanded={showStatusSummary}
            className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground hover:text-foreground transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none rounded"
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
                className={`group relative bg-surface border rounded-xl px-3 py-2.5 flex flex-col items-center gap-1.5 transition-all duration-200 cursor-pointer focus-visible:outline-none text-center ${
                  isActive
                    ? `${t.activeRing} ${t.activeBg}`
                    : `border-border ${t.cardHover}`
                }`}
              >
                <div className={`w-9 h-9 rounded-lg flex items-center justify-center transition-transform duration-200 group-hover:scale-110 ${t.iconBg} ${t.iconText}`}>
                  {card.icon}
                </div>
                <span className={`font-mono text-xl font-bold leading-none tabular-nums ${isActive ? t.numberColor : 'text-foreground'}`}>
                  {card.value}
                </span>
                <span className={`text-[9px] font-semibold text-center leading-tight uppercase tracking-wider ${
                  isActive ? t.numberColor : 'text-muted-foreground'
                }`}>
                  {card.label}
                </span>
              </motion.button>
            );
          })}
        </div>
        )}
      </motion.div>

      {/* Banner solo para listas que viven en OTRA ruta (ej. confirmación).
          Las demás listas ya muestran su estado activo + conteo en los chips
          de arriba, así que no necesitan banner aparte. */}
      {listaActiva?.externalRoute && (
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          className="mb-4 rounded-xl border border-accent/30 bg-accent/5 p-4 flex items-center justify-between gap-4"
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-md bg-accent/15 ring-1 ring-accent/30 flex items-center justify-center shrink-0">
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
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-accent-foreground hover:bg-accent/90 transition-colors shrink-0"
          >
            Ir a {listaActiva.externalRoute}
            <ChevronRight size={14} aria-hidden="true" />
          </Link>
        </motion.div>
      )}

      {/* Contador diario de seguimiento — análogo a la cola de Confirmar. "Te
          faltan N" es el número grande que BAJA a medida que la operadora
          gestiona pedidos (touchpoint SEG:* → mySegTouchedToday, por phone, mismo
          patrón que classifySegOwnershipFromTps en segOwnership.ts). Con "Ocultar
          gestionados" (default), cada pedido gestionado desaparece del tablero. */}
      {(() => {
        const feedBase = listaActiva && !listaActiva.externalRoute ? filteredByList : dedupedByDate;
        const total = feedBase.length;
        if (total === 0) return null;
        const gestionados = feedBase.filter(o => o.phone && mySegTouchedToday.has(o.phone)).length;
        const faltan = Math.max(0, total - gestionados);
        const pct = total > 0 ? Math.round((gestionados / total) * 100) : 0;
        const done = faltan === 0;
        const tone = done
          ? 'success'
          : faltan >= Math.max(1, Math.ceil(total / 2)) ? 'danger' : 'warning';
        const borderTone = tone === 'success' ? 'border-success/30' : tone === 'warning' ? 'border-warning/30' : 'border-danger/30';
        const bgTone = tone === 'success' ? 'bg-success/5' : tone === 'warning' ? 'bg-warning/5' : 'bg-danger/5';
        const barTone = tone === 'success' ? 'bg-success' : tone === 'warning' ? 'bg-warning' : 'bg-danger';
        const faltanTone = tone === 'success' ? 'text-success' : tone === 'warning' ? 'text-warning' : 'text-danger';
        return (
          <div className={`mb-3 rounded-xl border ${borderTone} ${bgTone} px-4 py-3`}>
            <div className="flex items-center flex-wrap gap-x-4 gap-y-2">
              <div className="flex items-baseline gap-2 min-w-0">
                <span className={`font-mono tabular-nums text-2xl font-extrabold leading-none ${faltanTone}`}>{faltan}</span>
                <span className="text-sm font-semibold text-foreground">
                  {done
                    ? '¡Todo gestionado hoy! ✓'
                    : `${faltan === 1 ? 'pedido' : 'pedidos'} por gestionar${listaActiva && !listaActiva.externalRoute ? ' en esta lista' : ''} hoy`}
                </span>
              </div>
              <div className="text-xs text-muted-foreground flex items-baseline gap-x-1.5">
                <span>Gestionados</span>
                <strong className="font-mono tabular-nums text-foreground">{gestionados}</strong>
                <span>de</span>
                <strong className="font-mono tabular-nums text-foreground">{total}</strong>
              </div>
              {viewMode === 'board' && (
                <label className="ml-auto inline-flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
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
            {/* Barra de progreso del día — se llena a medida que gestionás. */}
            <div className="mt-2 h-1.5 w-full rounded-full bg-muted overflow-hidden" aria-hidden="true">
              <div className={`h-full ${barTone} transition-all duration-300`} style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })()}

      {viewMode === 'board' ? (
        <SegBoard
          data={boardData}
          countryCode={activeStore?.country_code}
          statusFilter={statusFilter}
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
        />
      )}
    </div>
  );
}

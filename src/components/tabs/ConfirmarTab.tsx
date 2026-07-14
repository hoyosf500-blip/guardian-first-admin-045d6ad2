import { useState, useCallback, useEffect, useMemo, useRef, useLayoutEffect } from 'react';
import { useOrders } from '@/contexts/OrderContext';
import { findSupersededPendingConfDetailed, isLocallyDead, type ProgressedOrder } from '@/lib/duplicateOrders';
import { detectDuplicatePairs } from '@/lib/duplicatePairs';
import { buildActiveDupIndex, type ConfirmarOrderAlerts } from '@/lib/orderAlerts';
import { useShopifyValueMismatches } from '@/hooks/useShopifyPending';
import { useAuth } from '@/contexts/AuthContext';
import { useStore } from '@/contexts/StoreContext';
import { useOrderNotesIndex } from '@/hooks/useOrderNotesIndex';
import { useSessionState } from '@/hooks/useSessionState';
import { supabase } from '@/integrations/supabase/client';
import { parseExcelToOrders, formatDateES, OrderData, parseDate, dbToOrderData } from '@/lib/orderUtils';
import { ORDER_COLUMNS } from '@/lib/orderColumns';
import { isLockedByOther } from '@/lib/callQueueNav';
import { toast } from 'sonner';
import ExcelUploader from '@/components/ExcelUploader';
import AperturaWizard from '@/components/AperturaWizard';
import WorkList from '@/components/WorkList';
import CallView from '@/components/CallView';
import WorkFilters from '@/components/WorkFilters';
import TasaMetaBanner from '@/components/TasaMetaBanner';
import ShopifyPendingPanel from '@/components/confirmar/ShopifyPendingPanel';
import DropiSyncFailuresPanel from '@/components/confirmar/DropiSyncFailuresPanel';
import { MetricsUpdateBanner } from '@/components/MetricsUpdateBanner';
import ClosingReportDialog from '@/components/ClosingReportDialog';
import { AlertTriangle, List, Phone, RefreshCw, CloudDownload, CalendarIcon, X, RotateCcw, Moon } from 'lucide-react';
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

export default function ConfirmarTab({ profile }: Props) {
  const { user } = useAuth();
  const { activeStoreId } = useStore();
  const { workQueue, allOrders, setAllOrders, buildWorkQueue, counter, resetOrders, excelLoaded, setExcelLoaded, myConfirmTouchedToday, markResult } = useOrders();
  // Persist nav state in sessionStorage so a tab discard (common on mobile
  // when operator leaves to the transportadora's tracking page) does not
  // make them lose their place and filters.
  const [view, setView] = useSessionState<'list' | 'call'>('confirmar:view', 'list');
  const [filter, setFilter] = useSessionState<string>('confirmar:filter', 'pending');
  const [search, setSearch] = useSessionState<string>('confirmar:search', '');
  const [dateFrom, setDateFrom] = useSessionState<string>('confirmar:dateFrom', '');
  const [dateTo, setDateTo] = useSessionState<string>('confirmar:dateTo', '');
  // Toggle "Solo sin tocar" — filtra workQueue para que solo aparezcan los
  // pedidos donde la operadora aún NO ha registrado un order_results hoy.
  // Persiste en sessionStorage para sobrevivir a tab discard de mobile.
  const [onlyUntouched, setOnlyUntouched] = useSessionState<boolean>('confirmar:onlyUntouched', false);
  const [aperturaCompleted, setAperturaCompleted] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [autoLoading, setAutoLoading] = useState(false);
  const [showExcel, setShowExcel] = useState(false);
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
    const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    supabase.from('orders').select(ORDER_COLUMNS).ilike('estado', 'PENDIENTE CONFIRMACION')
      .eq('store_id', activeStoreId)
      .or(`locked_by.is.null,locked_by.eq.${user.id},locked_at.lt.${fifteenMinAgo}`)
      .then(({ data: dbOrders, error }) => {
        if (error) {
          console.error('Error loading orders:', error);
          toast.error('Error cargando pedidos: ' + error.message);
          setAutoLoading(false);
          return;
        }
        if (dbOrders && dbOrders.length > 0) {
          const orders = (dbOrders as unknown as Parameters<typeof dbToOrderData>[0][]).map((o, idx) => dbToOrderData(o, idx));
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
        const msg = err instanceof Error ? err.message : String(err);
        console.error('Network error loading orders:', err);
        toast.error('Error de red: ' + msg);
        setAutoLoading(false);
      });
  }, [user, excelLoaded, today, autoLoading, activeStoreId]);

  const handleFile = useCallback(async (file: File) => {
    toast.info('Procesando Excel...');
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const XLSX = await import('xlsx');
        const wb = XLSX.read(e.target?.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const raw = XLSX.utils.sheet_to_json(ws, { defval: '' }) as Record<string, unknown>[];
        if (!raw.length) { toast.error('Excel vacío'); return; }
        const orders = parseExcelToOrders(raw);
        if (!orders.length) { toast.error('No se encontraron columnas de nombre/teléfono'); return; }
        if (user) {
          const dbOrders = orders.map(o => ({
            external_id: o.externalId, uploaded_by: user.id, upload_date: today,
            nombre: o.nombre, phone: o.phone, ciudad: o.ciudad, producto: o.producto,
            estado: o.estado, fecha: o.fecha, fecha_conf: o.fechaConf, dias: o.dias,
            dias_conf: o.diasConf, valor: o.valor, flete: o.flete, costo_prod: o.costoProd,
            costo_dev: o.costoDev, cantidad: o.cantidad, direccion: o.direccion,
            novedad: o.novedad, guia: o.guia, transportadora: o.transportadora,
            tags: o.tags, departamento: o.departamento, tienda: o.tienda, novedad_sol: o.novedadSol,
          }));
          const { data, error } = await supabase.from('orders').upsert(dbOrders, { onConflict: 'external_id', ignoreDuplicates: false }).select('id');
          if (error) { toast.error('Error guardando pedidos'); return; }
          // Match returned IDs back to orders by insertion order (1:1).
          // The old Map-by-phone approach silently clobbered dbId when two
          // orders shared the same phone number (repeat customers).
          if (data) data.forEach((d, i) => { if (i < orders.length) orders[i].dbId = d.id; });
        }
        setAllOrders(orders);
        buildWorkQueue(orders);
        setExcelLoaded(true);
        toast.success(`${orders.length} pedidos cargados`);
      } catch (err: unknown) { toast.error('Error leyendo Excel: ' + (err instanceof Error ? err.message : 'Error desconocido')); }
    };
    reader.readAsArrayBuffer(file);
  }, [user, today, setAllOrders, buildWorkQueue]);

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
  // "Recordatorios para hoy/ahora": recordatorio que llega en ≤1h o ya vencido.
  const REMIND_LOOKAHEAD_MS = 60 * 60 * 1000;

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
    // ver los que ya gestioné hoy. dbId puede ser undefined en pedidos
    // recién subidos por Excel sin sincronizar — esos no caen en el set y se
    // muestran (mejor mostrar que perder).
    if (onlyUntouched && o.dbId && myConfirmTouchedToday.has(o.dbId)) return false;
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
  }), [visibleQueue, filter, search, dateFrom, dateTo, notesIndex, onlyUntouched, myConfirmTouchedToday, user?.id]);

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
  const pending = visibleQueue.filter(o => !o.result).length;

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      {/* Page header — patrón pro coherente con Logística/Rescate */}
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          <div className="text-[11px] uppercase tracking-[0.12em] font-semibold text-muted-foreground">
            Cola · Operadora
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground leading-none flex items-center gap-2.5">
            <Phone size={22} className="text-accent" aria-hidden="true" strokeWidth={2.25} />
            Confirmar
          </h1>
          <p className="text-sm text-muted-foreground">
            {formatDateES(today)} · Cola de pedidos pendientes de confirmación.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={() => setClosing(true)} className="gap-1.5 h-9">
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
              className="inline-flex h-9 items-center gap-1.5 px-3 rounded-lg bg-card border border-border text-xs font-semibold text-muted-foreground hover:text-foreground hover:border-border-strong transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              Cambiar archivo
            </button>
          )}
        </div>
      </header>

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

      {!autoLoading && !excelLoaded && !aperturaCompleted && (
        <AperturaWizard onComplete={() => setAperturaCompleted(true)} />
      )}

      {!autoLoading && !excelLoaded && (
        <div className="space-y-3">
          {/* Dropi Sync Button */}
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
                  const { data: dbOrders } = await supabase.from('orders')
                    .select(ORDER_COLUMNS)
                    .eq('store_id', activeStoreId)
                    .eq('estado', 'PENDIENTE CONFIRMACION');
                  if (dbOrders && dbOrders.length > 0) {
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
            className="w-full flex items-center justify-center gap-3 py-4 px-5 rounded-xl bg-surface border border-border hover:border-accent/30 hover:bg-accent/5 transition-colors duration-200 cursor-pointer group focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          >
            <div className="w-10 h-10 rounded-xl bg-accent/15 border border-accent/20 flex items-center justify-center group-hover:bg-accent/25 transition-colors duration-200">
              {syncing ? <RefreshCw size={20} className="text-accent animate-spin" aria-hidden="true" /> : <CloudDownload size={20} className="text-accent" aria-hidden="true" />}
            </div>
            <div className="text-left">
              <div className="text-sm font-semibold text-foreground">
                {syncing ? 'Sincronizando...' : 'Sincronizar desde Dropi'}
              </div>
              <div className="text-[10px] text-muted-foreground">Descarga automáticamente los pedidos del día</div>
            </div>
          </button>

          <button
            onClick={() => setShowExcel(!showExcel)}
            className="w-full flex items-center justify-center gap-2 py-2 text-[10px] text-muted-foreground uppercase tracking-wider hover:text-foreground transition-colors"
          >
            <div className="flex-1 h-px bg-border" />
            <span>{showExcel ? 'Ocultar' : 'O sube manualmente'}</span>
            <div className="flex-1 h-px bg-border" />
          </button>

          {showExcel && <ExcelUploader onFile={handleFile} />}
        </div>
      )}

      {excelLoaded && workQueue.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center" role="status" aria-live="polite">
          <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center mb-4">
            <Phone size={24} className="text-muted-foreground" aria-hidden="true" />
          </div>
          <h3 className="text-base font-semibold text-foreground mb-1">No hay pedidos disponibles para confirmar</h3>
          <p className="text-sm text-muted-foreground max-w-md">
            Espera al próximo sync con Dropi o sube un Excel manualmente.
          </p>
          <button
            onClick={() => { resetOrders(); setExcelLoaded(false); }}
            className="mt-4 text-xs px-3 py-1.5 rounded-lg bg-card border border-border text-muted-foreground font-medium hover:text-foreground hover:border-border-strong transition-colors"
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
            const sinTocarEnCola = visibleQueue.filter(o => !o.dbId || !myConfirmTouchedToday.has(o.dbId)).length;
            const tone = sinTocarEnCola === 0
              ? 'success'
              : sinTocarEnCola >= Math.max(1, Math.ceil(visibleQueue.length / 2))
                ? 'danger'
                : 'warning';
            const dotTone = tone === 'success' ? 'bg-success' : tone === 'warning' ? 'bg-warning' : 'bg-danger';
            const borderTone = tone === 'success' ? 'border-success/30' : tone === 'warning' ? 'border-warning/30' : 'border-danger/30';
            const bgTone = tone === 'success' ? 'bg-success/5' : tone === 'warning' ? 'bg-warning/5' : 'bg-danger/5';
            return (
              <div className={`mb-3 rounded-xl border ${borderTone} ${bgTone} px-4 py-3 flex items-center flex-wrap gap-x-4 gap-y-2`}>
                <span className={`h-2 w-2 rounded-full shrink-0 ${dotTone}`} aria-hidden="true" />
                <div className="text-sm font-semibold text-foreground">
                  Tu cola hoy
                </div>
                <div className="text-xs text-muted-foreground flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span>
                    Has llamado a <strong className="font-mono tabular-nums text-foreground">{tocadosHoy}</strong>
                  </span>
                  <span className="opacity-50">·</span>
                  <span>
                    Te faltan <strong className={`font-mono tabular-nums text-${tone}`}>{sinTocarEnCola}</strong> sin tocar
                    {sinTocarEnCola === 0 && <span className="text-success ml-1">✓</span>}
                  </span>
                </div>
                <label className="ml-auto inline-flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={onlyUntouched}
                    onChange={(e) => setOnlyUntouched(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-border accent-accent cursor-pointer"
                  />
                  Solo sin tocar
                </label>
              </div>
            );
          })()}

          {/* KPIs compactos + urgent pills inline. Antes el chip "N urgente
              (D4-6)" ocupaba su propia fila — en desktop quedaba ese pill
              suelto con 800px de aire al lado. Ahora va en la MISMA strip, al
              final, separado por un border-l. Ahorra una fila en desktop y
              mantiene la misma jerarquía en mobile (wrap natural). */}
          {(() => {
            const d7 = visibleQueue.filter(o => o.dias >= 7 && !o.result).length;
            const d46 = visibleQueue.filter(o => o.dias >= 4 && o.dias <= 6 && !o.result).length;
            return (
              <div className="mb-4 bg-card border border-border rounded-xl px-4 py-3 flex flex-wrap items-baseline gap-x-5 gap-y-2 hover:border-border-strong transition-colors">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-3xl font-extrabold tabular-nums text-accent leading-none">{pending}</span>
                  <span className="text-[11px] uppercase tracking-[0.08em] font-semibold text-muted-foreground">por confirmar</span>
                </div>
                <div className="flex items-baseline gap-x-4 gap-y-1 flex-wrap text-xs">
                  <span className="inline-flex items-baseline gap-1">
                    <strong className="font-mono text-base font-bold tabular-nums text-success leading-none">{counter.conf}</strong>
                    <span className="text-muted-foreground">conf</span>
                  </span>
                  <span className="inline-flex items-baseline gap-1">
                    <strong className="font-mono text-base font-bold tabular-nums text-danger leading-none">{counter.canc}</strong>
                    <span className="text-muted-foreground">canc</span>
                  </span>
                  <span className="inline-flex items-baseline gap-1">
                    <strong className="font-mono text-base font-bold tabular-nums text-foreground leading-none">{counter.noresp}</strong>
                    <span className="text-muted-foreground">noresp</span>
                  </span>
                  <span className="inline-flex items-baseline gap-1 border-l border-border/60 pl-4">
                    <strong className="font-mono text-base font-bold tabular-nums text-foreground leading-none">{total}</strong>
                    <span className="text-muted-foreground">gestionados</span>
                  </span>
                  {/* Estos conteos son de TODA la tienda (todas las operadoras),
                      no personales. Se etiqueta para no confundir con "Tu cola hoy"
                      y con el banner personal de arriba. */}
                  <span className="text-[10px] uppercase tracking-[0.06em] text-muted-foreground/70">
                    equipo · toda la tienda
                  </span>
                </div>
                {(d7 > 0 || d46 > 0) && (
                  <div className="flex items-center gap-2 flex-wrap sm:ml-auto sm:border-l sm:border-border/60 sm:pl-5">
                    {d7 > 0 && (
                      <span className="pill pill-danger">
                        <span className="w-1.5 h-1.5 rounded-full bg-danger" aria-hidden="true" /> {d7} cancelar (D7+)
                      </span>
                    )}
                    {d46 > 0 && (
                      <span className="pill pill-warning">
                        <span className="w-1.5 h-1.5 rounded-full bg-warning" aria-hidden="true" /> {d46} urgente (D4-6)
                      </span>
                    )}
                  </div>
                )}
              </div>
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
                className={`w-full flex items-center gap-3 mb-4 rounded-xl border px-4 py-3 text-left transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-warning focus-visible:outline-none ${
                  active ? 'bg-warning/20 border-warning/50' : 'bg-warning/10 border-warning/25 hover:bg-warning/15'
                }`}>
                <RotateCcw size={16} className="text-warning shrink-0" aria-hidden="true" strokeWidth={2.25} />
                <div className="min-w-0 flex-1">
                  <span className="text-xs font-bold text-warning">
                    {retryOrders.length} pedido{retryOrders.length > 1 ? 's' : ''} para reintentar
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
          <div className="bg-surface border border-border rounded-xl p-3 sm:p-4 mb-4 space-y-3">
            <div className="flex items-center flex-wrap gap-2">
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className={cn(
                    "h-9 gap-1.5 text-xs font-medium rounded-lg cursor-pointer",
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
                    "h-9 gap-1.5 text-xs font-medium rounded-lg cursor-pointer",
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

              <div className="flex gap-1 bg-card border border-border rounded-lg p-0.5 ml-auto">
                {([
                  { key: 'list' as const, icon: List, label: 'Lista' },
                  { key: 'call' as const, icon: Phone, label: 'Llamar' },
                ]).map(v => (
                  <button key={v.key} onClick={() => setView(v.key)}
                    aria-pressed={view === v.key}
                    className={`inline-flex items-center gap-1.5 px-3 h-8 rounded-md text-xs font-medium transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ${
                      view === v.key ? 'bg-accent text-accent-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                    }`}>
                    <v.icon size={13} aria-hidden="true" /> {v.label}
                  </button>
                ))}
              </div>
            </div>

            <WorkFilters workQueue={visibleQueue} filter={filter} setFilter={setFilter} search={search} setSearch={setSearch} notesIndex={notesIndex} />
          </div>

          {/* ⚠ DUPLICADOS VIVOS (incidente 2026-07-13, #6107398): el pedido viejo
              del par duplicado sigue ACTIVO en Dropi (no está cancelado ni
              reemplazado ni rechazado) → puede despacharse dos veces. Antes caía
              al panel pasivo de abajo, sin botones, y nadie lo podía cancelar.
              Acá va con acción directa: "Cancelar en Dropi" vía markResult('canc')
              (la cancelación se sincroniza con Dropi de verdad). */}
          {liveDups.length > 0 && (
            <div className="mb-4 rounded-xl border border-destructive/40 bg-destructive/10 overflow-hidden">
              <div className="px-4 py-2.5 flex items-center gap-2 text-xs">
                <AlertTriangle size={14} className="text-destructive shrink-0" aria-hidden="true" />
                <span className="font-semibold text-foreground">
                  ⚠ {liveDups.length} DUPLICADO{liveDups.length > 1 ? 'S' : ''} VIVO{liveDups.length > 1 ? 'S' : ''} en Dropi
                </span>
                <span className="text-muted-foreground">— el pedido viejo sigue activo y puede despacharse dos veces</span>
              </div>
              <div className="border-t border-destructive/30 divide-y divide-border">
                {liveDups.map(o => {
                  const info = supersededMap.get(String(o.externalId));
                  return (
                    <div key={o.externalId || o.dbId} className="px-4 py-2 flex items-center gap-2 text-xs flex-wrap">
                      <span className="font-medium text-foreground truncate">{o.nombre}</span>
                      <a href={`/pedido/${o.externalId}`} className="font-mono text-[10px] text-primary hover:underline">#{o.externalId}</a>
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded border bg-destructive/15 text-destructive border-destructive/30">
                        {o.estado}
                      </span>
                      <span className="text-muted-foreground truncate">{o.producto}</span>
                      <span className="tabular-nums text-muted-foreground">{formatCOP(Number(o.valor || 0))}</span>
                      {info && (
                        <span className="text-muted-foreground">
                          más nuevo:{' '}
                          <a href={`/pedido/${info.byExternalId}`} className="font-mono text-primary hover:underline">#{info.byExternalId}</a>
                        </span>
                      )}
                      <span className="ml-auto">
                        {o.result ? (
                          <span className="text-[10px] font-semibold text-muted-foreground">Gestionado</span>
                        ) : (
                          <Button
                            variant="destructive"
                            size="sm"
                            className="h-7 text-[11px]"
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
            <div className="mb-4 rounded-xl border border-border bg-muted/40 overflow-hidden">
              <button onClick={() => setDupExpanded(e => !e)}
                className="w-full flex items-center gap-2 px-4 py-2.5 text-left text-xs">
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
                    <div key={o.externalId || o.dbId} className="px-4 py-2 flex items-center gap-3 text-xs">
                      <span className="font-medium text-foreground truncate">{o.nombre}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">#{o.externalId}</span>
                      <span className="text-muted-foreground">{o.producto}</span>
                      <span className="ml-auto tabular-nums text-muted-foreground">{formatCOP(Number(o.valor || 0))}</span>
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
            <div className="mb-4 rounded-xl border border-warning/40 bg-warning/10 overflow-hidden">
              <div className="px-4 py-2.5 flex items-center gap-2 text-xs">
                <AlertTriangle size={14} className="text-warning shrink-0" aria-hidden="true" />
                <span className="font-semibold text-foreground">
                  {resentOldInQueue.length} pedido{resentOldInQueue.length > 1 ? 's' : ''} viejo{resentOldInQueue.length > 1 ? 's' : ''} con reenvío activo
                </span>
                <span className="text-muted-foreground">— gestioná el # nuevo, no estos</span>
              </div>
              <div className="border-t border-warning/30 divide-y divide-border">
                {resentOldInQueue.map(({ order, nuevoId }) => (
                  <div key={order.externalId || order.dbId} className="px-4 py-2 flex items-center gap-2 text-xs flex-wrap">
                    <span className="font-medium text-foreground truncate">{order.nombre}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">#{order.externalId}</span>
                    <span
                      title={`Este cliente ya tiene un pedido más nuevo activo (#${nuevoId}) — gestioná ese y no toques este`}
                      className="text-[9px] font-bold px-1.5 py-0.5 rounded border bg-warning/15 text-warning border-warning/30 inline-flex items-center gap-0.5"
                    >
                      ⚠ YA REENVIADO — gestioná el #{nuevoId}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {view === 'list' ? (
            <WorkList items={filteredItems} notesIndex={notesIndex} alerts={orderAlerts} onOpenCall={(idx) => {
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

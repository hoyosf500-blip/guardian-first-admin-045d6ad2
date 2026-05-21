import { useState, useCallback, useEffect } from 'react';
import { useOrders } from '@/contexts/OrderContext';
import { useAuth } from '@/contexts/AuthContext';
import { useStore } from '@/contexts/StoreContext';
import { useSessionState } from '@/hooks/useSessionState';
import { supabase } from '@/integrations/supabase/client';
import { parseExcelToOrders, formatDateES, OrderData, parseDate, dbToOrderData } from '@/lib/orderUtils';
import { ORDER_COLUMNS } from '@/lib/orderColumns';
import { toast } from 'sonner';
import ExcelUploader from '@/components/ExcelUploader';
import AperturaWizard from '@/components/AperturaWizard';
import WorkList from '@/components/WorkList';
import CallView from '@/components/CallView';
import WorkFilters from '@/components/WorkFilters';
import TasaMetaBanner from '@/components/TasaMetaBanner';
import { MetricsUpdateBanner } from '@/components/MetricsUpdateBanner';
import ClosingReportDialog from '@/components/ClosingReportDialog';
import { AlertTriangle, List, Phone, RefreshCw, CloudDownload, CalendarIcon, X, RotateCcw, Moon } from 'lucide-react';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { cn, bogotaToday } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';


interface Props {
  profile: { display_name: string } | null;
  onLogout: () => void;
}

export default function ConfirmarTab({ profile }: Props) {
  const { user } = useAuth();
  const { activeStoreId } = useStore();
  const { workQueue, allOrders, setAllOrders, buildWorkQueue, counter, resetOrders, excelLoaded, setExcelLoaded } = useOrders();
  // Persist nav state in sessionStorage so a tab discard (common on mobile
  // when operator leaves to the transportadora's tracking page) does not
  // make them lose their place and filters.
  const [view, setView] = useSessionState<'list' | 'call'>('confirmar:view', 'list');
  const [filter, setFilter] = useSessionState<string>('confirmar:filter', 'pending');
  const [search, setSearch] = useSessionState<string>('confirmar:search', '');
  const [dateFrom, setDateFrom] = useSessionState<string>('confirmar:dateFrom', '');
  const [dateTo, setDateTo] = useSessionState<string>('confirmar:dateTo', '');
  const [aperturaCompleted, setAperturaCompleted] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [autoLoading, setAutoLoading] = useState(false);
  const [showExcel, setShowExcel] = useState(false);
  const [closing, setClosing] = useState(false);
  const today = bogotaToday();

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

  const filteredItems = workQueue.filter(o => {
    if (filter === 'pending' && o.result) return false;
    if (filter === 'conf' && o.result !== 'conf') return false;
    if (filter === 'canc' && o.result !== 'canc') return false;
    if (filter === 'noresp' && o.result !== 'noresp') return false;
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
  });

  const total = counter.conf + counter.canc + counter.noresp;
  const pending = workQueue.filter(o => !o.result).length;

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
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
            {[
              { label: 'Por confirmar', value: pending,      color: 'text-accent' },
              { label: 'Confirmados',   value: counter.conf, color: 'text-success' },
              { label: 'Cancelados',    value: counter.canc, color: 'text-danger' },
              { label: 'Gestionados',   value: total,        color: 'text-foreground' },
            ].map(kpi => (
              <div key={kpi.label} className="bg-card border border-border rounded-xl p-4 hover:border-border-strong transition-colors">
                <div className="text-[11px] text-muted-foreground font-semibold uppercase tracking-[0.08em] mb-2">{kpi.label}</div>
                <div className={`font-mono text-3xl font-bold tabular-nums leading-none ${kpi.color}`}>{kpi.value}</div>
              </div>
            ))}
          </div>

          {(() => {
            const d7 = workQueue.filter(o => o.dias >= 7 && !o.result).length;
            const d46 = workQueue.filter(o => o.dias >= 4 && o.dias <= 6 && !o.result).length;
            if (!d7 && !d46) return null;
            return (
              <div className="flex gap-2 mb-4 flex-wrap">
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
            );
          })()}

          {(() => {
            const retryOrders = workQueue.filter(o => o.retryCount && !o.result);
            if (!retryOrders.length) return null;
            return (
              <div className="flex items-center gap-3 mb-4 rounded-xl bg-warning/10 border border-warning/25 px-4 py-3">
                <RotateCcw size={16} className="text-warning shrink-0" aria-hidden="true" strokeWidth={2.25} />
                <div className="min-w-0">
                  <span className="text-xs font-bold text-warning">
                    {retryOrders.length} pedido{retryOrders.length > 1 ? 's' : ''} para reintentar
                  </span>
                  <span className="text-[11px] text-muted-foreground ml-2">
                    No contestaron antes — volver a llamar
                  </span>
                </div>
              </div>
            );
          })()}

          <div className="bg-surface border border-border rounded-xl p-4 mb-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 flex-wrap">
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm" className={cn(
                      "h-7 gap-1.5 text-[11px] font-normal rounded-lg",
                      !dateFrom && "text-muted-foreground"
                    )}>
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
                    <Button variant="outline" size="sm" className={cn(
                      "h-7 gap-1.5 text-[11px] font-normal rounded-lg",
                      !dateTo && "text-muted-foreground"
                    )}>
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
                {(dateFrom || dateTo) && (
                  <Button variant="ghost" size="sm" onClick={() => { setDateFrom(''); setDateTo(''); }}
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground rounded-lg">
                    <X size={13} />
                  </Button>
                )}
              </div>

              <div className="flex gap-1 bg-card border border-border rounded-lg p-0.5">
                {([
                  { key: 'list' as const, icon: List, label: 'Lista' },
                  { key: 'call' as const, icon: Phone, label: 'Llamar' },
                ]).map(v => (
                  <button key={v.key} onClick={() => setView(v.key)}
                    aria-pressed={view === v.key}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium transition-colors duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ${
                      view === v.key ? 'bg-accent text-accent-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                    }`}>
                    <v.icon size={13} aria-hidden="true" /> {v.label}
                  </button>
                ))}
              </div>
            </div>

            <WorkFilters workQueue={workQueue} filter={filter} setFilter={setFilter} search={search} setSearch={setSearch} />
          </div>

          {view === 'list' ? (
            <WorkList items={filteredItems} onOpenCall={() => setView('call')} />
          ) : (
            <CallView items={filteredItems} />
          )}
        </>
      )}
    </div>
  );
}

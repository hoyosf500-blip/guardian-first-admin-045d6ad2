import { useEffect, useMemo } from 'react';
import { useOrders } from '@/contexts/OrderContext';
import { OrderData, calcBusinessDays } from '@/lib/orderUtils';
import { useSessionState } from '@/hooks/useSessionState';
import { SEG_ACTIONS } from '@/lib/constants';
import { Truck, RefreshCw, Package, AlertTriangle, MapPin, RotateCcw, Tag, DollarSign, CheckCircle, Layers, CalendarIcon, X, Clock, ChevronRight } from 'lucide-react';
import { motion } from 'framer-motion';
import CrmTable from '@/components/CrmTable';
import SegRescueCounterBar from '@/components/SegRescueCounterBar';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';


function classifyEstado(estado: string) {
  const e = estado.toUpperCase();
  if (['PENDIENTE', 'EN PROCESAMIENTO', 'EN PUNTO DROOP', 'ALISTAMIENTO', 'EN BODEGA DROPI', 'RECOGIDO POR DROPI'].includes(e)) return 'procesamiento';
  if (['GUIA GENERADA', 'GUIA_GENERADA', 'PREPARADO PARA TRANSPORTADORA', 'ENTREGADO A TRANSPORTADORA'].includes(e)) return 'guia';
  if (['EN BODEGA TRANSPORTADORA', 'ADMITIDA'].includes(e)) return 'bodega_trans';
  if (['EN TRANSPORTE', 'EN DESPACHO', 'EN TRASLADO NACIONAL', 'EN TERMINAL ORIGEN', 'EN TERMINAL DESTINO', 'ENTREGADA A CONEXIONES'].includes(e)) return 'transito';
  if (['EN REPARTO', 'TELEMERCADEO', 'REENVÍO', 'REENVIO', 'EN DISTRIBUCION', 'EN REEXPEDICION'].includes(e)) return 'reparto';
  if (e === 'NOVEDAD' || e === 'INTENTO DE ENTREGA') return 'novedad';
  if (e === 'NOVEDAD SOLUCIONADA') return 'novedad_sol';
  if (e.includes('OFICINA') || e.includes('RECLAME')) return 'oficina';
  if (e === 'RECHAZADO') return 'rechazado';
  if (e === 'DEVOLUCION EN TRANSITO') return 'devolucion_transito';
  if (e.includes('DEVOL')) return 'devolucion';
  if (e.includes('INDEMNIZADA')) return 'indemnizada';
  if (e === 'ENTREGADO') return 'entregado';
  if (e === 'CANCELADO') return 'cancelado';
  return 'otros';
}

function getOrderAgeDays(order: OrderData): number {
  const fechaConf = (order.fechaConf || '').trim();
  if (fechaConf && fechaConf !== 'undefined') return calcBusinessDays(fechaConf);
  return order.diasConf || 0;
}

function isActiveOrder(estado: string): boolean {
  const e = estado.toUpperCase();
  return e !== 'ENTREGADO' && !e.includes('DEVOL') && e !== 'CANCELADO' && e !== 'RECHAZADO';
}

export default function SeguimientoTab() {
  // Cached in OrderContext so the data survives route unmounts when the
  // operator navigates between CRM tabs. Without the cache they'd see
  // "Cargando seguimiento..." and lose all filter/selection state every
  // time they switched tabs.
  const { segData, segLoaded, segLoading, segLastUpdate, loadSegData } = useOrders();

  // Filter state persisted to sessionStorage so it also survives tab
  // discards (Chrome Memory Saver) and internal route navigation.
  const [dateFrom, setDateFrom] = useSessionState<string>('seg:dateFrom', '');
  const [dateTo, setDateTo] = useSessionState<string>('seg:dateTo', '');
  const [initialDelayed, setInitialDelayed] = useSessionState<boolean>('seg:initialDelayed', false);
  const [stalledCategoryFilter, setStalledCategoryFilter] = useSessionState<string | null>('seg:stalledCategoryFilter', null);
  // Owns the status filter so the stat cards ABOVE the table act as the single
  // source of truth (no duplicate pill row below).
  const [statusFilter, setStatusFilter] = useSessionState<string | null>('seg:statusFilter', null);

  useEffect(() => { loadSegData(); }, [loadSegData]);

  // Filter by date range
  const filteredByDate = useMemo(() => {
    if (!dateFrom && !dateTo) return segData;
    return segData.filter(o => {
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
  }, [segData, dateFrom, dateTo]);

  const stats = useMemo(() => {
    const s = {
      procesamiento: 0, guia: 0, bodega_trans: 0, transito: 0, reparto: 0,
      novedad: 0, novedad_sol: 0, oficina: 0, rechazado: 0,
      devolucion_transito: 0, devolucion: 0, indemnizada: 0,
      entregado: 0, cancelado: 0, otros: 0,
      total: filteredByDate.length,
    };
    filteredByDate.forEach(o => {
      const cat = classifyEstado(o.estado);
      if (cat in s) (s as Record<string, number>)[cat]++;
    });
    return s;
  }, [filteredByDate]);

  // Stalled orders analysis
  const stalledStats = useMemo(() => {
    const stalled = filteredByDate.filter(o => {
      if (!isActiveOrder(o.estado)) return false;
      return getOrderAgeDays(o) >= 2;
    });

    const byCategory: { label: string; icon: React.ReactNode; count: number; color: string; days5: number }[] = [];
    const categories = [
      { label: 'Guía Generada', match: (e: string) => ['GUIA GENERADA', 'GUIA_GENERADA', 'PREPARADO PARA TRANSPORTADORA', 'ENTREGADO A TRANSPORTADORA'].includes(e), icon: <Tag size={13} />, color: 'text-muted-foreground' },
      { label: 'En Procesamiento', match: (e: string) => ['PENDIENTE', 'EN PROCESAMIENTO', 'EN PUNTO DROOP', 'ALISTAMIENTO', 'EN BODEGA DROPI', 'RECOGIDO POR DROPI'].includes(e), icon: <Package size={13} />, color: 'text-muted-foreground' },
      { label: 'Oficina', match: (e: string) => e.includes('OFICINA') || e.includes('RECLAME'), icon: <MapPin size={13} />, color: 'text-warning' },
      { label: 'Novedad', match: (e: string) => e === 'NOVEDAD' || e === 'INTENTO DE ENTREGA', icon: <AlertTriangle size={13} />, color: 'text-warning' },
      { label: 'En Tránsito', match: (e: string) => ['EN TRANSPORTE', 'EN DESPACHO', 'EN TRASLADO NACIONAL', 'EN TERMINAL ORIGEN', 'EN TERMINAL DESTINO', 'ENTREGADA A CONEXIONES'].includes(e), icon: <Truck size={13} />, color: 'text-muted-foreground' },
      { label: 'Reparto', match: (e: string) => ['EN REPARTO', 'TELEMERCADEO', 'REENVÍO', 'REENVIO', 'EN DISTRIBUCION', 'EN REEXPEDICION'].includes(e), icon: <Truck size={13} />, color: 'text-accent' },
    ];

    categories.forEach(cat => {
      const matching = stalled.filter(o => cat.match(o.estado.toUpperCase()));
      const days5 = matching.filter(o => getOrderAgeDays(o) >= 5).length;
      if (matching.length > 0) {
        byCategory.push({ label: cat.label, icon: cat.icon, count: matching.length, color: cat.color, days5 });
      }
    });

    return { total: stalled.length, categories: byCategory };
  }, [filteredByDate]);

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
      <SegRescueCounterBar module="SEG" />
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
                <span className="text-[10px] text-subtle font-mono">/ {segData.length}</span>
              )}
            </div>
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

        {/* Stalled Orders Alert Banner */}
        {stalledStats.total > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15, duration: 0.3 }}
            className={cn(
              "rounded-xl border overflow-hidden transition-colors cursor-pointer",
              initialDelayed
                ? "border-warning bg-warning/10"
                : "border-warning/30 bg-warning/5 hover:border-warning/50"
            )}
            onClick={() => {
              setInitialDelayed(!initialDelayed);
              if (initialDelayed) setStalledCategoryFilter(null);
            }}
          >
            <div className="px-4 py-3 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-md bg-warning/15 ring-1 ring-warning/30 flex items-center justify-center shrink-0">
                  <Clock size={18} className="text-warning" aria-hidden="true" strokeWidth={2.25} />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-foreground">Sin movimiento</span>
                    <span className="pill pill-warning">{stalledStats.total}</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    Pedidos con 2+ días hábiles sin escaneo — incluye guías generadas y pendientes
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs font-semibold text-warning">
                  {initialDelayed ? 'Mostrando' : 'Ver todos'}
                </span>
                <ChevronRight size={16} className={cn(
                  "text-warning transition-transform",
                  initialDelayed && "rotate-90"
                )} aria-hidden="true" />
              </div>
            </div>

            {/* Category breakdown */}
            <div className="px-4 pb-3 flex flex-wrap gap-2">
              {stalledStats.categories.map(cat => (
                <button
                  key={cat.label}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    const isActive = stalledCategoryFilter === cat.label;
                    setStalledCategoryFilter(isActive ? null : cat.label);
                    if (!initialDelayed) setInitialDelayed(true);
                  }}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 transition-colors",
                    stalledCategoryFilter === cat.label
                      ? "bg-warning/15 border-warning/60 ring-1 ring-warning/30"
                      : "bg-card border-border hover:border-warning/40"
                  )}
                >
                  <span className={cat.color}>{cat.icon}</span>
                  <span className="text-[11px] font-medium text-foreground">{cat.label}</span>
                  <span className="font-mono text-[11px] font-bold tabular-nums text-foreground">{cat.count}</span>
                  {cat.days5 > 0 && (
                    <span className="font-mono text-[9px] font-bold text-danger bg-danger/10 rounded px-1 py-0.5 tabular-nums">
                      {cat.days5} crit
                    </span>
                  )}
                </button>
              ))}
            </div>
          </motion.div>
        )}

        {/* Stat cards — clickable filters. Click a card to filter the table
            below; click again to clear. This replaces the old pills row so
            there's one single source of truth for the active status. */}
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
      </motion.div>

      <CrmTable
        data={filteredByDate}
        actions={SEG_ACTIONS}
        module="SEG"
        emptyIcon={<Truck size={28} className="text-muted-foreground" />}
        emptyTitle="Sin pedidos en seguimiento"
        emptyDesc="Los pedidos sincronizados desde Dropi aparecerán aquí organizados por estado."
        initialDelayed={initialDelayed}
        stalledCategoryFilter={stalledCategoryFilter}
        controlledStatusFilter={statusFilter}
        onControlledStatusFilterChange={setStatusFilter}
      />
    </div>
  );
}

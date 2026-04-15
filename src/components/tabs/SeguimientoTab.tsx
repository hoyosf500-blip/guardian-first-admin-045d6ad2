import { useState, useEffect, useMemo, useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { OrderData, dbToOrderData, calcBusinessDays } from '@/lib/orderUtils';
import { SEG_ACTIONS } from '@/lib/constants';
import { Truck, RefreshCw, Package, AlertTriangle, MapPin, RotateCcw, Tag, DollarSign, CheckCircle, Layers, CalendarIcon, X, Clock, ChevronRight } from 'lucide-react';
import { motion } from 'framer-motion';
import CrmTable from '@/components/CrmTable';
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
  const baseDate = (order.fechaConf || order.fecha || '').trim();
  if (baseDate && baseDate !== 'undefined') return calcBusinessDays(baseDate);
  return Math.round((order.diasConf || order.dias || 0) * 5 / 7);
}

function isActiveOrder(estado: string): boolean {
  const e = estado.toUpperCase();
  return e !== 'ENTREGADO' && !e.includes('DEVOL') && e !== 'CANCELADO' && e !== 'RECHAZADO';
}

export default function SeguimientoTab() {
  const { user } = useAuth();
  const [segData, setSegData] = useState<OrderData[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [initialDelayed, setInitialDelayed] = useState(false);

  const loadOrders = useCallback(async (isRefresh = false) => {
    if (!user) return;
    if (isRefresh) setRefreshing(true); else setLoading(true);

    const { data: dbOrders, error } = await supabase
      .from('orders')
      .select('*')
      .not('estado', 'eq', 'PENDIENTE CONFIRMACION')
      .order('created_at', { ascending: false })
      .limit(5000);

    if (error) {
      console.error('Error loading seg orders:', error);
    } else if (dbOrders && dbOrders.length > 0) {
      setSegData(dbOrders.map((o, idx) => dbToOrderData(o, idx)));
    }
    setLastUpdate(new Date());
    setLoading(false);
    setRefreshing(false);
  }, [user]);

  useEffect(() => { loadOrders(); }, [loadOrders]);

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
      if (cat in s) (s as any)[cat]++;
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
      { label: 'Guía Generada', match: (e: string) => ['GUIA GENERADA', 'GUIA_GENERADA', 'PREPARADO PARA TRANSPORTADORA', 'ENTREGADO A TRANSPORTADORA'].includes(e), icon: <Tag size={13} />, color: 'text-cyan-500' },
      { label: 'En Procesamiento', match: (e: string) => ['PENDIENTE', 'EN PROCESAMIENTO', 'EN PUNTO DROOP', 'ALISTAMIENTO', 'EN BODEGA DROPI', 'RECOGIDO POR DROPI'].includes(e), icon: <Package size={13} />, color: 'text-blue-500' },
      { label: 'Oficina', match: (e: string) => e.includes('OFICINA') || e.includes('RECLAME'), icon: <MapPin size={13} />, color: 'text-purple-500' },
      { label: 'Novedad', match: (e: string) => e === 'NOVEDAD' || e === 'INTENTO DE ENTREGA', icon: <AlertTriangle size={13} />, color: 'text-red-500' },
      { label: 'En Tránsito', match: (e: string) => ['EN TRANSPORTE', 'EN DESPACHO', 'EN TRASLADO NACIONAL', 'EN TERMINAL ORIGEN', 'EN TERMINAL DESTINO', 'ENTREGADA A CONEXIONES'].includes(e), icon: <Truck size={13} />, color: 'text-orange-500' },
      { label: 'Reparto', match: (e: string) => ['EN REPARTO', 'TELEMERCADEO', 'REENVÍO', 'REENVIO', 'EN DISTRIBUCION', 'EN REEXPEDICION'].includes(e), icon: <Truck size={13} />, color: 'text-amber-500' },
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

  const statCards = [
    { label: 'En Procesamiento', value: stats.procesamiento, icon: <Package size={15} />, gradient: 'from-blue-500 to-blue-600' },
    { label: 'Guía Generada', value: stats.guia, icon: <Tag size={15} />, gradient: 'from-cyan-500 to-teal-500' },
    { label: 'Bodega Transp.', value: stats.bodega_trans, icon: <Package size={15} />, gradient: 'from-indigo-500 to-indigo-600' },
    { label: 'En Tránsito', value: stats.transito, icon: <Truck size={15} />, gradient: 'from-orange-500 to-amber-500' },
    { label: 'En Reparto', value: stats.reparto, icon: <Truck size={15} />, gradient: 'from-amber-500 to-yellow-500' },
    { label: 'Novedad', value: stats.novedad, icon: <AlertTriangle size={15} />, gradient: 'from-red-500 to-rose-500' },
    { label: 'Nov. Solucionada', value: stats.novedad_sol, icon: <CheckCircle size={15} />, gradient: 'from-teal-500 to-emerald-500' },
    { label: 'En Oficina', value: stats.oficina, icon: <MapPin size={15} />, gradient: 'from-fuchsia-500 to-purple-600' },
    { label: 'Rechazado', value: stats.rechazado, icon: <AlertTriangle size={15} />, gradient: 'from-yellow-600 to-orange-600' },
    { label: 'Dev. en Tránsito', value: stats.devolucion_transito, icon: <RotateCcw size={15} />, gradient: 'from-pink-500 to-rose-500' },
    { label: 'Devolución', value: stats.devolucion, icon: <RotateCcw size={15} />, gradient: 'from-rose-600 to-red-600' },
    { label: 'Indemnizada', value: stats.indemnizada, icon: <DollarSign size={15} />, gradient: 'from-violet-500 to-purple-600' },
    { label: 'Entregado', value: stats.entregado, icon: <CheckCircle size={15} />, gradient: 'from-emerald-500 to-green-500' },
    { label: 'Cancelado', value: stats.cancelado, icon: <Layers size={15} />, gradient: 'from-slate-500 to-slate-600' },
  ];

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col items-center justify-center py-16 gap-4">
          <RefreshCw size={32} className="text-primary animate-spin" />
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
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="mb-6 space-y-4"
      >
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white shadow-lg"
              style={{ background: 'linear-gradient(135deg, #f97316, #f59e0b)' }}>
              <Truck size={20} />
            </div>
            <div>
              <h2 className="text-lg font-bold text-foreground">Seguimiento</h2>
              <p className="text-xs text-muted-foreground">CRM de pedidos — todos los estados de Dropi</p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
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

            <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-2">
              <Package size={14} className="text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Total</span>
              <span className="text-sm font-bold text-foreground">{stats.total}</span>
              {(dateFrom || dateTo) && stats.total !== segData.length && (
                <span className="text-[10px] text-muted-foreground font-mono">/ {segData.length}</span>
              )}
            </div>
            <button
              onClick={() => loadOrders(true)}
              disabled={refreshing}
              className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
            >
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
              <span className="hidden sm:inline">{refreshing ? 'Actualizando...' : 'Actualizar'}</span>
            </button>
            {lastUpdate && (
              <span className="text-[10px] text-muted-foreground hidden md:block">
                {lastUpdate.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </div>
        </div>

        {/* Stalled Orders Alert Banner */}
        {stalledStats.total > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15, duration: 0.3 }}
            className={cn(
              "rounded-xl border overflow-hidden transition-all cursor-pointer",
              initialDelayed
                ? "border-orange-500 bg-orange-500/10 ring-1 ring-orange-500/30"
                : "border-orange-500/30 bg-gradient-to-r from-orange-500/5 to-red-500/5 hover:border-orange-500/50"
            )}
            onClick={() => setInitialDelayed(!initialDelayed)}
          >
            <div className="px-4 py-3 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-orange-500 to-red-500 flex items-center justify-center text-white shadow-lg shadow-orange-500/25">
                  <Clock size={20} />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-foreground">Sin Movimiento</span>
                    <span className="rounded-full bg-orange-500 text-white text-xs font-bold px-2.5 py-0.5">
                      {stalledStats.total}
                    </span>
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    Pedidos con 2+ días hábiles sin escaneo — incluye guías generadas y pendientes
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-orange-500">
                  {initialDelayed ? 'Mostrando' : 'Ver todos'}
                </span>
                <ChevronRight size={16} className={cn(
                  "text-orange-500 transition-transform",
                  initialDelayed && "rotate-90"
                )} />
              </div>
            </div>

            {/* Category breakdown */}
            <div className="px-4 pb-3 flex flex-wrap gap-2">
              {stalledStats.categories.map(cat => (
                <div
                  key={cat.label}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-card/80 border border-border/50 px-2.5 py-1.5"
                >
                  <span className={cat.color}>{cat.icon}</span>
                  <span className="text-[11px] font-medium text-foreground">{cat.label}</span>
                  <span className="text-[11px] font-bold text-foreground">{cat.count}</span>
                  {cat.days5 > 0 && (
                    <span className="text-[9px] font-bold text-red-500 bg-red-500/10 rounded px-1 py-0.5">
                      {cat.days5} crit
                    </span>
                  )}
                </div>
              ))}
            </div>
          </motion.div>
        )}

        {/* Stat cards row */}
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7 gap-2">
          {statCards.filter(c => c.value > 0).map((card, i) => (
            <motion.div
              key={card.label}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 + i * 0.04, duration: 0.25 }}
              className="bg-card border border-border rounded-xl px-3 py-2.5 flex flex-col items-center gap-1.5"
            >
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-white bg-gradient-to-br ${card.gradient}`}>
                {card.icon}
              </div>
              <span className="text-lg font-black text-foreground leading-none">{card.value}</span>
              <span className="text-[8px] text-muted-foreground font-medium text-center leading-tight">{card.label}</span>
            </motion.div>
          ))}
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
      />
    </div>
  );
}

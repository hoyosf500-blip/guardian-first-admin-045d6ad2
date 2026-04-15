import { useState, useEffect, useMemo, useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { OrderData, dbToOrderData } from '@/lib/orderUtils';
import { SEG_ACTIONS } from '@/lib/constants';
import { Truck, RefreshCw, Package, AlertTriangle, MapPin, RotateCcw, Tag, DollarSign, CheckCircle, Layers } from 'lucide-react';
import { motion } from 'framer-motion';
import CrmTable from '@/components/CrmTable';


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

export default function SeguimientoTab() {
  const { user } = useAuth();
  const [segData, setSegData] = useState<OrderData[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

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

  const stats = useMemo(() => {
    const s = {
      procesamiento: 0, guia: 0, bodega_trans: 0, transito: 0, reparto: 0,
      novedad: 0, novedad_sol: 0, oficina: 0, rechazado: 0,
      devolucion_transito: 0, devolucion: 0, indemnizada: 0,
      entregado: 0, cancelado: 0, otros: 0,
      total: segData.length, valorTotal: 0
    };
    segData.forEach(o => {
      const cat = classifyEstado(o.estado);
      if (cat in s) (s as any)[cat]++;
      s.valorTotal += o.valor;
    });
    return s;
  }, [segData]);

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
      {/* Header with stats */}
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
            <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-2">
              <Package size={14} className="text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Total</span>
              <span className="text-sm font-bold text-foreground">{stats.total}</span>
            </div>
            <div className="hidden sm:flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-2">
              <DollarSign size={14} className="text-emerald-500" />
              <span className="text-xs text-muted-foreground">Valor</span>
              <span className="text-sm font-bold text-emerald-600 dark:text-emerald-400">${stats.valorTotal.toLocaleString()}</span>
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
        data={segData}
        actions={SEG_ACTIONS}
        module="SEG"
        emptyIcon={<Truck size={28} className="text-muted-foreground" />}
        emptyTitle="Sin pedidos en seguimiento"
        emptyDesc="Los pedidos sincronizados desde Dropi aparecerán aquí organizados por estado."
      />
    </div>
  );
}
import { useState, useEffect, useMemo } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { OrderData, isDespachado, dbToOrderData } from '@/lib/orderUtils';
import { RES_ACTIONS } from '@/lib/constants';
import { LifeBuoy, RefreshCw, AlertTriangle, MapPin, RotateCcw, ShieldAlert } from 'lucide-react';
import { motion } from 'framer-motion';
import CrmTable from '@/components/CrmTable';


function isRescueOrder(o: OrderData): boolean {
  const e = o.estado.toUpperCase();
  const diasT = o.diasConf || o.dias;
  return (isDespachado(e) && diasT >= 5) ||
    (e.includes('NOVEDAD') && !o.novedadSol) ||
    e.includes('OFICINA') || e.includes('RECLAME') ||
    e.includes('DEVOL');
}

export default function RescateTab() {
  const { user } = useAuth();
  const [resData, setResData] = useState<OrderData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    setLoading(true);

    const loadOrders = async () => {
      const { data: dbOrders, error } = await supabase
        .from('orders')
        .select('*')
        .not('estado', 'eq', 'PENDIENTE CONFIRMACION')
        .not('estado', 'eq', 'ENTREGADO')
        .not('estado', 'eq', 'CANCELADO')
        .order('created_at', { ascending: false })
        .limit(2000);

      if (error) {
        console.error('Error loading rescue orders:', error);
        setLoading(false);
        return;
      }

      if (dbOrders && dbOrders.length > 0) {
        const orders = dbOrders
          .map((o, idx) => dbToOrderData(o, idx))
          .filter(isRescueOrder);
        setResData(orders);
      }
      setLoading(false);
    };

    loadOrders();
  }, [user]);

  const stats = useMemo(() => {
    let novedades = 0, oficina = 0, devoluciones = 0, retrasados = 0;
    let valorEnRiesgo = 0;
    resData.forEach(o => {
      const e = o.estado.toUpperCase();
      if (e.includes('NOVEDAD') || e === 'INTENTO DE ENTREGA') novedades++;
      else if (e.includes('OFICINA') || e.includes('RECLAME')) oficina++;
      else if (e.includes('DEVOL')) devoluciones++;
      else retrasados++;
      valorEnRiesgo += o.valor;
    });
    return { novedades, oficina, devoluciones, retrasados, valorEnRiesgo };
  }, [resData]);

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col items-center justify-center py-16 gap-4">
          <RefreshCw size={32} className="text-primary animate-spin" />
          <div className="text-center">
            <p className="text-sm font-semibold text-foreground">Cargando rescate...</p>
            <p className="text-xs text-muted-foreground mt-1">Buscando pedidos en riesgo</p>
          </div>
        </div>
      </div>
    );
  }

  const statCards = [
    { label: 'Novedades', value: stats.novedades, icon: <AlertTriangle size={16} />, iconStyle: { background: '#ef4444' }, textColor: 'text-red-600 dark:text-red-400', bg: 'bg-red-500/15 dark:bg-red-500/10' },
    { label: 'En Oficina', value: stats.oficina, icon: <MapPin size={16} />, iconStyle: { background: '#a855f7' }, textColor: 'text-purple-600 dark:text-purple-400', bg: 'bg-purple-500/15 dark:bg-purple-500/10' },
    { label: 'Devoluciones', value: stats.devoluciones, icon: <RotateCcw size={16} />, iconStyle: { background: '#e11d48' }, textColor: 'text-rose-600 dark:text-rose-400', bg: 'bg-rose-500/15 dark:bg-rose-500/10' },
    { label: 'Retrasados 5d+', value: stats.retrasados, icon: <ShieldAlert size={16} />, iconStyle: { background: '#f97316' }, textColor: 'text-orange-600 dark:text-orange-400', bg: 'bg-orange-500/15 dark:bg-orange-500/10' },
  ];

  return (
    <div className="max-w-7xl mx-auto">
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="mb-6 space-y-4"
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl flex items-center justify-center shadow-lg" style={{ background: 'linear-gradient(135deg, #ef4444, #e11d48)', boxShadow: '0 4px 12px rgba(239,68,68,0.3)' }}>
                <LifeBuoy size={18} className="text-white" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-foreground">Rescate</h2>
                <p className="text-xs text-muted-foreground">Pedidos en riesgo que necesitan acción inmediata</p>
              </div>
            </div>
          </div>
          {resData.length > 0 && (
            <div className="hidden sm:flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-2">
              <span className="text-xs text-muted-foreground">Valor en riesgo</span>
              <span className="text-sm font-bold text-red-600 dark:text-red-400">
                ${stats.valorEnRiesgo.toLocaleString('es-CO')}
              </span>
            </div>
          )}
        </div>

        {/* Stats row */}
        {resData.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {statCards.map((s, i) => (
              <motion.div
                key={s.label}
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: i * 0.05, duration: 0.2 }}
                className={`${s.bg} rounded-xl border border-border/40 px-4 py-3 flex items-center gap-3`}
              >
                <div className="w-9 h-9 rounded-lg flex items-center justify-center text-white shadow-md" style={s.iconStyle}>
                  {s.icon}
                </div>
                <div>
                  <p className={`text-lg font-black ${s.textColor}`}>{s.value}</p>
                  <p className="text-[10px] font-medium text-muted-foreground leading-tight">{s.label}</p>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </motion.div>

      <CrmTable
        data={resData}
        actions={RES_ACTIONS}
        module="RESCUE"
        emptyIcon={<LifeBuoy size={28} className="text-muted-foreground" />}
        emptyTitle="Sin pedidos en rescate"
        emptyDesc="Los pedidos en riesgo (D5+, novedades, oficina) aparecerán aquí."
      />
    </div>
  );
}

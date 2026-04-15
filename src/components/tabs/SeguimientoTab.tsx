import { useState, useEffect, useMemo } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { OrderData, isConfirmado, isDespachado, isNovedad, isOficina, isDevolucion } from '@/lib/orderUtils';
import { SEG_ACTIONS } from '@/lib/constants';
import { Truck, RefreshCw, Package, AlertTriangle, MapPin, RotateCcw, Tag, DollarSign } from 'lucide-react';
import { motion } from 'framer-motion';
import CrmTable from '@/components/CrmTable';

function dbToOrderData(o: any, idx: number): OrderData {
  return {
    idx, id: String(idx), externalId: o.external_id || '', dbId: o.id,
    nombre: o.nombre, phone: o.phone, ciudad: o.ciudad || '',
    producto: o.producto || '', estado: o.estado || '', fecha: o.fecha || '',
    fechaConf: o.fecha_conf || '', dias: o.dias || 0, diasConf: o.dias_conf || 0,
    valor: Number(o.valor) || 0, flete: Number(o.flete) || 0,
    costoProd: Number(o.costo_prod) || 0, costoDev: Number(o.costo_dev) || 0,
    cantidad: o.cantidad || 1, direccion: o.direccion || '',
    novedad: o.novedad || '', guia: o.guia || '',
    transportadora: o.transportadora || '', tags: o.tags || '',
    departamento: o.departamento || '', tienda: o.tienda || '',
    novedadSol: o.novedad_sol || false,
  };
}

function isSegOrder(estado: string): boolean {
  const e = estado.toUpperCase();
  return isConfirmado(e) || isDespachado(e) || isNovedad(e) || isOficina(e) || isDevolucion(e);
}

function classifyEstado(estado: string) {
  const e = estado.toUpperCase();
  if (['PENDIENTE', 'ALISTAMIENTO', 'EN PROCESAMIENTO', 'EN BODEGA DROPI', 'RECOGIDO POR DROPI'].includes(e) || (e.includes('BODEGA') && !e.includes('DEVOL'))) return 'bodega';
  if (e === 'GUIA GENERADA' || e === 'GUIA_GENERADA' || e.includes('PREPARADO') || e === 'ENTREGADO A TRANSPORTADORA') return 'guia';
  if (e.includes('REPARTO') || e.includes('DISTRIBUCION') || e.includes('TERMINAL') || e.includes('REEXPEDICION') || e.includes('DESPACHAD') || e.includes('TRANSPORTE') || e === 'ADMITIDA' || e === 'EN DESPACHO') return 'transito';
  if (e === 'NOVEDAD' || e === 'INTENTO DE ENTREGA') return 'novedad';
  if (e.includes('OFICINA') || e.includes('RECLAME')) return 'oficina';
  if (e.includes('DEVOL')) return 'devolucion';
  return 'otros';
}

export default function SeguimientoTab() {
  const { user } = useAuth();
  const [segData, setSegData] = useState<OrderData[]>([]);
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
        console.error('Error loading seg orders:', error);
        setLoading(false);
        return;
      }

      if (dbOrders && dbOrders.length > 0) {
        const orders = dbOrders
          .map((o, idx) => dbToOrderData(o, idx))
          .filter(o => isSegOrder(o.estado));
        setSegData(orders);
      }
      setLoading(false);
    };

    loadOrders();
  }, [user]);

  const stats = useMemo(() => {
    const s = { bodega: 0, guia: 0, transito: 0, novedad: 0, oficina: 0, devolucion: 0, total: segData.length, valorTotal: 0 };
    segData.forEach(o => {
      const cat = classifyEstado(o.estado);
      if (cat in s) (s as any)[cat]++;
      s.valorTotal += o.valor;
    });
    return s;
  }, [segData]);

  const statCards = [
    { label: 'En Tránsito', value: stats.transito, icon: <Truck size={15} />, gradient: 'from-orange-500 to-amber-500' },
    { label: 'Novedades', value: stats.novedad, icon: <AlertTriangle size={15} />, gradient: 'from-red-500 to-rose-500' },
    { label: 'En Oficina', value: stats.oficina, icon: <MapPin size={15} />, gradient: 'from-fuchsia-500 to-purple-600' },
    { label: 'Devoluciones', value: stats.devolucion, icon: <RotateCcw size={15} />, gradient: 'from-rose-600 to-red-600' },
    { label: 'En Bodega', value: stats.bodega, icon: <Package size={15} />, gradient: 'from-blue-500 to-blue-600' },
    { label: 'Guía Generada', value: stats.guia, icon: <Tag size={15} />, gradient: 'from-cyan-500 to-teal-500' },
  ];

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col items-center justify-center py-16 gap-4">
          <RefreshCw size={32} className="text-primary animate-spin" />
          <div className="text-center">
            <p className="text-sm font-semibold text-foreground">Cargando seguimiento...</p>
            <p className="text-xs text-muted-foreground mt-1">Recuperando pedidos despachados</p>
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
              <p className="text-xs text-muted-foreground">CRM de pedidos despachados en tránsito</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
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
          </div>
        </div>

        {/* Stat cards row */}
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
          {statCards.map((card, i) => (
            <motion.div
              key={card.label}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 + i * 0.04, duration: 0.25 }}
              className="bg-card border border-border rounded-xl px-3 py-2.5 flex flex-col items-center gap-1.5"
            >
              <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white"
                style={{ background: `linear-gradient(135deg, var(--tw-gradient-stops))` }}
              >
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-white bg-gradient-to-br ${card.gradient}`}>
                  {card.icon}
                </div>
              </div>
              <span className="text-lg font-black text-foreground leading-none">{card.value}</span>
              <span className="text-[9px] text-muted-foreground font-medium text-center leading-tight">{card.label}</span>
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
        emptyDesc="Los pedidos despachados aparecerán aquí para que puedas rastrear su estado."
      />
    </div>
  );
}

import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { OrderData, isDespachado } from '@/lib/orderUtils';
import { RES_ACTIONS } from '@/lib/constants';
import { LifeBuoy, RefreshCw } from 'lucide-react';
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

  return (
    <div className="max-w-7xl mx-auto">
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="mb-6"
      >
        <h2 className="text-lg font-semibold text-foreground">Rescate</h2>
        <p className="text-xs text-muted-foreground">CRM de pedidos en riesgo que necesitan acción</p>
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

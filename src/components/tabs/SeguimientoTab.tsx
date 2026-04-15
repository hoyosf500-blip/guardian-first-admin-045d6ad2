import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { OrderData, isConfirmado, isDespachado, isNovedad, isOficina, isDevolucion, isPendiente } from '@/lib/orderUtils';
import { SEG_ACTIONS } from '@/lib/constants';
import { Truck, RefreshCw } from 'lucide-react';
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

export default function SeguimientoTab() {
  const { user } = useAuth();
  const [segData, setSegData] = useState<OrderData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    setLoading(true);

    const loadOrders = async () => {
      // Load all non-pending orders (all time, up to 2000)
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
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="mb-6"
      >
        <h2 className="text-lg font-semibold text-foreground">Seguimiento</h2>
        <p className="text-xs text-muted-foreground">CRM de pedidos despachados en tránsito</p>
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

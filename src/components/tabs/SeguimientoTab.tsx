import { useOrders } from '@/contexts/OrderContext';
import { SEG_ACTIONS } from '@/lib/constants';
import { Truck } from 'lucide-react';
import { motion } from 'framer-motion';
import CrmTable from '@/components/CrmTable';

export default function SeguimientoTab() {
  const { segData } = useOrders();

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

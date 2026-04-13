import { useOrders } from '@/contexts/OrderContext';
import { RES_ACTIONS } from '@/lib/constants';
import { LifeBuoy } from 'lucide-react';
import { motion } from 'framer-motion';
import CrmTable from '@/components/CrmTable';

export default function RescateTab() {
  const { resData } = useOrders();

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

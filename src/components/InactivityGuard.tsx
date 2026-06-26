import { useOrders } from '@/contexts/OrderContext';
import { useInactivityGuard } from '@/hooks/useInactivityGuard';
import InactivityWarningModal from '@/components/InactivityWarningModal';
import { hasSeguimientoWork } from '@/lib/segLists';

/**
 * Monta el guard de inactividad DENTRO de OrderProvider para poder leer los
 * pendientes reales (Confirmar / Novedades / Seguimiento) y NO penalizar cuando
 * no hay nada que hacer. El hook tiene sus propios gates (solo operadoras puras,
 * horario laboral). Renderiza el modal solo cuando hay un aviso activo.
 */
export default function InactivityGuard() {
  const { workQueue, segData, novedadesQueue } = useOrders();

  const hasPendingWork =
    workQueue.some((o) => !o.result) ||      // Confirmar: pedidos sin gestionar
    novedadesQueue.length > 0 ||             // Novedades abiertas
    hasSeguimientoWork(segData);             // Seguimiento: listas accionables

  const { warning, acknowledge } = useInactivityGuard({ hasPendingWork });

  if (!warning) return null;
  return <InactivityWarningModal warning={warning} onAcknowledge={acknowledge} />;
}

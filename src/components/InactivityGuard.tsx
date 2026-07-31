import { useMemo } from 'react';
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

  // Memoizado por REFERENCIA de las colas: este componente vive bajo
  // OrderProvider y se re-renderiza con cada cambio del context (counter, sets
  // de cobertura, cada push de realtime). Sin memo, el caso "no hay nada
  // accionable" —justo el que esta función existe para detectar— recorría los
  // miles de pedidos de segData contra los predicados SLA (calcBusinessDays
  // adentro) en cada tick. smartMerge conserva la referencia cuando nada cambió
  // de fondo, así que el memo casi nunca recomputa.
  const hasPendingWork = useMemo(
    () =>
      workQueue.some((o) => !o.result) ||    // Confirmar: pedidos sin gestionar
      novedadesQueue.length > 0 ||           // Novedades abiertas
      hasSeguimientoWork(segData),           // Seguimiento: listas accionables
    [workQueue, novedadesQueue, segData],
  );

  const { warning, acknowledge } = useInactivityGuard({ hasPendingWork });

  if (!warning) return null;
  return <InactivityWarningModal warning={warning} onAcknowledge={acknowledge} />;
}

import { useMemo } from 'react';
import { useOrders } from '@/contexts/OrderContext';
import { useStore } from '@/contexts/StoreContext';
import { useAuth } from '@/contexts/AuthContext';
import { useInactivityGuard } from '@/hooks/useInactivityGuard';
import { useSinGestionNudge } from '@/hooks/useSinGestionNudge';
import { useSegTouchIndex } from '@/hooks/useSegTouchIndex';
import InactivityWarningModal from '@/components/InactivityWarningModal';
import { hasSeguimientoWork } from '@/lib/segLists';
import { segVisiblesParaCola } from '@/lib/segVisibles';

/**
 * Monta el guard de inactividad DENTRO de OrderProvider para poder leer los
 * pendientes reales (Confirmar / Novedades / Seguimiento) y NO penalizar cuando
 * no hay nada que hacer. El hook tiene sus propios gates (solo operadoras puras,
 * horario laboral). Renderiza el modal solo cuando hay un aviso activo.
 */
export default function InactivityGuard() {
  const { workQueue, segData, novedadesQueue } = useOrders();
  const { activeStoreId, isManagerOfActive } = useStore();
  const { isAdmin } = useAuth();
  // Los cierres del equipo, para no regañar por trabajo YA hecho. El canal
  // realtime del hook lleva nombre por instancia (useId), así que montarlo acá
  // además de en la barra y en Seguimiento no colisiona.
  const { closed } = useSegTouchIndex(activeStoreId);

  // Memoizado por REFERENCIA de las colas: este componente vive bajo
  // OrderProvider y se re-renderiza con cada cambio del context (counter, sets
  // de cobertura, cada push de realtime). Sin memo, el caso "no hay nada
  // accionable" —justo el que esta función existe para detectar— recorría los
  // miles de pedidos de segData contra los predicados SLA (calcBusinessDays
  // adentro) en cada tick. smartMerge conserva la referencia cuando nada cambió
  // de fondo, así que el memo casi nunca recomputa.
  //
  // `segVisiblesParaCola`: la MISMA población filtrada que la pantalla y que la
  // barra «Lo que sigue» — el invariante guardián (guard ve trabajo ⟹ la barra
  // no dice "al día") solo se sostiene si los dos filtran IGUAL. Con segData
  // crudo, el guard regañaba por pedidos que el equipo ya cerró.
  const hasPendingWork = useMemo(
    () =>
      workQueue.some((o) => !o.result) ||    // Confirmar: pedidos sin gestionar
      novedadesQueue.length > 0 ||           // Novedades abiertas
      hasSeguimientoWork(segVisiblesParaCola(segData, closed, Date.now())),
    [workQueue, novedadesQueue, segData, closed],
  );

  const { warning, acknowledge } = useInactivityGuard({ hasPendingWork });

  // Aviso SUAVE por huecos sin gestionar (no bloquea, no cuenta falta). Mismo
  // universo que el guard duro: solo operadora pura (ni admin, ni dueño, ni
  // supervisor) — a un manager este recordatorio le mentiría.
  useSinGestionNudge({ hasPendingWork, enabled: !isAdmin && !isManagerOfActive });

  if (!warning) return null;
  return <InactivityWarningModal warning={warning} onAcknowledge={acknowledge} />;
}

import { useMemo } from 'react';
import { useOrders } from '@/contexts/OrderContext';
import { useStore } from '@/contexts/StoreContext';
import { useAuth } from '@/contexts/AuthContext';
import { useInactivityGuard } from '@/hooks/useInactivityGuard';
import { useSinGestionNudge } from '@/hooks/useSinGestionNudge';
import { useSegTouchIndex } from '@/hooks/useSegTouchIndex';
import { usePausaTrabajo } from '@/hooks/usePausaTrabajo';
import InactivityWarningModal from '@/components/InactivityWarningModal';
import BotonPausaTrabajo from '@/components/BotonPausaTrabajo';
import { hasSeguimientoWork } from '@/lib/segLists';
import { trabajaLaCola } from '@/lib/rolesTrabajo';
import { segVisiblesParaCola } from '@/lib/segVisibles';

/**
 * Monta el guard de inactividad DENTRO de OrderProvider para poder leer los
 * pendientes reales (Confirmar / Novedades / Seguimiento) y NO penalizar cuando
 * no hay nada que hacer. El hook tiene sus propios gates (solo operadoras puras,
 * horario laboral). Renderiza el modal solo cuando hay un aviso activo.
 */
export default function InactivityGuard() {
  const { workQueue, segData, novedadesQueue } = useOrders();
  const { activeStoreId, isOwnerOfActive } = useStore();
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

  // ⛔ A QUIÉN SE LE MIDE EL TRABAJO: operadora **y supervisor** (28-ago-2026,
  // pedido del dueño: "el supervisor también trabaja, solo es un rango más que
  // el operador, así que lo que él haga tenerlo en cuenta").
  //
  // Esto decía `!isAdmin && !isManagerOfActive`, y `isManagerOfActive` es
  // «dueño O supervisor»: dejaba a Roberto —el que de verdad trabaja la cola de
  // Ecuador— del lado de los jefes. Consecuencia medible: nunca recibía el
  // aviso por huecos sin gestionar, y **no tenía el botón «Estoy en otra
  // cosa»**, así que una ida a la agencia no la podía declarar nadie más que
  // sus operadoras. Se le contaba el trabajo en el reparto y en Productividad,
  // pero no se le daba ninguna de las herramientas del que trabaja.
  //
  // Al dueño no se le ofrece nada de esto: no se le mide.
  const mide = trabajaLaCola({ isAdmin, isOwnerOfActive });
  const pausaT = usePausaTrabajo(mide);

  // El modal que BLOQUEA la pantalla 5 minutos sigue siendo solo para la
  // operadora — el hook lo decide con `seLeBloqueaLaPantalla`, y ahí está
  // escrito por qué esa reja es más estrecha a propósito.
  const { warning, acknowledge } = useInactivityGuard({ hasPendingWork, enPausa: pausaT.vigente });

  // Aviso SUAVE por huecos sin gestionar (no bloquea, no cuenta falta): va a
  // todo el que trabaja la cola, supervisor incluido.
  useSinGestionNudge({ hasPendingWork, enabled: mide && !pausaT.vigente });

  return (
    <>
      {/* `disponible === false` = la migración de `operator_pausas` no está
          aplicada (Lovable no las aplica solas). No se dibuja el botón: uno que
          existe y falla al tocarlo es peor que ninguno — el asesor creería que
          declaró su pausa y el sistema lo acusaría igual. */}
      {mide && pausaT.disponible && (
        <BotonPausaTrabajo
          pausa={pausaT.pausa}
          vigente={pausaT.vigente}
          trabajando={pausaT.trabajando}
          ahora={pausaT.ahora}
          onIniciar={pausaT.iniciar}
          onTerminar={pausaT.terminar}
        />
      )}
      {warning && <InactivityWarningModal warning={warning} onAcknowledge={acknowledge} />}
    </>
  );
}

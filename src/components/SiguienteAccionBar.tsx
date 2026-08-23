import { useEffect, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { AlertTriangle, MapPin, Phone, Clock, RotateCcw, Truck, Check, ArrowRight } from 'lucide-react';
import { useOrders } from '@/contexts/OrderContext';
import { useStore } from '@/contexts/StoreContext';
import { useAuth } from '@/contexts/AuthContext';
import { siguienteAccion, type AccionKey } from '@/lib/siguienteAccion';
import { segVisiblesParaCola } from '@/lib/segVisibles';
import { useSegTouchIndex } from '@/hooks/useSegTouchIndex';
import { cn } from '@/lib/utils';

/**
 * "Lo que sigue" — la barra que le dice a la persona qué hacer AHORA.
 *
 * Es la pieza A del protocolo del turno (21-ago-2026). Guardian ya calculaba
 * esto cada segundo dentro de `InactivityGuard` y lo reducía a un `true/false`
 * para decidir si mostraba el regaño por inactividad: sabía dirigir y solo se
 * usaba para regañar. Acá se muestra.
 *
 * El orden lo decide `siguienteAccion` (puro y testeado) y es **por lo que se
 * pierde si espera un día más**, no por antigüedad. La asesora no elige entre
 * pantallas: si tuviera que elegir iría a la más cómoda, y la más cómoda nunca
 * es la que vence.
 *
 * Dos detalles que no son cosméticos:
 *  - **Al dueño y al supervisor se les habla en neutro** (`etiqueta`), no en
 *    imperativo. Ellos miran el estado de la cola, no la trabajan; darle una
 *    orden a quien no ejecuta es ruido. Y es justo lo que el dueño reportó que
 *    le faltaba: `SegCounterBar` está oculto para él, así que hoy ve MENOS que
 *    su equipo.
 *  - **En la pantalla del escalón activo la barra no se dibuja.** Si ya está en
 *    /novedades y lo que toca son novedades, repetírselo arriba es ruido puro.
 */

const ICONO: Record<AccionKey, typeof AlertTriangle> = {
  cargando:    Clock,
  novedades:   AlertTriangle,
  agencia:     MapPin,
  confirmar:   Phone,
  detenidos:   Clock,
  rescate:     RotateCcw,
  seguimiento: Truck,
  al_dia:      Check,
};

// Tonos del DS. `urgente` usa danger porque vence en horas; `atencion` warning.
const TONO = {
  urgente:  { caja: 'border-danger/30 bg-danger/10',   texto: 'text-danger',   btn: 'bg-danger/15 border-danger/40 text-danger hover:bg-danger/25' },
  atencion: { caja: 'border-warning/30 bg-warning/10', texto: 'text-warning',  btn: 'bg-warning/15 border-warning/40 text-warning hover:bg-warning/25' },
  normal:   { caja: 'border-accent/25 bg-accent/8',    texto: 'text-accent',   btn: 'bg-accent/15 border-accent/40 text-accent hover:bg-accent/25' },
  listo:    { caja: 'border-success/25 bg-success/8',  texto: 'text-success',  btn: '' },
} as const;

export default function SiguienteAccionBar() {
  const { workQueue, segData, segLoaded, novedadesQueue, loadSegData } = useOrders();
  const { isManagerOfActive, activeStoreId } = useStore();
  const { isAdmin } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // ⛔ La barra CARGA la cola de Seguimiento (21-ago-2026, verificado en vivo).
  //
  // Hasta hoy `loadSegData()` lo llamaba SOLO `SeguimientoTab` — y esta barra se
  // esconde justamente en `/seguimiento`. Resultado medido en el Dashboard de
  // Colombia: la barra decía "Todo al día" en verde mientras había 7 pedidos
  // detenidos y 5 paquetes esperando en una agencia. Cuatro de los seis
  // escalones no podían dispararse nunca porque su fuente llegaba vacía.
  //
  // Es la misma query que ya corre en Seguimiento (~un centenar de filas, sin
  // terminales) y `segLoaded` evita repetirla: si la asesora entra después al
  // tablero, ya está cargada.
  useEffect(() => { void loadSegData(); }, [loadSegData]);

  // Memoizado por REFERENCIA de las colas, igual que InactivityGuard: este
  // componente vive bajo OrderProvider y se re-renderiza con cada cambio del
  // context (contadores, sets de cobertura, cada push de realtime). Sin memo,
  // recorrería miles de pedidos contra los predicados SLA en cada render.
  // El aviso de agencia («Avisé: en oficina») sale del MISMO índice de
  // touchpoints que ya usa el tablero: sin él, la barra manda a avisar a gente
  // a la que el equipo ya avisó, y una barra que pide trabajo hecho se aprende
  // a ignorar.
  const { closed, avisosAgencia } = useSegTouchIndex(activeStoreId);

  // La MISMA población que muestra la pantalla de Seguimiento (ventana 45d +
  // dedup + cierres del equipo). Con segData crudo la barra contaba trabajo
  // que la pantalla ya descarta — pedidos cerrados ayer, duplicados, pedidos
  // de hace dos meses — y mandaba a rehacer trabajo hecho.
  const segVisibles = useMemo(
    () => segVisiblesParaCola(segData, closed, Date.now()),
    [segData, closed],
  );

  const accion = useMemo(
    () => siguienteAccion({ workQueue, novedadesQueue, segData: segVisibles, segCargado: segLoaded, avisosAgencia }),
    [workQueue, novedadesQueue, segVisibles, segLoaded, avisosAgencia],
  );

  // Todavía no se leyó la cola: no se dibuja NADA. Un "Todo al día" en verde
  // mientras se carga es una afirmación sobre datos que no se tienen.
  if (accion.key === 'cargando') return null;

  // Ya está parada en la pantalla del escalón: decírselo otra vez es ruido.
  const rutaBase = accion.ruta.split('?')[0];
  if (accion.key !== 'al_dia' && location.pathname === rutaBase) return null;

  // El dueño/supervisor/admin lee el estado; la asesora recibe la instrucción.
  const mira = isManagerOfActive || isAdmin;
  const t = TONO[accion.tono];
  const Icono = ICONO[accion.key];

  if (accion.key === 'al_dia') {
    return (
      <div className={cn('mb-3 flex items-center gap-2.5 rounded-2xl border px-4 py-2.5', t.caja)}>
        <Check size={15} className={cn('flex-shrink-0', t.texto)} aria-hidden="true" />
        <span className={cn('text-xs font-semibold', t.texto)}>Todo al día</span>
        <span className="text-[11px] text-muted-foreground min-w-0 truncate">{accion.porque}</span>
      </div>
    );
  }

  return (
    <div
      className={cn('mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border px-4 py-3 shadow-card3d', t.caja)}
      // `status` y no `alert`: es información persistente del turno, no una
      // interrupción. Un `alert` haría que el lector de pantalla la anuncie
      // cada vez que cambia el conteo, que cambia con cada push de realtime.
      role="status"
    >
      <Icono size={17} className={cn('flex-shrink-0', t.texto)} aria-hidden="true" />

      <div className="min-w-0 flex-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-[10px] font-mono uppercase tracking-[0.14em] text-muted-foreground">
          {mira ? 'La cola' : 'Lo que sigue'}
        </span>
        <span className={cn('text-sm font-semibold', t.texto)}>
          {mira ? accion.etiqueta : accion.titulo}
        </span>
        <span className="text-[11px] text-muted-foreground">{accion.porque}</span>
      </div>

      <button
        type="button"
        onClick={() => navigate(accion.ruta)}
        className={cn(
          'flex-shrink-0 inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5',
          'text-[11px] font-semibold transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current',
          t.btn,
        )}
      >
        {mira ? 'Ver' : 'Ir'} <ArrowRight size={12} aria-hidden="true" />
      </button>
    </div>
  );
}

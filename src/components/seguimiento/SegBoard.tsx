import { Fragment, memo, useMemo, useRef, useState, useEffect, useLayoutEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Package, Tag, Truck, MapPin, AlertTriangle, CheckCircle, RotateCcw,
  DollarSign, Layers, ExternalLink, RefreshCw, MessageCircle, Phone,
  ChevronUp, ChevronDown, ChevronLeft, Maximize2, CheckCircle2,
} from 'lucide-react';
import { OrderData, getTrackingUrl, getWhatsAppPhone, calcBusinessDays, parseDate } from '@/lib/orderUtils';
import { classifySegEstado, type SegStatusKey } from '@/lib/segStatus';
import { metodosRapidosParaEstado, esContactoEfectivo, faseConGestion } from '@/lib/segMetodosEstado';
import { haceCuanto, type GestionDelPedido } from '@/lib/gestionPorPedido';
import { FASES_VIVAS, HORAS_DETENIDO, horasSinMovimiento } from '@/lib/segPulso';
import { useOperatorNames } from '@/hooks/useOperatorNames';
import { calcPriority, getPriorityLevel, PRIORITY_CONFIG } from '@/lib/alertSystem';
import { useRefreshOrder } from '@/hooks/useRefreshOrder';
import { useRecordGestion } from '@/hooks/useRecordGestion';
import { useStore } from '@/contexts/StoreContext';
import { useWaChat } from '@/contexts/WaChatContext';
import { useSessionState } from '@/hooks/useSessionState';
import { TiltCard } from '@/components/ui3d';
import { cn, formatCOP } from '@/lib/utils';

/**
 * SegBoard — tablero estilo Kommo para /seguimiento. Columnas por estado de
 * Dropi (misma taxonomía que el resumen: classifySegEstado), tarjetas que se
 * mueven SOLAS en vivo (renderiza directo desde `data`, que OrderContext
 * mantiene fresco con realtime — sin el buffer "N cambios" de CrmTable).
 *
 * Click en una tarjeta → ficha completa (/pedido/:externalId) con todas las
 * acciones. Acciones rápidas inline: WhatsApp, refrescar contra Dropi, rastreo.
 * Preserva el scroll por columna entre re-renders (useLayoutEffect), para que
 * la operadora no pierda su lugar cuando una tarjeta salta de columna.
 */

type Tone = 'neutral' | 'info' | 'accent' | 'warning' | 'danger' | 'success' | 'muted';

/**
 * Una columna del tablero.
 *
 * `key` es string y no SegStatusKey porque las columnas de estados sin mapear se
 * generan en vivo (una por estado real de Dropi, key `otros:<ESTADO>`). `baseKey`
 * guarda el bucket del clasificador: es lo que miran LIVE_KEYS/CATCHALL_KEYS y el
 * filtro por estado, así una columna generada sigue comportándose como su bucket.
 */
interface ColumnDef { key: string; baseKey: SegStatusKey; label: string; icon: React.ReactNode; tone: Tone; }

// Orden de pipeline (izq → der), estilo embudo logístico. ESTE ORDEN NO SE
// TOCA en un pase visual: las asesoras lo tienen memorizado y moverlo es
// arquitectura de información, no dibujo.
//
// Ya NO hay columna "Otros". Era un cajón de 100+ pedidos que no decía nada:
// "Otros" no es un estado, es la ausencia de uno. Los pedidos cuyo estado de
// Dropi no cae en ninguna de estas fases reciben AHORA una columna propia,
// generada en vivo y rotulada con el estado tal cual lo manda Dropi (ver
// `columnasDeEstadosSinMapear`), así el dueño ve el estado exacto de cada
// pedido y no una bolsa.
const BOARD_COLUMNS: ColumnDef[] = [
  { key: 'procesamiento', baseKey: 'procesamiento', label: 'En Procesamiento', icon: <Package size={13} />, tone: 'neutral' },
  { key: 'guia', baseKey: 'guia', label: 'Guía Generada', icon: <Tag size={13} />, tone: 'info' },
  { key: 'bodega_trans', baseKey: 'bodega_trans', label: 'Bodega Transp.', icon: <Package size={13} />, tone: 'neutral' },
  { key: 'transito', baseKey: 'transito', label: 'En Tránsito', icon: <Truck size={13} />, tone: 'info' },
  { key: 'reparto', baseKey: 'reparto', label: 'En Reparto', icon: <Truck size={13} />, tone: 'accent' },
  { key: 'oficina', baseKey: 'oficina', label: 'En Oficina', icon: <MapPin size={13} />, tone: 'warning' },
  { key: 'novedad', baseKey: 'novedad', label: 'Novedad', icon: <AlertTriangle size={13} />, tone: 'warning' },
  { key: 'novedad_sol', baseKey: 'novedad_sol', label: 'Nov. Solucionada', icon: <CheckCircle size={13} />, tone: 'success' },
  { key: 'entregado', baseKey: 'entregado', label: 'Entregado', icon: <CheckCircle size={13} />, tone: 'success' },
  { key: 'rechazado', baseKey: 'rechazado', label: 'Rechazado', icon: <AlertTriangle size={13} />, tone: 'danger' },
  { key: 'devolucion_transito', baseKey: 'devolucion_transito', label: 'Dev. en Tránsito', icon: <RotateCcw size={13} />, tone: 'danger' },
  { key: 'devolucion', baseKey: 'devolucion', label: 'Devolución', icon: <RotateCcw size={13} />, tone: 'danger' },
  { key: 'indemnizada', baseKey: 'indemnizada', label: 'Indemnizada', icon: <DollarSign size={13} />, tone: 'muted' },
  { key: 'cancelado', baseKey: 'cancelado', label: 'Cancelado', icon: <Layers size={13} />, tone: 'muted' },
];

/**
 * Una columna POR ESTADO real para todo lo que el clasificador no mapea.
 *
 * El rótulo es el `estado` tal cual viene de Dropi — no se traduce ni se
 * embellece: es el dato crudo y el dueño necesita leer exactamente eso para
 * decirnos a qué fase pertenece. Se ordenan por volumen (la más grande primero)
 * porque es la que hay que mapear primero.
 *
 * Un pedido sin estado no se esconde: cae en "Sin estado en Dropi", que es un
 * hecho a mirar (fila incompleta), no un pedido menos.
 */
function columnasDeEstadosSinMapear(sinMapear: OrderData[]): (ColumnDef & { orders: OrderData[] })[] {
  const porEstado = new Map<string, OrderData[]>();
  for (const o of sinMapear) {
    const etiqueta = (o.estado || '').trim() || 'Sin estado en Dropi';
    const arr = porEstado.get(etiqueta);
    if (arr) arr.push(o); else porEstado.set(etiqueta, [o]);
  }
  return Array.from(porEstado.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .map(([etiqueta, orders]) => ({
      key: `otros:${etiqueta}`,
      baseKey: 'otros' as SegStatusKey,
      label: etiqueta,
      icon: <Layers size={13} />,
      tone: 'neutral' as Tone,
      orders,
    }));
}

/**
 * Fases donde TODAVÍA se puede hacer algo. Las que no están acá son terminales
 * (el pedido ya llegó a su desenlace) y se dibujan como un grupo atenuado y más
 * angosto al final: siguen enteras y clicables, pero dejan de pesar lo mismo
 * que "En Reparto", que es donde se decide la entrega.
 *
 * Es el MISMO conjunto que usa el contador DETENIDOS de la tarjeta de arriba,
 * así que se importa en vez de repetirse: eran dos listas idénticas escritas a
 * mano en dos archivos, y el día que alguien agregara una fase a una sola, los
 * puntos de las tarjetas y el número de arriba habrían empezado a discrepar.
 */
const LIVE_KEYS = FASES_VIVAS;

/**
 * Los estados sin mapear no son ni VIVOS ni TERMINALES: no sabemos qué son, y
 * eso mismo es la señal de que hay drift de Dropi (sobre todo en EC). Van al
 * final del embudo pero NO se atenúan con el grupo terminal: atenuar lo único
 * que avisa de un estado desconocido era apagar justo la alarma. Quedan
 * angostos (no compiten con las fases vivas) pero a opacidad plena.
 */
const CATCHALL_KEYS = new Set<SegStatusKey>(['otros']);

/**
 * HISTORIA — las tres fases donde NO se puede hacer absolutamente nada.
 *
 * El tablero tiene 14 columnas y el dueño reportó "mucho ruido visual". De esas
 * 14, estas tres no le dan trabajo a nadie: un pedido entregado, uno cancelado
 * y uno ya indemnizado están cerrados. Mirarlos no cambia ningún resultado.
 * Por defecto se pliegan detrás de un botón; nada se borra.
 *
 * `devolucion` y `devolucion_transito` NO van acá aunque sean terminales: ahí
 * SÍ hay trabajo (la llamada de rescate — en julio, 32 de 49 pedidos
 * re-emitidos terminaron entregados). Y `rechazado` tampoco: es una entrega que
 * falló, no una historia cerrada. La regla de corte es "¿alguien puede hacer
 * algo con esto?", no "¿está terminado?".
 */
export const HISTORIA_KEYS = new Set<SegStatusKey>(['entregado', 'cancelado', 'indemnizada']);

// Cada tono aporta: punto con glow (acento semántico del encabezado), la barra
// superior de la columna, el chip de conteo (color + número, nunca color solo),
// y el color/glow de la cifra cuando el conteo toma peso de KPI en el header.
// `numGlow` solo se declara donde index.css define el token (accent/success/
// danger); el resto va vacío en vez de inventar una clase inexistente.
const TONE: Record<Tone, { dot: string; headBar: string; count: string; num: string; numGlow: string }> = {
  neutral: { dot: 'bg-muted-foreground/50', headBar: 'border-t-muted-foreground/40', count: 'bg-muted/50 text-muted-foreground border border-border', num: 'text-foreground', numGlow: '' },
  info: { dot: 'bg-info glow-info', headBar: 'border-t-info', count: 'bg-info/14 text-info border border-info/30', num: 'text-info', numGlow: '' },
  accent: { dot: 'bg-accent glow-accent', headBar: 'border-t-accent', count: 'bg-accent/14 text-accent border border-accent/30', num: 'text-accent', numGlow: 'num-glow-accent' },
  warning: { dot: 'bg-warning glow-warning', headBar: 'border-t-warning', count: 'bg-warning/14 text-warning border border-warning/30', num: 'text-warning', numGlow: '' },
  danger: { dot: 'bg-danger glow-danger', headBar: 'border-t-danger', count: 'bg-danger/14 text-danger border border-danger/30', num: 'text-danger', numGlow: 'num-glow-danger' },
  success: { dot: 'bg-success glow-success', headBar: 'border-t-success', count: 'bg-success/14 text-success border border-success/30', num: 'text-success', numGlow: 'num-glow-success' },
  muted: { dot: 'bg-muted-foreground/40', headBar: 'border-t-border-strong', count: 'bg-muted/40 text-muted-foreground border border-border', num: 'text-muted-foreground', numGlow: '' },
};

/**
 * Tarjetas montadas de entrada por columna. El tablero es la vista POR DEFECTO
 * de /seguimiento y montaba de un saque todas las de la ventana de 45 días: con
 * ~700 pedidos activos son decenas de miles de nodos DOM (cada SegCard son ~40 +
 * sus hooks + calcPriority/calcBusinessDays en render) → segundos de pantalla
 * congelada al entrar en celular. La columna ya tiene scroll propio, así que 30
 * cubren de sobra lo visible; el resto entra con "Ver más".
 */
const COLUMN_PAGE = 30;

function statusAgeDays(o: OrderData): number {
  const base = (o.fechaConf || o.fecha || '').trim();
  if (base && base !== 'undefined') return calcBusinessDays(base);
  return o.diasConf || o.dias || 0;
}

/** Horas desde el último movimiento real en Dropi (para el punto de frescura).
 *  Vive en `segPulso` desde el 1-ago-2026: lo comparte con el contador
 *  DETENIDOS de la tarjeta de arriba. Tener dos copias de esta cuenta es cómo
 *  los puntos y el número terminan diciendo cosas distintas. */
const hoursSinceMovement = horasSinMovimiento;

/**
 * Punto de frescura: hace cuánto se movió el pedido EN DROPI de verdad.
 *
 * CUATRO estados, y el cuarto es "no sé": sin `lastMovementAt` va GRIS, nunca
 * verde ni rojo. Esa distinción es la que impide que un pedido sin dato se lea
 * como un pedido sano — no se toca.
 *
 * Lo que cambia es el DIBUJO: era un punto de 2px que comunicaba una decisión
 * solo con color, algo que el lenguaje del Dashboard no hace en ningún lado.
 * Ahora es una pastilla tonal con anillo y glow (salvo el gris de "no sé", que
 * a propósito NO lleva glow: un estado desconocido no debe brillar como los
 * medidos). El texto sigue viajando íntegro en `title` + en el `sr-only`.
 */
function freshnessDot(o: OrderData): { cls: string; ring: string; title: string; sinDato?: boolean } {
  const h = hoursSinceMovement(o);
  if (h == null) {
    // ⛔ "No sé" NO es "está bien" (21-ago-2026). Medido en producción: 46 de
    // los 228 pedidos vivos —uno de cada cinco— no tienen fecha de último
    // movimiento. Ese pedido queda FUERA de todas las alarmas: `estaDetenido`
    // devuelve false, no entra a ninguna lista de estancados y cae al fondo del
    // orden. Es justo el pedido al que hay que ir a mirar y es el único que
    // nadie ve. Hasta hoy solo lo delataba un punto gris cuyo texto vivía en el
    // `title` — invisible en el celular, que es donde se trabaja.
    const fase = classifySegEstado(o.estado || '');
    const vivo = fase === 'otros' || FASES_VIVAS.has(fase);
    return {
      cls: 'bg-muted-foreground/40',
      ring: 'ring-muted-foreground/20',
      title: vivo
        ? 'Sin fecha de último movimiento: Guardian no sabe hace cuánto está así. Refrescalo desde Dropi.'
        : 'Sin fecha de último movimiento',
      sinDato: vivo,
    };
  }
  // Un pedido que YA llegó a su desenlace no está "detenido": está terminado.
  // Pintarlo en rojo por llevar diez días quieto es una alarma falsa sobre algo
  // que nadie tiene que ir a destrabar. Además descuadraba la pantalla: el
  // contador DETENIDOS de arriba (que sí excluye los terminales) decía 23
  // mientras abajo había 25 puntos rojos — dos de ellos en "Cancelado".
  // Solo se declara "cerrado" lo que se SABE cerrado. Un estado que Dropi
  // invente mañana cae en 'otros', que no está en FASES_VIVAS — y con el guard
  // escrito al revés (todo lo que no es fase viva = cerrado) esas tarjetas se
  // pintaban grises diciendo "Cerrado", o sea afirmando que el pedido terminó,
  // cuando en realidad nadie sabe dónde está. Justo el caso de los 238 pedidos
  // EC sin clasificar de julio. Ahora 'otros' sigue el camino normal y puede
  // ponerse rojo: mejor una alarma sobre algo desconocido que un falso "ya está".
  const fase = classifySegEstado(o.estado || '');
  if (fase !== 'otros' && !FASES_VIVAS.has(fase)) {
    return {
      cls: 'bg-muted-foreground/40',
      ring: 'ring-muted-foreground/20',
      title: `Cerrado — último movimiento hace ${Math.floor(h / 24)} días`,
    };
  }
  if (h < 24) return { cls: 'bg-success glow-success', ring: 'ring-success/25', title: 'Movido en las últimas 24 h' };
  if (h < HORAS_DETENIDO) return { cls: 'bg-warning glow-warning', ring: 'ring-warning/25', title: `Sin moverse hace ${Math.floor(h / 24)}–${Math.ceil(h / 24)} días` };
  return { cls: 'bg-danger glow-danger', ring: 'ring-danger/25', title: `Sin moverse hace ${Math.floor(h / 24)} días` };
}

const SegCard = memo(function SegCard({ o, countryCode, tone, selected, cardRef, onOpen, touchedTodayPhones, gestionEquipo, nombreDe }: { o: OrderData; countryCode?: string | null; tone?: Tone; selected?: boolean; cardRef?: React.Ref<HTMLDivElement>; onOpen?: () => void; touchedTodayPhones?: Set<string>; gestionEquipo?: Map<string, GestionDelPedido>; nombreDe?: (id?: string | null) => string }) {
  const navigate = useNavigate();
  const { refresh, isRefreshing } = useRefreshOrder();
  const { activeStoreId } = useStore();
  const { openChat, waEnabled } = useWaChat();
  const recordGestion = useRecordGestion();
  // Guarda la ACCIÓN elegida (no un booleano): la tarjeta confirma "Envié la
  // guía ✓" en vez de un "listo" que no dice qué se hizo.
  const [gestionada, setGestionada] = useState<string | null>(null);
  const [gestionando, setGestionando] = useState(false);
  // Guard SÍNCRONO contra doble-tap: el estado se actualiza en el próximo render,
  // así que dos clicks en el mismo frame verían gestionando=false los dos e
  // insertarían dos touchpoints (touchpoints no tiene constraint anti-dup).
  const enVueloRef = useRef(false);
  const open = () => { if (onOpen) onOpen(); else if (o.externalId) navigate(`/pedido/${o.externalId}`); };

  // Gestionado HOY según la FUENTE DE VERDAD (touchpoints del día, vía
  // mySegTouchedToday del OrderContext) — no solo el useState de ESTA montada.
  // Sin esto, al destildar "Ocultar gestionados" (o si se pierde el evento
  // realtime) la tarjeta renacía con el botón pendiente y reclickear insertaba
  // OTRO touchpoint (touchpoints no tiene constraint anti-dup), inflando las
  // métricas de productividad. El useState local se conserva como respuesta
  // inmediata al click, antes de que el realtime actualice el set.
  // Gestion del EQUIPO sobre este telefono hoy (quien, que metodo, a que hora).
  const gEquipo = o.phone ? gestionEquipo?.get(o.phone) : undefined;
  // Cuenta como gestionada si la trabajo CUALQUIERA, no solo yo. Antes solo
  // miraba `touchedTodayPhones` (personal): a una asesora le seguia apareciendo
  // como pendiente un pedido que otra ya habia trabajado esa manana, y volver a
  // tocar el boton insertaba OTRO touchpoint (la tabla no tiene anti-duplicado)
  // — doble contacto al cliente y metricas de productividad infladas.
  // Una gestion del EQUIPO da la tarjeta por atendida SOLO si se hablo con el
  // cliente. Un "No contesto" de una companera NO puede bloquearla: el pedido
  // sigue necesitando trabajo y otra asesora tiene que poder reintentar.
  // (Bug del 31-jul: bloqueaba para todas y —con "Ocultar gestionados", que
  // viene activado— la tarjeta desaparecia del tablero de todo el equipo el
  // resto del dia. El que no atendio a la primera se volvia invisible.)
  // La gestion PROPIA sigue bloqueando siempre: acabo de registrarla y volver a
  // tocar el boton insertaria un touchpoint duplicado.
  const gEquipoEfectiva = !!gEquipo && esContactoEfectivo(gEquipo.ultimoResult);
  const yaGestionada = !!gestionada || gEquipoEfectiva || (!!o.phone && !!touchedTodayPhones?.has(o.phone));

  // Acciones del tablero: registran el touchpoint (SEG: <acción>) para que el
  // contador se mueva y —con "ocultar gestionados"— la tarjeta desaparezca vía
  // el realtime de OrderContext (mySegTouchedToday).
  //
  // Ya NO es un "Gestioné hoy" genérico: la acción dice QUÉ pasó, y sale del
  // ESTADO del pedido (guía → "Envié la guía"; oficina → "Cliente recoge"…).
  // El botón genérico obligaba a abrir la ficha para dejar constancia de lo que
  // realmente ocurrió, así que en la práctica nadie lo hacía y la bitácora
  // quedaba con 300 "Gestioné hoy" que no dicen nada.
  const gestionar = async (e: React.MouseEvent, metodo: string) => {
    e.stopPropagation();
    if (enVueloRef.current || yaGestionada || !o.phone) return;
    enVueloRef.current = true;
    setGestionando(true);
    const ok = await recordGestion(o.phone, 'SEG', metodo);
    setGestionando(false);
    enVueloRef.current = false;
    if (ok) {
      setGestionada(metodo);
      toast.success(metodo);
    } else {
      toast.error('No se pudo registrar. Reintentá.');
    }
  };

  const trackUrl = getTrackingUrl(o.transportadora, o.guia, countryCode);
  const carrierHome = getTrackingUrl(o.transportadora, '', countryCode);
  const dias = statusAgeDays(o);
  const priority = calcPriority(o);
  const pLevel = getPriorityLevel(priority);
  const pConfig = PRIORITY_CONFIG[pLevel];
  const fresh = freshnessDot(o);
  const waPhone = o.phone ? getWhatsAppPhone(o.phone, countryCode) : '';

  return (
    <div
      ref={cardRef}
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
      className={cn(
        // Sin TiltCard a propósito: son cientos de tarjetas y el tilt destruiría
        // el scroll del tablero. Solo superficie + borde que reacciona al hover.
        // bg-card/40 = el panel translúcido del handoff (el mockup usa
        // rgba(255,255,255,.04) sobre la aurora). En CLARO no queda invisible:
        // la regla de compatibilidad de index.css ya opaca .bg-card/40 con
        // :root:not(.dark) — por eso NO hace falta pasarlo a bg-card, y hacerlo
        // solo rompería el vidrio en oscuro, que es el look aprobado.
        'group bg-card/40 rounded-xl border p-3.5 shadow-card3d cursor-pointer transition-colors duration-150 hover:border-border-strong focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none',
        // Estados terminales (entregado/devolución/cancelado/indemnizada) van
        // atenuados: la asesora no tiene nada que hacer con ellos y competían
        // visualmente con las columnas donde sí hay trabajo.
        tone === 'success' || tone === 'danger' || tone === 'muted' ? 'opacity-75' : '',
        selected ? 'border-accent ring-2 ring-accent/60 shadow-card3d' : 'border-border',
        // Riel de 2px con el color de la fase (el mismo mapa TONE del encabezado
        // de columna). Va DESPUÉS del ternario a propósito: si fuera antes,
        // border-accent/border-border pisaría el borde superior vía twMerge.
        tone && !selected ? cn('border-t-2', TONE[tone].headBar) : '',
      )}
    >
      {/* Fila de badges arriba (patrón del handoff: "● D3  PRIORIDAD"), para que
          el nombre del cliente use TODO el ancho de la columna en vez de pelear
          espacio con los badges. Era la causa principal del amontonamiento. */}
      {/* Fila de señal: frescura (pastilla tonal) + días hábiles como CIFRA
          (font-mono, el tratamiento de número del Dashboard) + prioridad
          anclada a la derecha, que es donde el ojo barre buscando urgencias.
          D{n} NO se tiñe por umbral: no existe un corte de SLA definido para
          este contador, e inventarle uno sería pintar un veredicto que nadie
          calculó. La frescura sí es semántica y ahí sí va el color. */}
      <div className="flex items-center gap-2">
        <span
          className={cn('h-2.5 w-2.5 rounded-full shrink-0 ring-2', fresh.cls, fresh.ring)}
          title={fresh.title}
          aria-hidden="true"
        />
        {/* El punto es decorativo (color solo) — el estado de frescura va en texto
            para lector de pantalla, ya que en touch el `title` no se ve. */}
        <span className="sr-only">{fresh.title}</span>
        {/* Un pedido vivo del que no sabemos hace cuánto no se mueve tiene que
            DECIRLO en la cara. El punto gris lo susurraba en un `title` que en
            el celular no existe, y así se veía igual que un pedido sano. */}
        {fresh.sinDato && (
          <span
            className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-md border border-muted-foreground/25 text-muted-foreground"
            title={fresh.title}
          >
            sin dato
          </span>
        )}
        <span
          className="inline-flex items-baseline gap-0.5 text-[13px] font-mono tabular-nums font-bold text-foreground"
          title="Días hábiles en este estado"
        >
          <span className="text-[10px] font-semibold text-muted-foreground">D</span>{dias}
        </span>
        {pLevel !== 'low' && (
          <span className={cn('ml-auto text-[11px] font-semibold px-2 py-0.5 rounded-lg border shrink-0', pConfig.bgClass, pConfig.color)}>
            {pConfig.label}
          </span>
        )}
      </div>

      {/* ETIQUETA DE UN VISTAZO. Va ARRIBA, antes del nombre, porque la pregunta
          "¿esta ya la trabajó alguien?" se responde recorriendo la columna con
          la vista — no leyendo el pie de cada tarjeta. El pie (el cartel verde)
          sigue estando y da el detalle; esto es la señal.
          Verde = alguien ya la trabajó hoy. La ausencia de etiqueta = nadie. */}
      {gEquipo && (() => {
        // Verde solo si SE HABLÓ con el cliente. "No contestó" y "Volver a
        // llamar" en verde dirían "resuelto" cuando el pedido sigue abierto —
        // la asesora lo saltaría creyendo que ya está.
        const seHablo = esContactoEfectivo(gEquipo.ultimoResult);
        return (
          <div
            className={cn(
              'mt-2 inline-flex max-w-full items-center gap-1.5 text-[11px] font-bold px-2 py-0.5 rounded-lg border',
              seHablo
                ? 'bg-success/15 text-success border-success/35'
                : 'bg-warning/15 text-warning border-warning/35',
            )}
            title={`${nombreDe ? nombreDe(gEquipo.ultimoPor) : 'Una asesora'} · ${gEquipo.ultimoResult} · ${haceCuanto(gEquipo.ultimoAt) || 'hoy'}`}
          >
            <CheckCircle2 size={10} aria-hidden="true" className="shrink-0" />
            <span className="truncate">{nombreDe ? nombreDe(gEquipo.ultimoPor) : 'Asesora'}</span>
            <span className="opacity-70 shrink-0 font-semibold">{haceCuanto(gEquipo.ultimoAt)}</span>
          </div>
        );
      })()}

      {/* Identidad: el nombre es lo ÚNICO que la asesora necesita para saber a
          quién llama, así que sube de tamaño y peso. El externalId baja a
          font-mono apagado: era el elemento más coloreado de la tarjeta
          (text-accent) compitiendo con el nombre, y es un número de sistema.
          El ancho para crecer sale del pie de acciones, no de agrandar la
          tarjeta: esto sigue siendo pantalla de trabajo y la densidad manda.
          `title` con el nombre completo — el truncate CSS lo cortaba sin
          ninguna forma de leerlo entero (SegCard no usa TruncatedText). */}
      <div className="mt-2 min-w-0">
        <span
          className="block text-[15px] font-bold text-foreground truncate leading-tight"
          title={o.nombre || 'Sin nombre'}
        >
          {o.nombre || 'Sin nombre'}
        </span>
        {o.externalId
          ? <span className="text-[11px] text-muted-foreground font-mono tabular-nums mt-1 block truncate">{o.externalId}</span>
          : <span className="text-[11px] text-muted-foreground font-mono mt-1 block">Sin ID</span>}
      </div>

      {/* Producto · ciudad como subtítulo (en el mockup van juntos) + VALOR a
          cobrar a la derecha: es lo primero que pregunta el cliente COD
          ("¿cuánto pago?") y antes obligaba a abrir el detalle en cada llamada.
          formatCOP ya es country-aware (COP entero / USD 2 decimales según la
          tienda activa). Solo con valor > 0: acá el 0 suele ser dato ausente y
          pintar "$0" como monto a cobrar sería un cero falso. */}
      {(o.producto || o.ciudad || o.valor > 0) && (
        <div
          className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground min-w-0"
          title={[o.producto, o.ciudad].filter(Boolean).join(' · ')}
        >
          {o.ciudad && <MapPin size={10} className="shrink-0" aria-hidden="true" />}
          <span className="truncate">
            {o.producto}
            {o.producto && o.ciudad ? ' · ' : ''}
            {o.ciudad}
          </span>
          {o.valor > 0 && (
            <span
              className="ml-auto shrink-0 font-mono tabular-nums font-semibold text-foreground"
              title="Valor a cobrar al cliente"
            >
              {formatCOP(o.valor)}
            </span>
          )}
        </div>
      )}

      {/* Motivo de la novedad / instrucción de la transportadora. Solo en fases
          vivas: `novedad` sobrevive en pedidos ya terminales (entregado/devuelto)
          y ahí sería una advertencia sobre algo que ya no se puede gestionar.
          Tratamiento de callout del Dashboard (riel de color a la izquierda).
          `title` con el texto COMPLETO: es texto literal de Dropi que la asesora
          le repite al cliente, y el line-clamp-2 lo cortaba sin ninguna forma de
          alcanzarlo — pérdida de información silenciosa justo donde más duele. */}
      {o.novedad && (tone === 'warning' || tone === 'accent' || tone === 'info' || tone === 'neutral') && (
        <div
          className="relative mt-2 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/12 pl-3 pr-2 py-1.5"
          title={o.novedad}
        >
          <span className="absolute left-0 top-1.5 bottom-1.5 w-1 rounded-full bg-warning" aria-hidden="true" />
          <AlertTriangle size={11} className="text-warning mt-0.5 shrink-0" aria-hidden="true" />
          <span className="text-xs text-foreground/90 leading-snug line-clamp-2">{o.novedad}</span>
        </div>
      )}

      {/* Guía / transportadora + rastreo */}
      <div className="mt-2 flex items-center justify-between gap-2 border-t border-border/50 pt-2">
        <div className="min-w-0 text-xs text-muted-foreground truncate">
          {o.transportadora ? <span className="font-medium text-foreground/80">{o.transportadora}</span> : 'Sin transportadora'}
          {o.guia ? <span className="font-mono tabular-nums"> · {o.guia}</span> : <span className="opacity-70"> · sin guía</span>}
        </div>
        {/* Blancos táctiles dentro de una tarjeta que YA es clickeable: sin
            separación real y con menos de 44px, un toque impreciso disparaba la
            acción vecina o navegaba al detalle. gap-2 + 44px mínimo cada uno.
            El layout tolera 1 a 4 botones: rastrear depende de que haya URL
            de transportadora, Llamar del teléfono normalizable, y WhatsApp de
            waEnabled + teléfono.

            Jerarquía: WhatsApp es la acción REAL (es como se contacta al
            cliente) y va tintado; rastrear, refrescar y llamar son secundarias
            y van fantasma. */}
        <div className="flex items-center gap-2 shrink-0">
          {(trackUrl || carrierHome) && (
            <a
              href={trackUrl || carrierHome || '#'}
              target="_blank" rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              title={trackUrl ? 'Rastrear envío' : 'Página de la transportadora'}
              aria-label={trackUrl ? 'Rastrear envío' : 'Página de la transportadora'}
              className="p-2 min-h-11 min-w-11 inline-flex items-center justify-center rounded-lg text-muted-foreground/70 hover:text-accent hover:bg-accent/10 transition-colors"
            >
              <ExternalLink size={14} aria-hidden="true" />
            </a>
          )}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); void refresh(activeStoreId, o.externalId); }}
            disabled={isRefreshing || !o.externalId}
            title="Refrescar estado desde Dropi"
            aria-label="Refrescar estado desde Dropi"
            className="p-2 min-h-11 min-w-11 inline-flex items-center justify-center rounded-lg text-muted-foreground/70 hover:text-accent hover:bg-accent/10 transition-colors disabled:opacity-40"
          >
            <RefreshCw size={14} className={isRefreshing ? 'animate-spin' : ''} aria-hidden="true" />
          </button>
          {/* Llamar SIN gate de waEnabled: en una tienda sin canal de WhatsApp
              esta era la ÚNICA forma de contactar y no existía — la operadora
              abría el detalle en cada llamada. Mismo patrón que CrmTable:
              tel:+ con el número normalizado por país + registro del intento de
              contacto como LLAMADA (prefijo propio: NO cuenta como gestión ni
              oculta la tarjeta — para eso está "Gestioné hoy"). */}
          {waPhone && (
            <a
              href={'tel:+' + waPhone}
              onClick={(e) => { e.stopPropagation(); void recordGestion(o.phone, 'LLAMADA', 'llamó'); }}
              title="Llamar al cliente"
              aria-label="Llamar al cliente"
              className="p-2 min-h-11 min-w-11 inline-flex items-center justify-center rounded-lg text-muted-foreground/70 hover:text-accent hover:bg-accent/10 transition-colors"
            >
              <Phone size={14} aria-hidden="true" />
            </a>
          )}
          {waEnabled && waPhone && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void openChat({ phone: o.phone, name: o.nombre });
              }}
              title="Abrir chat de WhatsApp (ver el bot / escribir)"
              aria-label="Abrir chat de WhatsApp"
              className="p-2 min-h-11 min-w-11 inline-flex items-center justify-center rounded-lg bg-success/12 border border-success/30 text-success hover:bg-success/20 hover:border-success/60 transition-colors"
            >
              <MessageCircle size={14} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {/* Acciones del ESTADO, sin salir del tablero. La primera es la propia de
          la fase (guía → "Envié la guía"; oficina → "Cliente recoge") y las dos
          que siguen son los desenlaces reales de la llamada.

          El gate es por FASE, no por tone (fix C2, auditoría 14-ago-2026): la
          condición vieja por tone dejaba SIN botones a "Nov. Solucionada"
          (success) — que cuenta en la cola de hoy, así que la cola no podía
          llegar a 0 — y a Rechazado/Devolución (danger), que tienen métodos
          propios en segMetodosEstado. Solo entregado/cancelado/indemnizada
          quedan sin botonera: no hay nada que registrar. */}
      {faseConGestion(o.estado) && o.phone && (
        yaGestionada ? (
          <div
            className="mt-2.5 w-full min-h-11 flex items-center gap-2 rounded-xl bg-success/15 text-success border border-success/40 font-bold text-[13px] px-2.5 py-1.5"
            title={gEquipo ? `${nombreDe ? nombreDe(gEquipo.ultimoPor) : "Una asesora"} lo gestionó ${haceCuanto(gEquipo.ultimoAt) || "hoy"}: ${gEquipo.ultimoResult}` : "Ya registraste una gestión de este pedido hoy"}
          >
            <CheckCircle2 size={15} aria-hidden="true" className="flex-shrink-0" />
            <div className="min-w-0 flex-1 text-left leading-tight">
              <div className="truncate">{gestionada || gEquipo?.ultimoResult || 'Gestionado hoy'}</div>
              {gEquipo && (
                <div className="text-[11px] font-semibold opacity-80 truncate">
                  {nombreDe ? nombreDe(gEquipo.ultimoPor) : 'Asesora'}
                  {haceCuanto(gEquipo.ultimoAt) ? ` · ${haceCuanto(gEquipo.ultimoAt)}` : ''}
                  {gEquipo.intentos > 1 ? ` · ${gEquipo.intentos} gestiones` : ''}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {metodosRapidosParaEstado(o.estado).map((m, i) => (
              <button
                key={m}
                type="button"
                onClick={(e) => { void gestionar(e, m); }}
                disabled={gestionando}
                title={`Registrar: ${m}`}
                className={cn(
                  // La primera ocupa la fila entera (es la acción de la fase);
                  // las otras dos se reparten la de abajo.
                  'min-h-11 inline-flex items-center justify-center gap-1.5 rounded-xl font-bold text-[12px] px-2 transition-colors disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none',
                  i === 0
                    ? 'w-full bg-accent text-accent-foreground hover:bg-accent/90 active:scale-[0.99]'
                    : 'flex-1 min-w-[calc(50%-0.375rem)] bg-card/60 border border-border text-foreground hover:border-accent/50 hover:text-accent',
                )}
              >
                {i === 0 && <CheckCircle2 size={14} aria-hidden="true" />}
                <span className="truncate">{gestionando ? '…' : m}</span>
              </button>
            ))}
          </div>
        )
      )}
    </div>
  );
});

function ColumnBody({ colKey, scrollRefs, children }: {
  colKey: string;
  scrollRefs: React.MutableRefObject<Map<string, number>>;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Restaurar el scroll guardado es una operación de MONTAJE, no de cada render:
  // con deps [] no pelea con el scroll en vivo del usuario (antes corría en cada
  // re-render del realtime y podía dar micro-saltos hacia atrás al arrastrar).
  useLayoutEffect(() => {
    if (!ref.current) return;
    const saved = scrollRefs.current.get(colKey);
    if (saved !== undefined && ref.current.scrollTop !== saved) ref.current.scrollTop = saved;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div
      ref={ref}
      onScroll={(e) => scrollRefs.current.set(colKey, (e.target as HTMLDivElement).scrollTop)}
      className="flex-1 overflow-y-auto p-1.5 space-y-1.5 max-h-[68vh] [scrollbar-width:thin]"
    >
      {children}
    </div>
  );
}

/**
 * Modo ENFOQUE: una sola columna (carpeta) a lo ancho, con navegación ↑/↓
 * (botones + teclado) que recorre SOLO los pedidos de esa columna. Pensado para
 * que la operadora se concentre en una fase (ej. "En Reparto") y vaya uno por uno.
 */
function FocusedColumn({ col, countryCode, touchedTodayPhones, gestionEquipo, nombreDe, onBack }: { col: ColumnDef & { orders: OrderData[] }; countryCode?: string | null; touchedTodayPhones?: Set<string>; gestionEquipo?: Map<string, GestionDelPedido>; nombreDe?: (id?: string | null) => string; onBack: () => void }) {
  const navigate = useNavigate();
  const { activeStoreId } = useStore();
  const t = TONE[col.tone];
  const orders = col.orders;
  const siblingIds = useMemo(() => orders.map((x) => String(x.externalId ?? '')).filter(Boolean), [orders]);
  // Persistimos el EXTERNALID del pedido enfocado (no el índice) → el foco SIGUE
  // al pedido aunque la carpeta se reordene o encoja en vivo, y la operadora
  // vuelve EXACTO a su pedido tras entrar al detalle. selIdx se DERIVA del id →
  // siempre en rango (sin clamp, sin flash off-by-one). Se monta con key={focusedKey}
  // en el padre, así el key de sesión es estable durante la vida del componente.
  const [focusedExtId, setFocusedExtId] = useSessionState<string | null>('seg:focusId:' + col.key, null);
  const [visible, setVisible] = useState(COLUMN_PAGE);
  // Última posición conocida del cursor: cuando el pedido enfocado SALE de la
  // carpeta (se gestionó con "Ocultar gestionados" activo, o cambió de fase por
  // realtime), la operadora se quedaba en el pedido nº1 — a mitad de una
  // carpeta de 40 eso es perder el hilo y re-recorrer lo ya visto (fix A2,
  // auditoría 14-ago-2026). Ahora se queda en la MISMA posición: el siguiente
  // pedido de la cola entra al lugar del que salió, que es exactamente el flujo
  // "gestiono → sigue el próximo".
  const lastIdxRef = useRef(0);
  const selIdx = useMemo(() => {
    if (orders.length === 0) return 0;
    if (focusedExtId) {
      const i = orders.findIndex((o) => String(o.externalId ?? '') === focusedExtId);
      if (i >= 0) return i;
      return Math.min(lastIdxRef.current, orders.length - 1);
    }
    return 0;
  }, [orders, focusedExtId]);
  useEffect(() => { lastIdxRef.current = selIdx; }, [selIdx]);
  const selRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const firstScrollRef = useRef(true);
  // El pedido enfocado tiene que estar SIEMPRE montado: ↑/↓ puede llevar la
  // selección más allá del tope y sin su tarjeta no hay scrollIntoView ni foco
  // visible. Por eso el tope se corre con selIdx en vez de frenarlo.
  const shown = Math.max(visible, selIdx + 5);

  // Ancla el foco al pedido que está en `idx` ahora (lo usan ↑/↓ y el click).
  const focusByIndex = (idx: number) => {
    const o = orders[idx];
    if (o) setFocusedExtId(String(o.externalId ?? ''));
  };
  const move = (delta: number) => focusByIndex(Math.min(orders.length - 1, Math.max(0, selIdx + delta)));

  // Scroll del seleccionado a la vista: instantáneo al montar/restaurar (no un
  // barrido animado desde arriba), suave al navegar con ↑/↓.
  useEffect(() => {
    selRef.current?.scrollIntoView({ block: 'nearest', behavior: firstScrollRef.current ? 'auto' : 'smooth' });
    firstScrollRef.current = false;
  }, [selIdx]);

  return (
    <div className="space-y-3">
      {/* Barra de enfoque con peso de HudTopbar contextual: es el mejor flujo de
          trabajo de la pantalla y estaba dibujado como una fila más. Identidad
          de la carpeta a la izquierda, posición y navegación a la derecha. */}
      <div className="rounded-2xl border border-border bg-card/40 shadow-card3d-lg hairline-top px-4 py-3.5">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card/40 px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:border-border-strong transition-colors"
          >
            <ChevronLeft size={14} aria-hidden="true" /> Tablero
          </button>
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="w-9 h-9 rounded-xl border border-border bg-card/60 flex items-center justify-center shrink-0 text-foreground/90" aria-hidden="true">
              {col.icon}
            </span>
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-foreground truncate leading-tight">{col.label}</h3>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className={cn('h-2 w-2 rounded-full shrink-0', t.dot)} aria-hidden="true" />
                <span className={cn('text-[13px] font-mono tabular-nums font-bold', t.num, t.numGlow)}>{orders.length}</span>
              </div>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            {/* Posición dentro de la carpeta con tratamiento de cifra. */}
            <span className="text-sm text-foreground font-mono tabular-nums font-semibold">
              {orders.length ? `${selIdx + 1} / ${orders.length}` : '0 / 0'}
            </span>
            <button
              type="button"
              onClick={() => { move(-1); listRef.current?.focus(); }}
              disabled={selIdx <= 0}
              title="Anterior (↑)"
              className="p-2 rounded-xl border border-border bg-card/40 text-muted-foreground hover:text-foreground hover:border-border-strong transition-colors disabled:opacity-40"
            >
              <ChevronUp size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => { move(1); listRef.current?.focus(); }}
              disabled={selIdx >= orders.length - 1}
              title="Siguiente (↓)"
              className="p-2 rounded-xl border border-border bg-card/40 text-muted-foreground hover:text-foreground hover:border-border-strong transition-colors disabled:opacity-40"
            >
              <ChevronDown size={15} aria-hidden="true" />
            </button>
          </div>
        </div>
        {/* Avance por la carpeta — la asesora está recorriendo una cola y no
            veía cuánto le falta. Es el MISMO "N / M" de arriba dibujado como
            barra (decorativa: el texto ya lo dice para lector de pantalla), no
            una métrica nueva. */}
        {orders.length > 0 && (
          <div className="mt-3 h-1 w-full rounded-full bg-foreground/10 overflow-hidden" aria-hidden="true">
            <div
              className="h-full rounded-full bg-accent-gradient transition-[width] duration-700"
              style={{ width: `${Math.round(((selIdx + 1) / orders.length) * 100)}%` }}
            />
          </div>
        )}
      </div>

      {/* Lista de la columna enfocada (solo estos pedidos) */}
      <div
        ref={listRef}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
          else if (e.key === 'Escape') { e.preventDefault(); onBack(); }
        }}
        className="mx-auto max-w-xl space-y-2 max-h-[72vh] overflow-y-auto p-1 rounded-xl focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none [scrollbar-width:thin]"
      >
        {orders.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            No hay pedidos en <strong className="text-foreground">{col.label}</strong> ahora mismo.
          </div>
        ) : (
          <>
            {orders.slice(0, shown).map((o, i) => (
              <SegCard
                key={o.dbId || `${o.phone}|${o.externalId}|${o.idx}`}
                o={o}
                countryCode={countryCode}
                tone={col.tone}
                selected={i === selIdx}
                cardRef={i === selIdx ? selRef : undefined}
                touchedTodayPhones={touchedTodayPhones}
                gestionEquipo={gestionEquipo}
                nombreDe={nombreDe}
                onOpen={() => { focusByIndex(i); if (o.externalId) navigate(`/pedido/${o.externalId}`, { state: { siblingIds, storeId: activeStoreId } }); }}
              />
            ))}
            {orders.length > shown && (
              <button
                type="button"
                onClick={() => setVisible(shown + COLUMN_PAGE)}
                className="w-full rounded-xl border border-border bg-card/40 px-3 py-2 text-xs font-semibold text-muted-foreground hover:text-foreground hover:border-border-strong transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
              >
                Ver más (<span className="font-mono tabular-nums">{orders.length - shown}</span>)
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// Persistencia del scroll por columna (sessionStorage) — sobrevive el remount al
// entrar/salir de un pedido. Mapa { colKey: scrollTop } serializado a JSON.
const BOARD_SCROLL_KEY = 'seg:boardScroll';
function loadBoardScroll(): Map<string, number> {
  try {
    const raw = sessionStorage.getItem(BOARD_SCROLL_KEY);
    if (!raw) return new Map();
    return new Map(Object.entries(JSON.parse(raw) as Record<string, number>));
  } catch {
    return new Map();
  }
}
function saveBoardScroll(m: Map<string, number>): void {
  try {
    sessionStorage.setItem(BOARD_SCROLL_KEY, JSON.stringify(Object.fromEntries(m)));
  } catch {
    /* sessionStorage lleno/deshabilitado — no es crítico */
  }
}

interface SegBoardProps {
  data: OrderData[];
  countryCode?: string | null;
  /** Filtro de la fila "resumen por estado" — si está, muestra solo esa columna. */
  statusFilter?: string | null;
  /**
   * Phones que ESTA operadora ya gestionó hoy (mySegTouchedToday del
   * OrderContext). Baja como prop (no useOrders() en SegCard) a propósito:
   * un context en la tarjeta re-renderizaría cientos de cards en CADA cambio
   * de OrderContext, no solo cuando cambia el set.
   */
  touchedTodayPhones?: Set<string>;
  /** Gestion del EQUIPO por telefono hoy (OrderContext.gestionSegPorTelefono).
   *  Contraparte de equipo de `touchedTodayPhones`, que es personal. */
  gestionEquipo?: Map<string, GestionDelPedido>;
  emptyTitle?: string;
  emptyDesc?: string;
  /**
   * El vacío es porque la asesora YA gestionó todo hoy (no porque no haya
   * pedidos). Son dos cosas muy distintas y se dibujaban igual de apagadas;
   * este es el único momento de recompensa de la pantalla. Presentación pura:
   * el padre ya calculaba `allManagedToday` para elegir los textos.
   */
  celebratory?: boolean;
}

export default function SegBoard({ data, countryCode, statusFilter, touchedTodayPhones, gestionEquipo, celebratory = false, emptyTitle = 'Sin pedidos en seguimiento', emptyDesc = 'Los pedidos sincronizados desde Dropi aparecerán aquí, en columnas por estado.' }: SegBoardProps) {
  // Nombre de la asesora que gestionó: cache módulo-level compartido, una sola
  // lectura de profiles por sesión (no una por tarjeta).
  const { nameOf: nombreDe } = useOperatorNames();
  const navigate = useNavigate();
  // Se sella en el state junto a la carpeta: si la asesora cambia de tienda, la
  // ficha descarta los hermanos en vez de pasear pedidos de la otra tienda.
  const { activeStoreId } = useStore();
  // Scroll por columna persistido en sessionStorage → sobrevive el remount de
  // entrar/salir de un pedido (y los discards de tab). Se inicializa UNA sola vez
  // desde lo guardado (init-once con ref-guard, para no re-parsear sessionStorage
  // en cada re-render del realtime); se reescribe al desmontar.
  const scrollRefs = useRef<Map<string, number>>(new Map());
  const scrollLoadedRef = useRef(false);
  if (!scrollLoadedRef.current) {
    scrollLoadedRef.current = true;
    const saved = loadBoardScroll();
    if (saved.size > 0) scrollRefs.current = saved;
  }
  useEffect(() => () => saveBoardScroll(scrollRefs.current), []);
  // Columna enfocada (carpeta) PERSISTIDA → la operadora no pierde su carpeta al
  // entrar a un pedido y volver. null = tablero completo.
  // string y no SegStatusKey: también se puede enfocar una columna generada por
  // estado sin mapear (key `otros:<ESTADO>`).
  const [focusedKey, setFocusedKey] = useSessionState<string | null>('seg:focusedKey', null);
  // Historia plegada por defecto (ver HISTORIA_KEYS). Se recuerda por pestaña.
  const [verHistoria, setVerHistoria] = useSessionState<boolean>('seg:verHistoria', false);
  // Cuántas tarjetas se muestran por columna (arranca en COLUMN_PAGE y sube con
  // "Ver más"). No se persiste: cada entrada al tablero vuelve al tope barato.
  const [colLimits, setColLimits] = useState<Record<string, number>>({});

  // Barra de desplazamiento ARRIBA además de la de abajo. Con 15 columnas la
  // única forma de correr el tablero era bajar hasta el pie de la página a
  // buscar la barra, mover, y volver a subir. La de arriba es un riel gemelo:
  // mismo ancho de contenido, scroll sincronizado en los dos sentidos.
  const boardRef = useRef<HTMLDivElement | null>(null);
  const topBarRef = useRef<HTMLDivElement | null>(null);
  const [anchoTablero, setAnchoTablero] = useState(0);
  // Sincroniza los dos rieles. Es IDEMPOTENTE a propósito: si el destino ya
  // está donde debe, no se escribe nada, así que el onScroll de rebote no
  // dispara otra escritura y la cadena se corta sola.
  //
  // Antes había un candado que se soltaba con requestAnimationFrame. No servía
  // para lo que decía: el rebote del navegador llega DESPUÉS de ese cuadro, así
  // que nunca lo tapaba — y mientras tanto sí se comía los eventos de scroll del
  // cuadro en curso. Al arrastrar, el riel se saltaba posiciones y volvía atrás.
  // Eso era el "se traba".
  //
  // La tolerancia de medio píxel evita el temblor cuando el navegador devuelve
  // un scrollLeft fraccionario (pantallas con escalado de Windows): sin ella los
  // dos rieles se corrigen mutuamente para siempre por 0,3 px.
  const sincronizar = (origen: HTMLDivElement | null, destino: HTMLDivElement | null) => {
    if (!origen || !destino) return;
    if (Math.abs(destino.scrollLeft - origen.scrollLeft) > 0.5) {
      destino.scrollLeft = origen.scrollLeft;
    }
  };

  useLayoutEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    // Idempotente: sin esto cada medición guarda estado nuevo, que re-renderiza,
    // que vuelve a medir. Y como este efecto NO tenía lista de dependencias,
    // corría en cada render: creaba y destruía un ResizeObserver por render,
    // justo mientras la asesora arrastraba.
    const medir = () => setAnchoTablero((prev) => {
      const w = el.scrollWidth;
      return Math.abs(prev - w) > 1 ? w : prev;
    });
    medir();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(medir);
    ro.observe(el);
    // El riel de arriba mide el CONTENIDO (scrollWidth), pero ResizeObserver
    // vigila la CAJA — y la del tablero no cambia cuando aparece una columna
    // nueva. Por eso se observan también los hijos: si no, el riel se queda con
    // el ancho viejo y deja columnas fuera de su alcance.
    for (const hijo of Array.from(el.children)) ro.observe(hijo);
    return () => ro.disconnect();
  }, [data]);

  // Agrupa por columna una sola vez. Cada tarjeta se re-renderiza sola cuando
  // su OrderData cambia de referencia (smartMerge en el padre).
  const byColumn = useMemo(() => {
    const groups = new Map<SegStatusKey, OrderData[]>();
    for (const o of data) {
      const key = classifySegEstado(o.estado);
      const arr = groups.get(key);
      if (arr) arr.push(o); else groups.set(key, [o]);
    }
    return groups;
  }, [data]);

  // TODAS las columnas con pedidos, historia incluida. `columns` (más abajo) es
  // el subconjunto que se dibuja; el modo enfoque busca acá para que enfocar una
  // columna de historia siga funcionando aunque esté plegada.
  const todasLasColumnas = useMemo(
    () => [
      ...BOARD_COLUMNS.map((c) => ({ ...c, orders: byColumn.get(c.baseKey) ?? [] })),
      // Una columna por cada estado real que no cae en las fases de arriba.
      ...columnasDeEstadosSinMapear(byColumn.get('otros') ?? []),
    ]
      // El filtro por estado acepta tanto la columna puntual como el bucket
      // (tocar "Otros" en el resumen sigue mostrando TODOS los sin mapear).
      .filter((c) => (statusFilter ? c.key === statusFilter || c.baseKey === statusFilter : true))
      .filter((c) => c.orders.length > 0),
    [byColumn, statusFilter],
  );

  // Historia plegada: si la operadora PIDIÓ un estado explícitamente
  // (statusFilter), se le muestra aunque sea historia — pidió eso, no otra cosa.
  const mostrarHistoria = verHistoria || !!statusFilter;
  const historiaOculta = useMemo(
    () => (mostrarHistoria ? [] : todasLasColumnas.filter((c) => HISTORIA_KEYS.has(c.baseKey))),
    [todasLasColumnas, mostrarHistoria],
  );
  const pedidosEnHistoria = useMemo(
    () => historiaOculta.reduce((n, c) => n + c.orders.length, 0),
    [historiaOculta],
  );
  const columns = useMemo(
    () => (mostrarHistoria ? todasLasColumnas : todasLasColumnas.filter((c) => !HISTORIA_KEYS.has(c.baseKey))),
    [todasLasColumnas, mostrarHistoria],
  );

  // Si al MONTAR la carpeta enfocada persistida quedó vacía (los pedidos cambiaron
  // de fase, o cambió la tienda/rango), no dejamos a la operadora atascada en la
  // pantalla "sin pedidos": caemos al tablero. Solo en el mount — si se vacía en
  // vivo mientras está adentro, mostramos el vacío con su botón "Tablero".
  const focusCheckedRef = useRef(false);
  useEffect(() => {
    if (focusCheckedRef.current) return;
    focusCheckedRef.current = true;
    if (focusedKey && !todasLasColumnas.some((c) => c.key === focusedKey)) setFocusedKey(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Modo enfoque: una sola carpeta a lo ancho con navegación ↑/↓. Validamos el
  // key (puede venir stale de sessionStorage tras un cambio de columnas) → si no
  // existe, ignoramos y mostramos el tablero. `key={focusedKey}` remonta limpio
  // al cambiar de carpeta (así el selIdx persistido se inicializa por columna).
  if (focusedKey) {
    // Se busca en `todasLasColumnas` (no en BOARD_COLUMNS ni en `columns`): ahí
    // están las columnas generadas por estado sin mapear CON sus pedidos, y
    // además las de historia — enfocar "Entregado" tiene que seguir funcionando
    // aunque el tablero las tenga plegadas.
    const focusedCol = todasLasColumnas.find((c) => c.key === focusedKey);
    if (focusedCol) {
      return <FocusedColumn key={focusedKey} col={focusedCol} countryCode={countryCode} touchedTodayPhones={touchedTodayPhones} gestionEquipo={gestionEquipo} nombreDe={nombreDe} onBack={() => setFocusedKey(null)} />;
    }
  }

  // Ojo: `columns` puede estar vacío solo porque la historia está plegada. En
  // ese caso NO es "no hay nada" — hay pedidos, todos cerrados. Se despliega la
  // historia sola para no mostrar un vacío que miente.
  if (columns.length === 0 && pedidosEnHistoria > 0 && !mostrarHistoria) {
    return (
      <div className="rounded-3xl border border-border bg-card/40 px-6 py-12 shadow-card3d text-center flex flex-col items-center gap-3">
        <p className="text-sm text-muted-foreground">
          No queda nada por gestionar. Los {pedidosEnHistoria} pedidos que hay están cerrados.
        </p>
        <button
          type="button"
          onClick={() => setVerHistoria(true)}
          className="text-[11px] font-semibold px-3 py-1.5 rounded-xl border border-border bg-card/60 text-muted-foreground hover:text-foreground hover:border-border-strong transition-colors"
        >
          Ver la historia
        </button>
      </div>
    );
  }

  if (columns.length === 0) {
    // "No hay nada" y "ya lo hiciste todo" se dibujaban idénticos y apagados.
    // El caso celebratorio toma el lenguaje del Dashboard (tarjeta con glow
    // success + chip de ícono); el vacío normal se queda sobrio, como debe ser.
    if (celebratory) {
      return (
        <TiltCard
          sheen
          className="bg-card/40 border border-success/30 rounded-3xl px-6 py-14 shadow-card3d-lg text-center flex flex-col items-center gap-4"
        >
          <span className="w-14 h-14 rounded-2xl bg-success/14 border border-success/30 text-success glow-success flex items-center justify-center tilt-layer-3" aria-hidden="true">
            <CheckCircle size={28} />
          </span>
          <div className="tilt-layer-2">
            <p className="text-base font-bold text-success">{emptyTitle}</p>
            <p className="text-xs text-muted-foreground mt-1.5 max-w-sm mx-auto leading-relaxed">{emptyDesc}</p>
          </div>
        </TiltCard>
      );
    }
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
        <span className="w-14 h-14 rounded-2xl bg-card/40 border border-border shadow-card3d flex items-center justify-center" aria-hidden="true">
          <Truck size={28} className="text-muted-foreground" />
        </span>
        <div>
          <p className="text-sm font-semibold text-foreground">{emptyTitle}</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-sm">{emptyDesc}</p>
        </div>
      </div>
    );
  }

  // Índice de la primera columna TERMINAL visible → ahí va el divisor "en juego
  // | cerrado". Se calcula sobre las columnas realmente pintadas (las vacías no
  // existen), así que si no hay ninguna terminal, no se dibuja divisor.
  const firstTerminalIdx = columns.findIndex((c) => !LIVE_KEYS.has(c.baseKey) && !CATCHALL_KEYS.has(c.baseKey));

  return (
    <>
    {/* Riel gemelo: solo existe para tener barra ARRIBA. No lleva contenido
        (un div del ancho del tablero) y queda fuera del árbol de accesibilidad
        — el tablero de abajo es el que se anuncia. */}
    <div
      ref={topBarRef}
      onScroll={() => sincronizar(topBarRef.current, boardRef.current)}
      aria-hidden="true"
      className="rail-scroll overflow-x-auto overflow-y-hidden -mx-1 px-1 mb-1.5"
    >
      <div style={{ width: anchoTablero || 1, height: 1 }} />
    </div>
    {/* Sin `snap-x` (quitado 1-ago-2026). El imán a la columna peleaba contra el
        arrastre: se corría el riel, el tablero se iba solo al borde de la columna
        más cercana, y ese salto rebotaba al riel de arriba moviéndole el pulgar
        debajo del dedo. Es el "pasa una y se traba" que reportó el dueño. Un
        tablero de 15 columnas se recorre libre; el imán servía para hojear de a
        una, que no es como se usa. */}
    <div
      ref={boardRef}
      onScroll={() => sincronizar(boardRef.current, topBarRef.current)}
      className="flex gap-3 overflow-x-auto pb-3 -mx-1 px-1 [scrollbar-width:thin] items-start"
    >
      {/* Historia plegada: el botón ocupa el lugar EXACTO donde estarían las
          columnas, para que se lea como "acá hay más" y no como un control
          perdido. Se dibuja al final del scroll horizontal, después de todo lo
          que sí da trabajo. */}
      {columns.map((col, colIdx) => {
        const t = TONE[col.tone];
        const isLive = LIVE_KEYS.has(col.baseKey);
        // El catch-all va angosto (como las terminales) pero SIN atenuar.
        const isCatchall = CATCHALL_KEYS.has(col.baseKey);
        const siblingIds = col.orders.map((x) => String(x.externalId ?? '')).filter(Boolean);
        return (
          <Fragment key={col.key}>
            {/* Divisor "en juego | cerrado": el scroll de 15 columnas idénticas
                obligaba a barrer toda la fila para encontrar dónde está el
                trabajo. Nada se oculta — solo se separan los dos mundos. */}
            {firstTerminalIdx > 0 && colIdx === firstTerminalIdx && (
              <div className="shrink-0 self-stretch w-px bg-border mx-1" aria-hidden="true" />
            )}
          <section
            // La carpeta pasa a ser un panel con cuerpo propio: sin superficie
            // ni elevación, las tarjetas flotaban sueltas sobre el fondo y no
            // se leía dónde termina una columna y empieza la otra.
            //
            // Jerarquía de fase: las columnas VIVAS (donde hay algo que hacer)
            // van más anchas y con la elevación mayor; las TERMINALES quedan
            // angostas, atenuadas y sin realce. Antes "En Reparto" —donde se
            // decide la entrega— medía exactamente lo mismo que "Cancelado".
            className={cn(
              // Sin `snap-start`: es la otra mitad del imán que trababa el
              // arrastre (ver el comentario del contenedor).
              'shrink-0 flex flex-col gap-2.5 rounded-2xl border bg-card/40 transition-colors',
              // La jerarquía sale del ANCHO y la ELEVACIÓN, no de atenuar.
              // "Devolución", "Dev. en Tránsito" y "Entregado" son terminales
              // pero se LEEN (análisis de devoluciones): bajarles la opacidad
              // era pagar legibilidad de dato real por jerarquía visual.
              isLive
                ? 'w-[300px] border-border shadow-card3d-lg'
                : isCatchall
                  ? 'w-[248px] border-border shadow-card3d'
                  : 'w-[248px] border-border/60 shadow-card3d',
            )}
          >
            {/* Header clickeable → enfoca esta carpeta (solo estos pedidos + ↑/↓).
                Anatomía de StatTile: la CIFRA es la protagonista y el nombre de
                la fase baja a hud-label debajo, así cada carpeta se lee de un
                vistazo como un KPI. (hud-label mayusculiza, y acá es legítimo:
                son rótulos fijos nuestros de BOARD_COLUMNS, no texto de Dropi.)

                OJO con el número (pendiente para el dueño, NO lo cambié acá):
                es cuántos pedidos QUEDAN VISIBLES en esa fase después de
                "Ocultar gestionados" + búsqueda + lista SLA + ventana de 45
                días + dedup. NO es el total del estado en Dropi, y ahora que
                tiene peso de KPI conviene rotularlo — pero eso exige texto
                nuevo en español, que no me toca inventar. El `title` queda
                EXACTAMENTE como estaba. */}
            <button
              type="button"
              onClick={() => setFocusedKey(col.key)}
              title={`Concentrarse solo en ${col.label}`}
              // rounded-t-2xl (no rounded-xl): el header es el primer hijo del
              // panel y su fondo de hover se dibuja hasta el borde. Con un radio
              // menor que el de la carpeta, ese fondo asomaba por fuera de la
              // esquina redondeada al pasar el mouse.
              className="group/h flex items-start gap-2.5 rounded-t-2xl px-3.5 py-3.5 text-left hover:bg-card/60 transition-colors"
            >
              <span className={cn('w-9 h-9 rounded-xl border flex items-center justify-center shrink-0', t.count)} aria-hidden="true">
                {col.icon}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className={cn('h-2 w-2 rounded-full shrink-0', t.dot)} aria-hidden="true" />
                  <span className={cn('text-[22px] font-mono tabular-nums font-bold leading-none', t.num, t.numGlow)}>
                    {col.orders.length}
                  </span>
                </div>
                <h3 className="hud-label truncate mt-1.5">{col.label}</h3>
              </div>
              {/* Affordance de enfoque PERMANENTE: era un Maximize2 que solo
                  aparecía al hover, o sea invisible en móvil/táctil — que es
                  justo donde más se usa el modo enfoque. */}
              <Maximize2 size={13} className="text-muted-foreground/60 group-hover/h:text-accent transition-colors shrink-0 mt-0.5" aria-hidden="true" />
            </button>
            <ColumnBody colKey={col.key} scrollRefs={scrollRefs}>
              {col.orders.slice(0, colLimits[col.key] ?? COLUMN_PAGE).map((o) => (
                <SegCard
                  key={o.dbId || `${o.phone}|${o.externalId}|${o.idx}`}
                  o={o}
                  countryCode={countryCode}
                  tone={col.tone}
                  touchedTodayPhones={touchedTodayPhones}
                  gestionEquipo={gestionEquipo}
                  nombreDe={nombreDe}
                  onOpen={() => o.externalId && navigate(`/pedido/${o.externalId}`, { state: { siblingIds, storeId: activeStoreId } })}
                />
              ))}
              {col.orders.length > (colLimits[col.key] ?? COLUMN_PAGE) && (
                <button
                  type="button"
                  onClick={() => setColLimits((prev) => ({
                    ...prev,
                    [col.key]: (prev[col.key] ?? COLUMN_PAGE) + COLUMN_PAGE,
                  }))}
                  className="w-full rounded-xl border border-border bg-card/40 px-3 py-2 text-xs font-semibold text-muted-foreground hover:text-foreground hover:border-border-strong transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
                >
                  Ver más (<span className="font-mono tabular-nums">{col.orders.length - (colLimits[col.key] ?? COLUMN_PAGE)}</span>)
                </button>
              )}
            </ColumnBody>
          </section>
          </Fragment>
        );
      })}

      {!mostrarHistoria && pedidosEnHistoria > 0 && (
        <button
          type="button"
          onClick={() => setVerHistoria(true)}
          className="shrink-0 w-[188px] self-stretch min-h-[140px] rounded-2xl border border-dashed border-border/70 bg-card/20 px-4 py-5 text-left hover:border-border-strong hover:bg-card/40 transition-colors flex flex-col justify-center gap-1.5"
          title="Entregados, cancelados e indemnizados. No hay nada que hacer con ellos."
        >
          <span className="text-[22px] font-mono tabular-nums font-bold leading-none text-muted-foreground/70">
            {pedidosEnHistoria}
          </span>
          <span className="hud-label text-muted-foreground/70">Historia</span>
          <span className="text-[10px] leading-snug text-muted-foreground/60">
            Entregados, cancelados e indemnizados. Nada que hacer.
          </span>
        </button>
      )}

      {mostrarHistoria && !statusFilter && (
        <button
          type="button"
          onClick={() => setVerHistoria(false)}
          className="shrink-0 w-[132px] self-stretch min-h-[140px] rounded-2xl border border-dashed border-border/70 bg-card/20 px-4 text-[11px] font-semibold text-muted-foreground/70 hover:text-foreground hover:border-border-strong transition-colors"
        >
          Ocultar historia
        </button>
      )}
    </div>
    </>
  );
}

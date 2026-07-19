import { Fragment, memo, useMemo, useRef, useEffect, useLayoutEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Package, Tag, Truck, MapPin, AlertTriangle, CheckCircle, RotateCcw,
  DollarSign, Layers, ExternalLink, RefreshCw, MessageCircle,
  ChevronUp, ChevronDown, ChevronLeft, Maximize2,
} from 'lucide-react';
import { OrderData, getTrackingUrl, getWhatsAppPhone, calcBusinessDays, parseDate } from '@/lib/orderUtils';
import { classifySegEstado, type SegStatusKey } from '@/lib/segStatus';
import { calcPriority, getPriorityLevel, PRIORITY_CONFIG } from '@/lib/alertSystem';
import { useRefreshOrder } from '@/hooks/useRefreshOrder';
import { useStore } from '@/contexts/StoreContext';
import { useWaChat } from '@/contexts/WaChatContext';
import { useSessionState } from '@/hooks/useSessionState';
import { TiltCard } from '@/components/ui3d';
import { cn } from '@/lib/utils';

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

interface ColumnDef { key: SegStatusKey; label: string; icon: React.ReactNode; tone: Tone; }

// Orden de pipeline (izq → der), estilo embudo logístico. ESTE ORDEN NO SE
// TOCA en un pase visual: las asesoras lo tienen memorizado y moverlo es
// arquitectura de información, no dibujo. (Un pase anterior había subido
// "Otros" al medio del embudo; se revirtió — ver CATCHALL_KEYS abajo, que
// resuelve la misma preocupación sin reordenar nada.)
const BOARD_COLUMNS: ColumnDef[] = [
  { key: 'procesamiento', label: 'En Procesamiento', icon: <Package size={13} />, tone: 'neutral' },
  { key: 'guia', label: 'Guía Generada', icon: <Tag size={13} />, tone: 'info' },
  { key: 'bodega_trans', label: 'Bodega Transp.', icon: <Package size={13} />, tone: 'neutral' },
  { key: 'transito', label: 'En Tránsito', icon: <Truck size={13} />, tone: 'info' },
  { key: 'reparto', label: 'En Reparto', icon: <Truck size={13} />, tone: 'accent' },
  { key: 'oficina', label: 'En Oficina', icon: <MapPin size={13} />, tone: 'warning' },
  { key: 'novedad', label: 'Novedad', icon: <AlertTriangle size={13} />, tone: 'warning' },
  { key: 'novedad_sol', label: 'Nov. Solucionada', icon: <CheckCircle size={13} />, tone: 'success' },
  { key: 'entregado', label: 'Entregado', icon: <CheckCircle size={13} />, tone: 'success' },
  { key: 'rechazado', label: 'Rechazado', icon: <AlertTriangle size={13} />, tone: 'danger' },
  { key: 'devolucion_transito', label: 'Dev. en Tránsito', icon: <RotateCcw size={13} />, tone: 'danger' },
  { key: 'devolucion', label: 'Devolución', icon: <RotateCcw size={13} />, tone: 'danger' },
  { key: 'indemnizada', label: 'Indemnizada', icon: <DollarSign size={13} />, tone: 'muted' },
  { key: 'cancelado', label: 'Cancelado', icon: <Layers size={13} />, tone: 'muted' },
  { key: 'otros', label: 'Otros', icon: <Layers size={13} />, tone: 'muted' },
];

/**
 * Fases donde TODAVÍA se puede hacer algo. Las que no están acá son terminales
 * (el pedido ya llegó a su desenlace) y se dibujan como un grupo atenuado y más
 * angosto al final: siguen enteras y clicables, pero dejan de pesar lo mismo
 * que "En Reparto", que es donde se decide la entrega.
 *
 */
const LIVE_KEYS = new Set<SegStatusKey>([
  'procesamiento', 'guia', 'bodega_trans', 'transito', 'reparto', 'oficina', 'novedad', 'novedad_sol',
]);

/**
 * "Otros" no es ni VIVA ni TERMINAL: es el catch-all de los estados que Dropi
 * inventa —sobre todo en EC— y por lo tanto la señal de que hay drift sin
 * mapear. Va al final del embudo, como siempre, pero NO se atenúa con el grupo
 * terminal: atenuar la única columna que avisa de un estado desconocido era
 * apagar justo la alarma. Queda angosta (no compite con las fases vivas) pero
 * a opacidad plena.
 */
const CATCHALL_KEYS = new Set<SegStatusKey>(['otros']);

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

function statusAgeDays(o: OrderData): number {
  const base = (o.fechaConf || o.fecha || '').trim();
  if (base && base !== 'undefined') return calcBusinessDays(base);
  return o.diasConf || o.dias || 0;
}

/** Horas desde el último movimiento real en Dropi (para el punto de frescura). */
function hoursSinceMovement(o: OrderData): number | null {
  const iso = o.lastMovementAt;
  if (!iso) return null;
  const d = parseDate(iso);
  if (!d) return null;
  return (Date.now() - d.getTime()) / 3_600_000;
}

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
function freshnessDot(o: OrderData): { cls: string; ring: string; title: string } {
  const h = hoursSinceMovement(o);
  if (h == null) return { cls: 'bg-muted-foreground/40', ring: 'ring-muted-foreground/20', title: 'Sin fecha de último movimiento' };
  if (h < 24) return { cls: 'bg-success glow-success', ring: 'ring-success/25', title: 'Movido en las últimas 24 h' };
  if (h < 72) return { cls: 'bg-warning glow-warning', ring: 'ring-warning/25', title: `Sin moverse hace ${Math.floor(h / 24)}–${Math.ceil(h / 24)} días` };
  return { cls: 'bg-danger glow-danger', ring: 'ring-danger/25', title: `Sin moverse hace ${Math.floor(h / 24)} días` };
}

const SegCard = memo(function SegCard({ o, countryCode, tone, selected, cardRef, onOpen }: { o: OrderData; countryCode?: string | null; tone?: Tone; selected?: boolean; cardRef?: React.Ref<HTMLDivElement>; onOpen?: () => void }) {
  const navigate = useNavigate();
  const { refresh, isRefreshing } = useRefreshOrder();
  const { activeStoreId } = useStore();
  const { openChat, waEnabled } = useWaChat();
  const open = () => { if (onOpen) onOpen(); else if (o.externalId) navigate(`/pedido/${o.externalId}`); };

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

      {/* Producto · ciudad como subtítulo (en el mockup van juntos) */}
      {(o.producto || o.ciudad) && (
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
        {/* Tres blancos táctiles dentro de una tarjeta que YA es clickeable: sin
            separación real y con menos de 44px, un toque impreciso disparaba la
            acción vecina o navegaba al detalle. gap-2 + 44px mínimo cada uno.
            El layout tolera 1, 2 o 3 botones: rastrear depende de que haya URL
            de transportadora, y WhatsApp de waEnabled + teléfono normalizable.

            Jerarquía: WhatsApp es la acción REAL (es como se contacta al
            cliente) y va tintado; rastrear y refrescar son secundarias y van
            fantasma. Antes los tres pesaban igual y se comían medio ancho de la
            tarjeta con el mismo gris. */}
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
function FocusedColumn({ col, countryCode, onBack }: { col: ColumnDef & { orders: OrderData[] }; countryCode?: string | null; onBack: () => void }) {
  const navigate = useNavigate();
  const t = TONE[col.tone];
  const orders = col.orders;
  const siblingIds = useMemo(() => orders.map((x) => String(x.externalId ?? '')).filter(Boolean), [orders]);
  // Persistimos el EXTERNALID del pedido enfocado (no el índice) → el foco SIGUE
  // al pedido aunque la carpeta se reordene o encoja en vivo, y la operadora
  // vuelve EXACTO a su pedido tras entrar al detalle. selIdx se DERIVA del id →
  // siempre en rango (sin clamp, sin flash off-by-one). Se monta con key={focusedKey}
  // en el padre, así el key de sesión es estable durante la vida del componente.
  const [focusedExtId, setFocusedExtId] = useSessionState<string | null>('seg:focusId:' + col.key, null);
  const selIdx = useMemo(() => {
    if (orders.length === 0) return 0;
    if (focusedExtId) {
      const i = orders.findIndex((o) => String(o.externalId ?? '') === focusedExtId);
      if (i >= 0) return i;
    }
    return 0;
  }, [orders, focusedExtId]);
  const selRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const firstScrollRef = useRef(true);

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
        ) : orders.map((o, i) => (
          <SegCard
            key={o.dbId || `${o.phone}|${o.externalId}|${o.idx}`}
            o={o}
            countryCode={countryCode}
            tone={col.tone}
            selected={i === selIdx}
            cardRef={i === selIdx ? selRef : undefined}
            onOpen={() => { focusByIndex(i); if (o.externalId) navigate(`/pedido/${o.externalId}`, { state: { siblingIds } }); }}
          />
        ))}
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

export default function SegBoard({ data, countryCode, statusFilter, celebratory = false, emptyTitle = 'Sin pedidos en seguimiento', emptyDesc = 'Los pedidos sincronizados desde Dropi aparecerán aquí, en columnas por estado.' }: SegBoardProps) {
  const navigate = useNavigate();
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
  const [focusedKey, setFocusedKey] = useSessionState<SegStatusKey | null>('seg:focusedKey', null);

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

  const columns = useMemo(
    () => BOARD_COLUMNS
      .filter((c) => (statusFilter ? c.key === statusFilter : true))
      .map((c) => ({ ...c, orders: byColumn.get(c.key) ?? [] }))
      .filter((c) => c.orders.length > 0),
    [byColumn, statusFilter],
  );

  // Si al MONTAR la carpeta enfocada persistida quedó vacía (los pedidos cambiaron
  // de fase, o cambió la tienda/rango), no dejamos a la operadora atascada en la
  // pantalla "sin pedidos": caemos al tablero. Solo en el mount — si se vacía en
  // vivo mientras está adentro, mostramos el vacío con su botón "Tablero".
  const focusCheckedRef = useRef(false);
  useEffect(() => {
    if (focusCheckedRef.current) return;
    focusCheckedRef.current = true;
    if (focusedKey && (byColumn.get(focusedKey)?.length ?? 0) === 0) setFocusedKey(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Modo enfoque: una sola carpeta a lo ancho con navegación ↑/↓. Validamos el
  // key (puede venir stale de sessionStorage tras un cambio de columnas) → si no
  // existe, ignoramos y mostramos el tablero. `key={focusedKey}` remonta limpio
  // al cambiar de carpeta (así el selIdx persistido se inicializa por columna).
  if (focusedKey) {
    const def = BOARD_COLUMNS.find((c) => c.key === focusedKey);
    if (def) {
      const focusedCol = { ...def, orders: byColumn.get(focusedKey) ?? [] };
      return <FocusedColumn key={focusedKey} col={focusedCol} countryCode={countryCode} onBack={() => setFocusedKey(null)} />;
    }
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
  const firstTerminalIdx = columns.findIndex((c) => !LIVE_KEYS.has(c.key) && !CATCHALL_KEYS.has(c.key));

  return (
    <div className="flex gap-3 overflow-x-auto pb-3 -mx-1 px-1 [scrollbar-width:thin] snap-x items-start">
      {columns.map((col, colIdx) => {
        const t = TONE[col.tone];
        const isLive = LIVE_KEYS.has(col.key);
        // El catch-all va angosto (como las terminales) pero SIN atenuar.
        const isCatchall = CATCHALL_KEYS.has(col.key);
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
              'snap-start shrink-0 flex flex-col gap-2.5 rounded-2xl border bg-card/40 transition-colors',
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
              {col.orders.map((o) => (
                <SegCard
                  key={o.dbId || `${o.phone}|${o.externalId}|${o.idx}`}
                  o={o}
                  countryCode={countryCode}
                  tone={col.tone}
                  onOpen={() => o.externalId && navigate(`/pedido/${o.externalId}`, { state: { siblingIds } })}
                />
              ))}
            </ColumnBody>
          </section>
          </Fragment>
        );
      })}
    </div>
  );
}

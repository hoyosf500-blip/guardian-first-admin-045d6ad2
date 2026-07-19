import { memo, useMemo, useRef, useEffect, useLayoutEffect } from 'react';
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

// Orden de pipeline (izq → der), estilo embudo logístico.
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

// Cada tono aporta: punto con glow (acento semántico del encabezado), la barra
// superior de la columna y el chip de conteo (color + número, nunca color solo).
const TONE: Record<Tone, { dot: string; headBar: string; count: string }> = {
  neutral: { dot: 'bg-muted-foreground/50', headBar: 'border-t-muted-foreground/40', count: 'bg-muted/50 text-muted-foreground border border-border' },
  info: { dot: 'bg-info glow-info', headBar: 'border-t-info', count: 'bg-info/14 text-info border border-info/30' },
  accent: { dot: 'bg-accent glow-accent', headBar: 'border-t-accent', count: 'bg-accent/14 text-accent border border-accent/30' },
  warning: { dot: 'bg-warning glow-warning', headBar: 'border-t-warning', count: 'bg-warning/14 text-warning border border-warning/30' },
  danger: { dot: 'bg-danger glow-danger', headBar: 'border-t-danger', count: 'bg-danger/14 text-danger border border-danger/30' },
  success: { dot: 'bg-success glow-success', headBar: 'border-t-success', count: 'bg-success/14 text-success border border-success/30' },
  muted: { dot: 'bg-muted-foreground/40', headBar: 'border-t-border-strong', count: 'bg-muted/40 text-muted-foreground border border-border' },
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

function freshnessDot(o: OrderData): { cls: string; title: string } {
  const h = hoursSinceMovement(o);
  if (h == null) return { cls: 'bg-muted-foreground/40', title: 'Sin fecha de último movimiento' };
  if (h < 24) return { cls: 'bg-success', title: 'Movido en las últimas 24 h' };
  if (h < 72) return { cls: 'bg-warning', title: `Sin moverse hace ${Math.floor(h / 24)}–${Math.ceil(h / 24)} días` };
  return { cls: 'bg-danger', title: `Sin moverse hace ${Math.floor(h / 24)} días` };
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
      <div className="flex items-center gap-1.5">
        <span className={cn('h-2 w-2 rounded-full shrink-0', fresh.cls)} title={fresh.title} aria-hidden="true" />
        {/* El punto es decorativo (color solo) — el estado de frescura va en texto
            para lector de pantalla, ya que en touch el `title` no se ve. */}
        <span className="sr-only">{fresh.title}</span>
        <span className="text-xs font-mono tabular-nums font-semibold text-muted-foreground" title="Días hábiles en este estado">
          D{dias}
        </span>
        {pLevel !== 'low' && (
          <span className={cn('ml-auto text-[11px] font-semibold px-2 py-0.5 rounded-lg border shrink-0', pConfig.bgClass, pConfig.color)}>
            {pConfig.label}
          </span>
        )}
      </div>

      {/* Nombre a todo el ancho + id */}
      <div className="mt-1.5 min-w-0">
        <span className="block text-[13.5px] font-bold text-foreground truncate leading-tight">
          {o.nombre || 'Sin nombre'}
        </span>
        {o.externalId
          ? <span className="text-xs text-accent font-mono tabular-nums mt-0.5 block truncate">{o.externalId}</span>
          : <span className="text-xs text-muted-foreground font-mono mt-0.5 block">Sin ID</span>}
      </div>

      {/* Producto · ciudad en UNA línea (en el mockup van juntos) */}
      {(o.producto || o.ciudad) && (
        <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground min-w-0">
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
          y ahí sería una advertencia sobre algo que ya no se puede gestionar. */}
      {o.novedad && (tone === 'warning' || tone === 'accent' || tone === 'info' || tone === 'neutral') && (
        <div className="mt-2 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/12 px-2 py-1.5">
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
            acción vecina o navegaba al detalle. gap-2 + 44px mínimo cada uno. */}
        <div className="flex items-center gap-2 shrink-0">
          {(trackUrl || carrierHome) && (
            <a
              href={trackUrl || carrierHome || '#'}
              target="_blank" rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              title={trackUrl ? 'Rastrear envío' : 'Página de la transportadora'}
              aria-label={trackUrl ? 'Rastrear envío' : 'Página de la transportadora'}
              className="p-2.5 min-h-11 min-w-11 inline-flex items-center justify-center rounded-lg text-muted-foreground hover:text-accent hover:bg-accent/10 transition-colors"
            >
              <ExternalLink size={14} aria-hidden="true" />
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
              className="p-2.5 min-h-11 min-w-11 inline-flex items-center justify-center rounded-lg text-muted-foreground hover:text-success hover:bg-success/10 transition-colors"
            >
              <MessageCircle size={14} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); void refresh(activeStoreId, o.externalId); }}
            disabled={isRefreshing || !o.externalId}
            title="Refrescar estado desde Dropi"
            aria-label="Refrescar estado desde Dropi"
            className="p-2.5 min-h-11 min-w-11 inline-flex items-center justify-center rounded-lg text-muted-foreground hover:text-accent hover:bg-accent/10 transition-colors disabled:opacity-40"
          >
            <RefreshCw size={14} className={isRefreshing ? 'animate-spin' : ''} aria-hidden="true" />
          </button>
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
      {/* Barra de enfoque */}
      <div className="flex items-center gap-3 rounded-2xl border border-border bg-card/40 shadow-card3d px-4 py-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card/40 px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:border-border-strong transition-colors"
        >
          <ChevronLeft size={14} aria-hidden="true" /> Tablero
        </button>
        <div className="flex items-center gap-2 min-w-0">
          <span className={cn('h-2.5 w-2.5 rounded-full shrink-0', t.dot)} aria-hidden="true" />
          <span className="text-foreground/90">{col.icon}</span>
          <h3 className="text-sm font-bold text-foreground truncate">{col.label}</h3>
          <span className={cn('text-[11px] font-mono tabular-nums font-semibold px-2 py-0.5 rounded-lg', t.count)}>{orders.length}</span>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground font-mono tabular-nums">
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
}

export default function SegBoard({ data, countryCode, statusFilter, emptyTitle = 'Sin pedidos en seguimiento', emptyDesc = 'Los pedidos sincronizados desde Dropi aparecerán aquí, en columnas por estado.' }: SegBoardProps) {
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
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
        <Truck size={28} className="text-muted-foreground" aria-hidden="true" />
        <div>
          <p className="text-sm font-semibold text-foreground">{emptyTitle}</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-sm">{emptyDesc}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3 overflow-x-auto pb-3 -mx-1 px-1 [scrollbar-width:thin] snap-x">
      {columns.map((col) => {
        const t = TONE[col.tone];
        const siblingIds = col.orders.map((x) => String(x.externalId ?? '')).filter(Boolean);
        return (
          <section
            key={col.key}
            // La carpeta pasa a ser un panel con cuerpo propio: sin superficie
            // ni elevación, las tarjetas flotaban sueltas sobre el fondo y no
            // se leía dónde termina una columna y empieza la otra. Solo piel —
            // el ancho, el snap y el flujo interno quedan igual.
            className="snap-start shrink-0 w-[286px] flex flex-col gap-2.5 rounded-2xl border border-border bg-card/40 shadow-card3d"
          >
            {/* Header clickeable → enfoca esta carpeta (solo estos pedidos + ↑/↓). */}
            <button
              type="button"
              onClick={() => setFocusedKey(col.key)}
              title={`Concentrarse solo en ${col.label}`}
              // rounded-t-2xl (no rounded-xl): el header es el primer hijo del
              // panel y su fondo de hover se dibuja hasta el borde. Con un radio
              // menor que el de la carpeta, ese fondo asomaba por fuera de la
              // esquina redondeada al pasar el mouse.
              className="group/h flex items-center gap-2 rounded-t-2xl px-3 py-3 text-left hover:bg-card/60 transition-colors"
            >
              <span className={cn('h-2 w-2 rounded-full shrink-0', t.dot)} aria-hidden="true" />
              <span className="text-foreground/90">{col.icon}</span>
              <h3 className="text-[12.5px] font-semibold text-foreground truncate flex-1">{col.label}</h3>
              <Maximize2 size={12} className="text-muted-foreground opacity-0 group-hover/h:opacity-100 transition-opacity" aria-hidden="true" />
              <span className={cn('text-[11px] font-mono tabular-nums font-semibold px-2 py-0.5 rounded-lg', t.count)}>
                {col.orders.length}
              </span>
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
        );
      })}
    </div>
  );
}

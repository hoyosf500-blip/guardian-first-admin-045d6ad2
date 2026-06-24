import { memo, useMemo, useRef, useState, useEffect, useLayoutEffect } from 'react';
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

const TONE: Record<Tone, { dot: string; headBar: string; count: string }> = {
  neutral: { dot: 'bg-muted-foreground/50', headBar: 'border-t-muted-foreground/40', count: 'bg-muted/50 text-muted-foreground' },
  info: { dot: 'bg-info', headBar: 'border-t-info', count: 'bg-info/15 text-info' },
  accent: { dot: 'bg-accent', headBar: 'border-t-accent', count: 'bg-accent/15 text-accent' },
  warning: { dot: 'bg-warning', headBar: 'border-t-warning', count: 'bg-warning/15 text-warning' },
  danger: { dot: 'bg-danger', headBar: 'border-t-danger', count: 'bg-danger/15 text-danger' },
  success: { dot: 'bg-success', headBar: 'border-t-success', count: 'bg-success/15 text-success' },
  muted: { dot: 'bg-muted-foreground/40', headBar: 'border-t-border-strong', count: 'bg-muted/40 text-muted-foreground' },
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

const SegCard = memo(function SegCard({ o, countryCode, selected, cardRef, onOpen }: { o: OrderData; countryCode?: string | null; tone?: Tone; selected?: boolean; cardRef?: React.Ref<HTMLDivElement>; onOpen?: () => void }) {
  const navigate = useNavigate();
  const { refresh, isRefreshing } = useRefreshOrder();
  const { activeStoreId } = useStore();
  const { openChat } = useWaChat();
  const open = () => { if (onOpen) onOpen(); else if (o.externalId) navigate(`/pedido/${o.externalId}`); };

  const trackUrl = getTrackingUrl(o.transportadora, o.guia, countryCode);
  const carrierHome = getTrackingUrl(o.transportadora, '', countryCode);
  const dias = statusAgeDays(o);
  const priority = calcPriority(o);
  const pLevel = getPriorityLevel(priority);
  const pConfig = PRIORITY_CONFIG[pLevel];
  const fresh = freshnessDot(o);
  const waPhone = o.phone ? getWhatsAppPhone(o.phone, countryCode) : '';
  const waMsg = encodeURIComponent(`Hola ${o.nombre || ''}, le escribo sobre su pedido${o.guia ? ` (guía ${o.guia})` : ''}. ¿Cómo va su entrega?`);

  return (
    <div
      ref={cardRef}
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
      className={cn(
        'group bg-card rounded-lg border p-2.5 cursor-pointer transition-all duration-150 hover:border-border-strong hover:shadow-sm focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none',
        selected ? 'border-accent ring-2 ring-accent/60 shadow-md' : 'border-border/60',
      )}
    >
      {/* Header: nombre + frescura + días */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={cn('h-2 w-2 rounded-full shrink-0', fresh.cls)} title={fresh.title} aria-hidden="true" />
            <span className="block text-[12.5px] font-bold text-foreground truncate">{o.nombre || 'Sin nombre'}</span>
          </div>
          {o.externalId
            ? <span className="text-[10px] text-primary font-mono mt-0.5 block truncate">{o.externalId}</span>
            : <span className="text-[10px] text-muted-foreground font-mono mt-0.5 block">Sin ID</span>}
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className="text-[9px] font-mono tabular-nums px-1.5 py-0.5 rounded bg-muted/50 text-muted-foreground" title="Días hábiles en este estado">
            {dias}d
          </span>
          {pLevel !== 'low' && (
            <span className={cn('text-[8px] font-bold px-1.5 py-0.5 rounded border', pConfig.bgClass, pConfig.color)}>
              {pConfig.label}
            </span>
          )}
        </div>
      </div>

      {/* Producto + ciudad */}
      {o.producto && <p className="mt-1.5 text-[11px] text-muted-foreground leading-snug line-clamp-2">{o.producto}</p>}
      {o.ciudad && (
        <div className="mt-1 flex items-center gap-1 text-[10.5px] text-muted-foreground">
          <MapPin size={10} aria-hidden="true" /> <span className="truncate">{o.ciudad}</span>
        </div>
      )}

      {/* Guía / transportadora + rastreo */}
      <div className="mt-2 flex items-center justify-between gap-2 border-t border-border/50 pt-2">
        <div className="min-w-0 text-[10.5px] text-muted-foreground truncate">
          {o.transportadora ? <span className="font-medium text-foreground/80">{o.transportadora}</span> : 'Sin transportadora'}
          {o.guia ? <span className="font-mono"> · {o.guia}</span> : <span className="opacity-70"> · sin guía</span>}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          {(trackUrl || carrierHome) && (
            <a
              href={trackUrl || carrierHome || '#'}
              target="_blank" rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              title={trackUrl ? 'Rastrear envío' : 'Página de la transportadora'}
              className="p-2 -m-0.5 rounded text-muted-foreground hover:text-accent hover:bg-accent/10 transition-colors"
            >
              <ExternalLink size={14} aria-hidden="true" />
            </a>
          )}
          {waPhone && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void openChat({ phone: o.phone, fallbackWaUrl: `https://wa.me/${waPhone}?text=${waMsg}` });
              }}
              title="Abrir chat de WhatsApp (ver el bot / escribir)"
              aria-label="Abrir chat de WhatsApp"
              className="p-2 -m-0.5 rounded text-muted-foreground hover:text-[#25D366] hover:bg-[#25D366]/10 transition-colors"
            >
              <MessageCircle size={14} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); void refresh(activeStoreId, o.externalId); }}
            disabled={isRefreshing || !o.externalId}
            title="Refrescar estado desde Dropi"
            className="p-2 -m-0.5 rounded text-muted-foreground hover:text-accent hover:bg-accent/10 transition-colors disabled:opacity-40"
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
  useLayoutEffect(() => {
    if (!ref.current) return;
    const saved = scrollRefs.current.get(colKey);
    if (saved !== undefined && ref.current.scrollTop !== saved) ref.current.scrollTop = saved;
  });
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
  const [selIdx, setSelIdx] = useState(0);
  const selRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Clamp si la columna cambia de tamaño en vivo (un pedido se movió de fase).
  useEffect(() => {
    setSelIdx((i) => Math.min(i, Math.max(0, orders.length - 1)));
  }, [orders.length]);

  // Scroll del seleccionado a la vista al moverse con ↑/↓.
  useEffect(() => {
    selRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selIdx]);

  const move = (delta: number) => setSelIdx((i) => Math.min(orders.length - 1, Math.max(0, i + delta)));

  return (
    <div className="space-y-3">
      {/* Barra de enfoque */}
      <div className="flex items-center gap-3 rounded-xl border border-border bg-surface/50 px-3 py-2">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-semibold text-foreground hover:border-border-strong transition-colors"
        >
          <ChevronLeft size={14} aria-hidden="true" /> Tablero
        </button>
        <div className="flex items-center gap-2 min-w-0">
          <span className={cn('h-2.5 w-2.5 rounded-full shrink-0', t.dot)} aria-hidden="true" />
          <span className="text-foreground/90">{col.icon}</span>
          <h3 className="text-sm font-bold text-foreground truncate">{col.label}</h3>
          <span className={cn('text-[11px] font-mono tabular-nums font-bold px-2 py-0.5 rounded-full', t.count)}>{orders.length}</span>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {orders.length ? `${selIdx + 1} / ${orders.length}` : '0 / 0'}
          </span>
          <button
            type="button"
            onClick={() => { move(-1); listRef.current?.focus(); }}
            disabled={selIdx <= 0}
            title="Anterior (↑)"
            className="p-1.5 rounded-lg border border-border bg-card text-foreground hover:border-border-strong transition-colors disabled:opacity-40"
          >
            <ChevronUp size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => { move(1); listRef.current?.focus(); }}
            disabled={selIdx >= orders.length - 1}
            title="Siguiente (↓)"
            className="p-1.5 rounded-lg border border-border bg-card text-foreground hover:border-border-strong transition-colors disabled:opacity-40"
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
            onOpen={() => o.externalId && navigate(`/pedido/${o.externalId}`, { state: { siblingIds } })}
          />
        ))}
      </div>
    </div>
  );
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
  const scrollRefs = useRef<Map<string, number>>(new Map());
  // Columna enfocada (carpeta). null = tablero completo.
  const [focusedKey, setFocusedKey] = useState<SegStatusKey | null>(null);

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

  // Modo enfoque: una sola carpeta a lo ancho con navegación ↑/↓.
  if (focusedKey) {
    const def = BOARD_COLUMNS.find((c) => c.key === focusedKey)!;
    const focusedCol = { ...def, orders: byColumn.get(focusedKey) ?? [] };
    return <FocusedColumn col={focusedCol} countryCode={countryCode} onBack={() => setFocusedKey(null)} />;
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
            className={cn('snap-start shrink-0 w-[270px] flex flex-col rounded-xl border border-border bg-surface/40 border-t-[3px]', t.headBar)}
          >
            {/* Header clickeable → enfoca esta carpeta (solo estos pedidos + ↑/↓). */}
            <button
              type="button"
              onClick={() => setFocusedKey(col.key)}
              title={`Concentrarse solo en ${col.label}`}
              className="group/h flex items-center gap-2 px-3 py-2.5 border-b border-border/60 text-left hover:bg-card/50 transition-colors"
            >
              <span className={cn('h-2 w-2 rounded-full shrink-0', t.dot)} aria-hidden="true" />
              <span className="text-foreground/90">{col.icon}</span>
              <h3 className="text-[12px] font-bold text-foreground truncate flex-1">{col.label}</h3>
              <Maximize2 size={12} className="text-muted-foreground opacity-0 group-hover/h:opacity-100 transition-opacity" aria-hidden="true" />
              <span className={cn('text-[11px] font-mono tabular-nums font-bold px-2 py-0.5 rounded-full', t.count)}>
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

import { useEffect, useMemo, useState, useCallback } from 'react';
import { useStore } from '@/contexts/StoreContext';
import { useShopifyPending, useShopifyValueMismatches, type ShopifyPendingItem } from '@/hooks/useShopifyPending';
import { usePushToDropi } from '@/hooks/usePushToDropi';
import { useShopifyManualMarks } from '@/hooks/useShopifyManualMarks';
import PushToDropiModal from './PushToDropiModal';
import ShopifyMarksHistoryModal from './ShopifyMarksHistoryModal';
import { pollWhenVisible } from '@/lib/pollWhenVisible';
import { ShoppingBag, RefreshCw, Copy, Check, ExternalLink, ChevronDown, ChevronUp, AlertTriangle, CheckCircle2, Truck, Loader2, History } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';

const DONE_KEY = (storeId: string) => `guardian.shopifyDone:${storeId}`;
const BOGOTA = 'America/Bogota'; // UTC-5 — sirve para Colombia y Ecuador

function loadDone(storeId: string): Set<string> {
  try { return new Set(JSON.parse(sessionStorage.getItem(DONE_KEY(storeId)) || '[]')); }
  catch { return new Set(); }
}

const localDay = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: BOGOTA }).format(new Date(iso));
const localTime = (iso: string) => new Intl.DateTimeFormat('es-CO', { timeZone: BOGOTA, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

function dayLabel(date: string, today?: string): string {
  if (today) {
    if (date === today) return 'Hoy';
    const t = new Date(today + 'T12:00:00Z');
    t.setUTCDate(t.getUTCDate() - 1);
    if (date === t.toISOString().slice(0, 10)) return 'Ayer';
  }
  const [, m, d] = date.split('-');
  return `${d}/${m}`;
}

/**
 * Panel de reconciliación Shopify ↔ Dropi (arriba de la cola de Confirmar).
 * Muestra el total de Shopify, cuántos ya están en Dropi y cuántos faltan —
 * de hoy y del período — + la lista de pendientes agrupada por día. El
 * contador baja con cada "Ya lo metí" (optimista local) y se confirma en el
 * próximo refresh, cuando el pedido ya aparece en Dropi.
 */
export default function ShopifyPendingPanel() {
  const { activeStoreId } = useStore();
  const { data, isLoading, isFetching, refetch } = useShopifyPending(activeStoreId);
  const { data: vmData } = useShopifyValueMismatches(activeStoreId);
  const { confirm: confirmPush } = usePushToDropi(activeStoreId);
  const { markEntered } = useShopifyManualMarks(activeStoreId);
  const [expanded, setExpanded] = useState(false);
  const [showMismatches, setShowMismatches] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [done, setDone] = useState<Set<string>>(() => activeStoreId ? loadDone(activeStoreId) : new Set());
  const [copied, setCopied] = useState<string | null>(null);
  // Bloqueo breve tras una marca: evita que un 2º click accidental caiga sobre
  // la fila que se corrió hacia arriba cuando la anterior desapareció.
  const [lockMarks, setLockMarks] = useState(false);
  // Pedido abierto en el modal "Subir a Dropi"
  const [pushItem, setPushItem] = useState<ShopifyPendingItem | null>(null);
  // Subida en lote
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [bulkRunning, setBulkRunning] = useState(false);

  useEffect(() => { setDone(activeStoreId ? loadDone(activeStoreId) : new Set()); }, [activeStoreId]);

  useEffect(() => {
    if (!activeStoreId) return;
    return pollWhenVisible(() => { void refetch(); }, 120000, { runOnVisible: false });
  }, [activeStoreId, refetch]);

  const pending: ShopifyPendingItem[] = useMemo(() => data?.pending ?? [], [data]);

  // Limpieza del set local: si un pedido ya NO está pendiente (entró a Dropi),
  // lo sacamos del set para no inflar el "ya metidos".
  useEffect(() => {
    if (!activeStoreId || !data) return;
    const pendingIds = new Set(pending.map(p => p.id));
    setDone(prev => {
      const next = new Set([...prev].filter(id => pendingIds.has(id)));
      // Idempotente: si no se removió nada, devolver `prev` para no crear un
      // Set nuevo en cada `data` (evita un re-render extra del panel).
      if (next.size === prev.size) return prev;
      try { sessionStorage.setItem(DONE_KEY(activeStoreId), JSON.stringify([...next])); } catch { /* noop */ }
      return next;
    });
  }, [data, pending, activeStoreId]);

  const markDone = useCallback((id: string) => {
    if (!activeStoreId) return;
    setDone(prev => {
      const next = new Set(prev).add(id);
      try { sessionStorage.setItem(DONE_KEY(activeStoreId), JSON.stringify([...next])); } catch { /* noop */ }
      return next;
    });
  }, [activeStoreId]);

  // "Ya lo metí": esconde local (snappy) + PERSISTE la marca (auditable + revertible).
  // Guard anti-doble-click: ignora si ya está marcado o si hay un bloqueo activo.
  const handleYaLoMeti = useCallback(async (p: ShopifyPendingItem) => {
    if (!activeStoreId || lockMarks || done.has(p.id)) return;
    setLockMarks(true);
    markDone(p.id);
    const r = await markEntered({ id: p.id, name: p.name, customer: p.customer, phone: p.phone, total: p.total, city: p.city });
    if (!r.ok) toast.error('No se pudo guardar la marca: ' + (r.error || ''));
    setTimeout(() => setLockMarks(false), 600);
  }, [activeStoreId, lockMarks, done, markDone, markEntered]);

  // Revertir desde el historial: saca el pedido del `done` local y refetchea →
  // vuelve a aparecer en la cola de pendientes para meterlo bien.
  const handleReverted = useCallback((orderId: string) => {
    if (!activeStoreId) return;
    setDone(prev => {
      if (!prev.has(orderId)) return prev;
      const next = new Set(prev); next.delete(orderId);
      try { sessionStorage.setItem(DONE_KEY(activeStoreId), JSON.stringify([...next])); } catch { /* noop */ }
      return next;
    });
    void refetch();
  }, [activeStoreId, refetch]);

  // Ids de TODOS los pendientes (antes del filtro `done`) — el historial los usa
  // para marcar en rojo las marcas cuyo pedido sigue sin estar en Dropi.
  const pendingIdSet = useMemo(() => new Set(pending.map(p => p.id)), [pending]);

  const copyPhone = useCallback(async (phone: string) => {
    try { await navigator.clipboard.writeText(phone); setCopied(phone); setTimeout(() => setCopied(null), 1500); } catch { /* noop */ }
  }, []);

  const visible = useMemo(() => pending.filter(p => !done.has(p.id)), [pending, done]);
  const groups = useMemo(() => {
    const byDay = new Map<string, ShopifyPendingItem[]>();
    for (const p of visible) {
      const d = localDay(p.created_at);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d)!.push(p);
    }
    return [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [visible]);

  // Subir TODOS los pendientes visibles a Dropi (datos auto de Shopify). Los que
  // fallen (productos sin vínculo, ciudad rara, etc.) NO se marcan y quedan en
  // la lista para subirlos uno por uno con el modal. Crea órdenes reales: por
  // eso pide una confirmación previa (bulkConfirm).
  const runBulk = useCallback(async () => {
    if (!activeStoreId || bulkRunning) return;
    setBulkRunning(true); setBulkConfirm(false);
    const targets = [...visible];
    let okCount = 0; const fails: string[] = [];
    for (const p of targets) {
      const r = await confirmPush(p.id);            // sin overrides = valores de Shopify
      if (r.ok) { okCount++; markDone(p.id); }
      else fails.push(`${p.name}: ${r.error || 'error'}`);
      await new Promise(res => setTimeout(res, 400)); // pacing suave
    }
    setBulkRunning(false);
    if (okCount > 0) toast.success(`${okCount} pedido(s) subido(s) a Dropi`);
    if (fails.length > 0) toast.error(`${fails.length} no se pudieron subir`, { description: fails.slice(0, 4).join(' · ') });
    void refetch();
  }, [activeStoreId, bulkRunning, visible, confirmPush, markDone, refetch]);

  // Guards: no estorbar la cola si no hay tienda / no cargó / no configurado.
  if (!activeStoreId) return null;
  if (isLoading && !data) return null;
  // Si la función no respondió (no deployada / error de red) NO mostramos nada
  // engañoso — el dueño ve el error real en /admin → Shopify → "Probar".
  if (!data || data.configured === false) return null;
  if (!data.ok) {
    return (
      <div className="mb-4 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-2.5 text-sm text-destructive flex items-center gap-2">
        <AlertTriangle size={15} />
        <span>No se pudo revisar Shopify: {data.error || 'error'}</span>
        <button onClick={() => refetch()} className="ml-auto text-destructive/80 hover:text-destructive" title="Reintentar">
          <RefreshCw size={13} className={isFetching ? 'animate-spin' : ''} />
        </button>
      </div>
    );
  }

  // Números (consistentes con el decremento local "ya lo metí").
  const count = visible.length;
  const allClear = count === 0;
  const days = data.days ?? 3;
  const periodShopify = data.shopifyTotal ?? 0;
  const periodMatched = Math.max(0, periodShopify - count);
  const todayShopify = data.todayShopify ?? 0;
  const todayPendingVisible = data.today
    ? visible.filter(p => localDay(p.created_at) === data.today).length
    : (data.todayPending ?? 0);
  const todayMatched = Math.max(0, todayShopify - todayPendingVisible);
  const cancelled = data.cancelledCount ?? 0;

  const accent = allClear ? 'success' : 'warning';

  // Aviso de pedidos YA en Dropi con valor distinto al de Shopify (cobro de más).
  // Independiente de la cola de pendientes; le ahorra al operador revisar a mano.
  const mismatches = vmData?.valueMismatches ?? [];
  const mismatchBanner = mismatches.length > 0 ? (
    <div className="mb-4 rounded-xl border border-destructive/40 bg-destructive/10 overflow-hidden">
      <div className="px-4 py-3 flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-destructive/20 flex items-center justify-center flex-shrink-0">
          <AlertTriangle size={18} className="text-destructive" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-extrabold tabular-nums text-destructive">{mismatches.length}</span>
            <span className="text-sm font-semibold text-foreground">con valor distinto a Shopify</span>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Dropi va a cobrar más de lo que el cliente aceptó — corregilo en el panel de Dropi para que no rechacen la entrega.
          </p>
        </div>
        <button onClick={() => setShowMismatches(s => !s)}
          className="h-8 px-3 rounded-lg border border-border bg-card text-xs font-medium text-foreground flex items-center gap-1 flex-shrink-0">
          {showMismatches ? 'Ocultar' : 'Ver lista'}
          {showMismatches ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
      </div>
      <AnimatePresence>
        {showMismatches && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            className="border-t border-destructive/30 max-h-[24rem] overflow-y-auto bg-card/50 divide-y divide-border">
            {mismatches.map(m => (
              <div key={m.external_id || m.shopify_name} className="px-4 py-2.5 flex items-center gap-3 text-sm">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-foreground truncate">{m.customer}</span>
                    <span className="text-[10px] font-mono text-muted-foreground">{m.shopify_name}</span>
                    {m.estado && <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{m.estado}</span>}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 text-xs mt-0.5">
                    <span className="text-muted-foreground">Shopify <span className="tabular-nums text-foreground">${m.shopify_total.toLocaleString()}</span></span>
                    <span className="text-muted-foreground">· Dropi <span className="tabular-nums font-semibold text-destructive">${m.dropi_valor.toLocaleString()}</span></span>
                    <span className="font-semibold text-destructive">(+${m.overcharge.toLocaleString()} de más)</span>
                  </div>
                </div>
                <a href={m.admin_url} target="_blank" rel="noreferrer" title="Abrir en Shopify"
                  className="h-7 w-7 rounded-lg border border-border bg-card flex items-center justify-center text-muted-foreground hover:text-foreground flex-shrink-0">
                  <ExternalLink size={12} />
                </a>
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  ) : null;

  return (
    <>
    {mismatchBanner}
    {/* No `initial` animation: el panel se re-monta cada refetch (cuando
        `data` flipa momentáneamente, o cuando el guard `!data || configured`
        cambia), y `motion.div initial=opacity:0,y:8` re-disparaba la animación
        de entrada → la pila visual de arriba "parpadeaba" cada poll. */}
    <div
      className={`mb-4 rounded-xl border overflow-hidden ${allClear ? 'border-success/40 bg-success/10' : 'border-warning/40 bg-warning/10'}`}>
      {/* Layout 2-rows en mobile, 1-row en sm+:
            - Row 1 (siempre): icono · texto principal · Actualizar (refresh).
            - Row 2: botones de acción (Subir todos / Ver lista). En mobile son
              full-width; en sm+ se acomodan a la derecha en la misma fila.
            En mobile el texto principal NO compite con 2 botones por espacio,
            así que "N sin pasar a Dropi" ya no se apila letra por palabra. */}
      <div className="px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${allClear ? 'bg-success/20' : 'bg-warning/20'}`}>
          {allClear ? <CheckCircle2 size={18} className="text-success" aria-hidden="true" /> : <ShoppingBag size={18} className="text-warning" aria-hidden="true" />}
        </div>
        <div className="flex-1 min-w-0 basis-[14rem]">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className={`text-2xl font-extrabold tabular-nums ${allClear ? 'text-success' : 'text-foreground'}`}>{count}</span>
            <span className="text-sm font-semibold text-foreground">
              {allClear ? 'sin pasar a Dropi — todo al día ✓' : 'sin pasar a Dropi'}
            </span>
          </div>
          {/* Tira de reconciliación: hoy + período */}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span>
              <span className="font-medium text-foreground">Hoy:</span> {todayShopify} en Shopify · {todayMatched} en Dropi ·{' '}
              <span className={todayPendingVisible > 0 ? 'font-semibold text-warning' : ''}>{todayPendingVisible} sin pasar</span>
            </span>
            <span className="opacity-50">|</span>
            <span>
              <span className="font-medium text-foreground">Últimos {days}d:</span> {periodShopify} en Shopify · {periodMatched} en Dropi ·{' '}
              <span className={count > 0 ? 'font-semibold text-warning' : ''}>{count} sin pasar</span>
            </span>
            {cancelled > 0 && <span className="opacity-70">· {cancelled} cancelados</span>}
          </div>
        </div>
        <button onClick={() => setShowHistory(true)} aria-label="Ver historial de lo que metí"
          title='Historial de "Ya lo metí" — verificá y revertí'
          className="h-9 px-2.5 rounded-lg border border-border bg-card flex items-center justify-center gap-1.5 text-muted-foreground hover:text-foreground flex-shrink-0 text-xs font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          <History size={14} aria-hidden="true" /> <span className="hidden sm:inline">Historial</span>
        </button>
        <button onClick={() => refetch()} aria-label="Actualizar Shopify"
          className="h-9 w-9 rounded-lg border border-border bg-card flex items-center justify-center text-muted-foreground hover:text-foreground flex-shrink-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          <RefreshCw size={14} className={isFetching ? 'motion-safe:animate-spin' : ''} aria-hidden="true" />
        </button>
        {count > 0 && (
          <div className="flex items-center gap-2 basis-full sm:basis-auto sm:ml-auto">
            <button onClick={() => { setExpanded(true); setBulkConfirm(true); }} disabled={bulkRunning}
              aria-label="Subir todos los pendientes a Dropi"
              className="h-9 px-3 rounded-lg bg-primary text-primary-foreground text-xs font-semibold inline-flex items-center justify-center gap-1.5 hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none flex-1 sm:flex-none">
              {bulkRunning ? <Loader2 size={13} className="motion-safe:animate-spin" aria-hidden="true" /> : <Truck size={13} aria-hidden="true" />} Subir todos
            </button>
            <button onClick={() => setExpanded(e => !e)}
              aria-label={expanded ? 'Ocultar lista de pendientes' : 'Ver lista de pendientes'}
              aria-expanded={expanded}
              className="h-9 px-3 rounded-lg border border-border bg-card text-xs font-semibold text-foreground inline-flex items-center justify-center gap-1.5 hover:border-border-strong cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none flex-1 sm:flex-none">
              {expanded ? 'Ocultar' : 'Ver lista'}
              {expanded ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
            </button>
          </div>
        )}
      </div>

      {/* Confirmación de subida en lote */}
      {bulkConfirm && count > 0 && (
        <div className="px-4 py-2.5 border-t border-warning/30 bg-warning/5 flex flex-wrap items-center gap-2 text-xs">
          <AlertTriangle size={14} className="text-warning flex-shrink-0" />
          <span className="text-foreground flex-1 min-w-[12rem]">
            Vas a crear <strong>{count}</strong> pedido(s) reales en Dropi con los datos de Shopify (genera guía y flete). Los que tengan productos sin vínculo quedarán en la lista.
          </span>
          <button onClick={() => setBulkConfirm(false)} className="h-7 px-3 rounded-lg border border-border bg-card text-muted-foreground hover:text-foreground">Cancelar</button>
          <button onClick={runBulk} className="h-7 px-3 rounded-lg bg-primary text-primary-foreground font-medium flex items-center gap-1 hover:bg-primary/90">
            <Truck size={12} /> Sí, subir {count}
          </button>
        </div>
      )}

      <AnimatePresence>
        {expanded && count > 0 && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            className="border-t border-warning/30 max-h-[28rem] overflow-y-auto bg-card/50">
            {groups.map(([date, items]) => (
              <div key={date}>
                <div className="sticky top-0 z-10 px-4 py-1.5 bg-card/95 backdrop-blur border-b border-border flex items-center gap-2 text-xs">
                  <span className="font-semibold text-foreground">{dayLabel(date, data.today)}</span>
                  <span className="text-muted-foreground">· {items.length} sin pasar</span>
                </div>
                <div className="divide-y divide-border">
                  {items.map(p => (
                    <div key={p.id} className="px-4 py-2.5 flex items-center gap-3 text-sm">
                      <span className="text-[10px] font-mono text-muted-foreground w-10 flex-shrink-0">{localTime(p.created_at)}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-foreground truncate">{p.customer}</span>
                          <span className="text-[10px] font-mono text-muted-foreground">{p.name}</span>
                          {p.sin_telefono && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-destructive/15 text-destructive">sin teléfono</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                          {p.phone
                            ? <button onClick={() => copyPhone(p.phone)} className="font-mono hover:text-foreground flex items-center gap-1">
                                {p.phone} {copied === p.phone ? <Check size={11} className="text-success" /> : <Copy size={10} />}
                              </button>
                            : <span className="italic">—</span>}
                          {p.city && <span>· {p.city}</span>}
                          {p.total > 0 && <span>· ${p.total.toLocaleString()}</span>}
                        </div>
                      </div>
                      <a href={p.admin_url} target="_blank" rel="noreferrer" title="Abrir en Shopify"
                        className="h-7 w-7 rounded-lg border border-border bg-card flex items-center justify-center text-muted-foreground hover:text-foreground flex-shrink-0">
                        <ExternalLink size={12} />
                      </a>
                      <button onClick={() => setPushItem(p)} title="Subir este pedido a Dropi"
                        className="h-7 px-2.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 flex items-center gap-1 flex-shrink-0">
                        <Truck size={12} /> Subir a Dropi
                      </button>
                      <button onClick={() => handleYaLoMeti(p)} disabled={lockMarks} title="Ya lo cargué manualmente"
                        className="h-7 px-2.5 rounded-lg border border-border bg-card text-xs font-medium text-muted-foreground hover:text-foreground flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed">
                        Ya lo metí
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {pushItem && activeStoreId && (
        <PushToDropiModal
          storeId={activeStoreId}
          shopifyOrderId={pushItem.id}
          shopifyName={pushItem.name}
          onClose={() => setPushItem(null)}
          onSuccess={(/* dropiOrderId */) => { markDone(pushItem.id); setPushItem(null); void refetch(); }}
        />
      )}

      {showHistory && activeStoreId && (
        <ShopifyMarksHistoryModal
          storeId={activeStoreId}
          pendingIds={pendingIdSet}
          onClose={() => setShowHistory(false)}
          onReverted={handleReverted}
        />
      )}
    </div>
    </>
  );
}

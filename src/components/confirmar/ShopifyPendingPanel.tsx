import { useEffect, useMemo, useState, useCallback } from 'react';
import { useStore } from '@/contexts/StoreContext';
import { useAuth } from '@/contexts/AuthContext';
import { useShopifyPending, useShopifyValueMismatches, type ShopifyPendingItem } from '@/hooks/useShopifyPending';
import { usePushToDropi } from '@/hooks/usePushToDropi';
import DropiProductSearch from '@/components/DropiProductSearch';
import { useShopifyManualMarks } from '@/hooks/useShopifyManualMarks';
import { useDuplicatePhones } from '@/hooks/useDuplicatePhones';
import { dupMatchesFor, isBlockedByDuplicate, uniquePhones } from '@/lib/duplicatePhones';
import { matchesQuery } from '@/lib/textSearch';
import { supabase } from '@/integrations/supabase/client';
import { bogotaToday, formatCOP } from '@/lib/utils';
import PushToDropiModal from './PushToDropiModal';
import ShopifyMarksHistoryModal from './ShopifyMarksHistoryModal';
import { pollWhenVisible } from '@/lib/pollWhenVisible';
import { ShoppingBag, RefreshCw, Copy, Check, ExternalLink, ChevronDown, ChevronUp, AlertTriangle, CheckCircle2, Truck, Loader2, History, Ban, ShieldCheck, Search, X, Link2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';

const DONE_KEY = (storeId: string) => `guardian.shopifyDone:${storeId}`;
const DUP_OVERRIDE_KEY = (storeId: string) => `guardian.dupOverride:${storeId}`;
const MISMATCH_FIXED_KEY = (storeId: string) => `guardian.mismatchFixed:${storeId}`;
const BOGOTA = 'America/Bogota'; // UTC-5 — sirve para Colombia y Ecuador

function loadDone(storeId: string): Set<string> {
  try { return new Set(JSON.parse(sessionStorage.getItem(DONE_KEY(storeId)) || '[]')); }
  catch { return new Set(); }
}

function loadOverrides(storeId: string): Set<string> {
  try { return new Set(JSON.parse(sessionStorage.getItem(DUP_OVERRIDE_KEY(storeId)) || '[]')); }
  catch { return new Set(); }
}

function loadMismatchFixed(storeId: string): Set<string> {
  try { return new Set(JSON.parse(sessionStorage.getItem(MISMATCH_FIXED_KEY(storeId)) || '[]')); }
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
  const { data: vmData, refetch: vmRefetch } = useShopifyValueMismatches(activeStoreId);
  const { confirm: confirmPush, linkProduct } = usePushToDropi(activeStoreId);
  const { markEntered } = useShopifyManualMarks(activeStoreId);
  const { user } = useAuth();
  const [expanded, setExpanded] = useState(false);
  const [showMismatches, setShowMismatches] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [done, setDone] = useState<Set<string>>(() => activeStoreId ? loadDone(activeStoreId) : new Set());
  // "No es duplicado" por id de pedido (escape para recompra legítima).
  const [dupOverrides, setDupOverrides] = useState<Set<string>>(() => activeStoreId ? loadOverrides(activeStoreId) : new Set());
  // "Ya lo corregí" en valor-distinto: ids que la operadora ya resolvió a mano.
  const [mismatchFixed, setMismatchFixed] = useState<Set<string>>(() => activeStoreId ? loadMismatchFixed(activeStoreId) : new Set());
  // Buscador de la lista de pendientes (no toca el contador ni "Subir todos").
  const [pendingSearch, setPendingSearch] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  // Bloqueo breve tras una marca: evita que un 2º click accidental caiga sobre
  // la fila que se corrió hacia arriba cuando la anterior desapareció.
  const [lockMarks, setLockMarks] = useState(false);
  // Pedido abierto en el modal "Subir a Dropi"
  const [pushItem, setPushItem] = useState<ShopifyPendingItem | null>(null);
  // Subida en lote
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [bulkRunning, setBulkRunning] = useState(false);
  // Productos sin vínculo detectados durante el último bulk (para vincular UNA vez
  // desde el panel y desbloquear todos los pedidos con ese producto de golpe).
  const [unmappedProducts, setUnmappedProducts] = useState<Array<{ product_id: number; title: string; count: number }>>([]);
  const [linkingId, setLinkingId] = useState<number | null>(null);
  const [manualLink, setManualLink] = useState<Record<number, string>>({});

  useEffect(() => {
    setDone(activeStoreId ? loadDone(activeStoreId) : new Set());
    setDupOverrides(activeStoreId ? loadOverrides(activeStoreId) : new Set());
    setMismatchFixed(activeStoreId ? loadMismatchFixed(activeStoreId) : new Set());
  }, [activeStoreId]);

  useEffect(() => {
    if (!activeStoreId) return;
    // Refresca pendientes Y valor-distinto → el panel de mismatches se actualiza
    // solo (un pedido corregido/cancelado en Dropi cae de la lista al re-sincar).
    return pollWhenVisible(() => { void refetch(); void vmRefetch(); }, 120000, { runOnVisible: false });
  }, [activeStoreId, refetch, vmRefetch]);

  const pending: ShopifyPendingItem[] = useMemo(() => data?.pending ?? [], [data]);

  // Anti-duplicados: teléfonos de los pendientes → pedidos Dropi NO cancelados
  // que YA existen con ese mismo teléfono (regla "teléfono repetido siempre").
  const pendingPhones = useMemo(() => uniquePhones(pending), [pending]);
  const { dupMap } = useDuplicatePhones(activeStoreId, pendingPhones);

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
    if (isBlockedByDuplicate(p, dupMap, dupOverrides)) return;  // bloqueo anti-duplicado
    setLockMarks(true);
    markDone(p.id);
    const r = await markEntered({ id: p.id, name: p.name, customer: p.customer, phone: p.phone, total: p.total, city: p.city });
    if (!r.ok) toast.error('No se pudo guardar la marca: ' + (r.error || ''));
    setTimeout(() => setLockMarks(false), 600);
  }, [activeStoreId, lockMarks, done, dupMap, dupOverrides, markDone, markEntered]);

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

  // "No es duplicado, enviar igual": destraba ESA fila y deja un touchpoint de
  // auditoría (quién y cuándo) — escape para la recompra legítima.
  const markNotDuplicate = useCallback((p: ShopifyPendingItem) => {
    if (!activeStoreId) return;
    setDupOverrides(prev => {
      const next = new Set(prev).add(p.id);
      try { sessionStorage.setItem(DUP_OVERRIDE_KEY(activeStoreId), JSON.stringify([...next])); } catch { /* noop */ }
      return next;
    });
    if (user) {
      void supabase.from('touchpoints').insert({
        phone: p.phone,
        action: `DUP_OVERRIDE: "No es duplicado", enviar igual (${p.name})`,
        operator_id: user.id,
        action_date: bogotaToday(),
        action_time: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: BOGOTA }),
        store_id: activeStoreId,
      });
    }
    toast.success('Marcado como no-duplicado — ya podés enviarlo');
  }, [activeStoreId, user]);

  // "Quitar del CRM": el pedido ya está en Dropi → solo lo escondemos local para
  // que deje de molestar (NO crea nada). El sobrante en Dropi se borra a mano.
  const quitarDelCrm = useCallback((id: string) => { markDone(id); }, [markDone]);

  // "Ya lo corregí" (valor distinto): la operadora ya ajustó el precio en Dropi →
  // lo sacamos de la lista (dismiss local por tienda). Al re-sincar con el valor
  // corregido, tampoco reaparece.
  const markMismatchFixed = useCallback((id: string) => {
    if (!activeStoreId) return;
    setMismatchFixed(prev => {
      const next = new Set(prev).add(id);
      try { sessionStorage.setItem(MISMATCH_FIXED_KEY(activeStoreId), JSON.stringify([...next])); } catch { /* noop */ }
      return next;
    });
  }, [activeStoreId]);

  const copyPhone = useCallback(async (phone: string) => {
    try { await navigator.clipboard.writeText(phone); setCopied(phone); setTimeout(() => setCopied(null), 1500); } catch { /* noop */ }
  }, []);

  const visible = useMemo(() => pending.filter(p => !done.has(p.id)), [pending, done]);
  // La lista MOSTRADA aplica el buscador; el contador, el banner y "Subir todos"
  // siguen sobre `visible` (el total real, no lo filtrado por búsqueda).
  const searchedVisible = useMemo(
    () => pendingSearch.trim()
      ? visible.filter(p => matchesQuery([p.customer, p.phone, p.name, p.city], pendingSearch))
      : visible,
    [visible, pendingSearch],
  );
  const groups = useMemo(() => {
    const byDay = new Map<string, ShopifyPendingItem[]>();
    for (const p of searchedVisible) {
      const d = localDay(p.created_at);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d)!.push(p);
    }
    return [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [searchedVisible]);

  // Subir TODOS los pendientes visibles a Dropi (datos auto de Shopify). Los que
  // fallen (productos sin vínculo, ciudad rara, etc.) NO se marcan y quedan en
  // la lista para subirlos uno por uno con el modal. Crea órdenes reales: por
  // eso pide una confirmación previa (bulkConfirm).
  const runBulk = useCallback(async () => {
    if (!activeStoreId || bulkRunning) return;
    setBulkRunning(true); setBulkConfirm(false);
    // Omite duplicados: nunca subir en lote algo que ya está en Dropi.
    const skipped = visible.filter(p => isBlockedByDuplicate(p, dupMap, dupOverrides));
    const targets = visible.filter(p => !isBlockedByDuplicate(p, dupMap, dupOverrides));
    let okCount = 0; const fails: string[] = [];
    // Recolecta los productos sin vínculo que hicieron fallar pedidos: se muestran
    // abajo para vincularlos UNA vez (el mapeo es por producto/tienda → desbloquea
    // todos los pedidos con ese producto). Clave = shopify product_id.
    const unmap = new Map<number, { product_id: number; title: string; count: number }>();
    for (const p of targets) {
      // allow_duplicate solo si la operadora marcó "No es duplicado" en ESE pedido
      // (los otros duplicados ya se excluyeron arriba). El guard server-side revalida.
      const r = await confirmPush(p.id, undefined, dupOverrides.has(p.id));
      if (r.ok) { okCount++; markDone(p.id); }
      else {
        fails.push(`${p.name}: ${r.error || 'error'}`);
        for (const u of (r.unmapped ?? [])) {
          if (typeof u.product_id !== 'number' || u.product_id <= 0) continue;
          const e = unmap.get(u.product_id) || { product_id: u.product_id, title: u.title || `Producto ${u.product_id}`, count: 0 };
          e.count++; unmap.set(u.product_id, e);
        }
      }
      await new Promise(res => setTimeout(res, 400)); // pacing suave
    }
    setBulkRunning(false);
    setUnmappedProducts([...unmap.values()].sort((a, b) => b.count - a.count));
    if (okCount > 0) toast.success(`${okCount} pedido(s) subido(s) a Dropi`);
    if (skipped.length > 0) toast.warning(`${skipped.length} omitido(s) por posible duplicado — revisalos en la lista`);
    if (unmap.size > 0) toast.warning(`${unmap.size} producto(s) sin vincular — vinculalos abajo y reintentá`);
    else if (fails.length > 0) toast.error(`${fails.length} no se pudieron subir`, { description: fails.slice(0, 4).join(' · ') });
    void refetch();
  }, [activeStoreId, bulkRunning, visible, dupMap, dupOverrides, confirmPush, markDone, refetch]);

  // Vincula un producto Shopify→Dropi (una vez por tienda) y lo saca de la lista de
  // sin-vínculo. Después basta "Reintentar faltantes" para subir los que dependían de él.
  const doLinkProduct = useCallback(async (shopifyProductId: number, dropiId: number, variationId: number | null) => {
    if (!Number.isInteger(dropiId) || dropiId <= 0) { toast.error('Poné un id de Dropi válido (números).'); return; }
    setLinkingId(shopifyProductId);
    const r = await linkProduct(shopifyProductId, dropiId, variationId);
    setLinkingId(null);
    if (!r.ok) { toast.error(r.error || 'No se pudo vincular'); return; }
    setUnmappedProducts(prev => prev.filter(u => u.product_id !== shopifyProductId));
    toast.success('Producto vinculado ✓ — tocá "Reintentar faltantes"');
  }, [linkProduct]);

  // Cuántos de los visibles están bloqueados por duplicado (para el banner).
  const dupBlockedCount = useMemo(
    () => visible.filter(p => isBlockedByDuplicate(p, dupMap, dupOverrides)).length,
    [visible, dupMap, dupOverrides],
  );

  // CAUSA RAÍZ: qué productos se fugan más (agrupa los pendientes por producto).
  // Vincular UNA vez ese producto Shopify→Dropi corta la fuga de raíz. `producto`
  // viene del reconcile (vacío hasta redeployar shopify-reconcile) → si está vacío,
  // no mostramos el resumen (no rompe).
  const topLeakProducts = useMemo(() => {
    const byProd = new Map<string, number>();
    for (const p of visible) {
      const key = (p.producto || '').trim();
      if (!key) continue;
      byProd.set(key, (byProd.get(key) || 0) + 1);
    }
    return [...byProd.entries()]
      .map(([producto, count]) => ({ producto, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);
  }, [visible]);

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

  // Fuera de ventana: ventas de +7 días que SIGUEN sin pasar a Dropi. Se deriva
  // del reconcile de 30d (vmData, staleTime 10 min — ya cargado para los
  // value-mismatches) menos los pendientes de la ventana de 7d (data). No hace
  // llamadas de red extra ni duplica la cola: es solo un aviso para que no se
  // pierdan confirmaciones en silencio cuando una venta se cae de la ventana.
  // Si vmData todavía no cargó, no calculamos (mostramos "…" en el banner).
  const vmPendingLoaded = typeof vmData?.pendingCount === 'number';
  const outOfWindowCount = vmPendingLoaded
    ? Math.max(0, (vmData!.pendingCount ?? 0) - (data.pendingCount ?? 0))
    : null;

  // Aviso de pedidos YA en Dropi con valor distinto al de Shopify (cobro de más).
  // Independiente de la cola de pendientes; le ahorra al operador revisar a mano.
  // Excluye los CANCELADOS en Dropi (no se despachan → no hay cobro de más) y los
  // que la operadora ya marcó "Ya lo corregí". El filtro es client-side para que
  // haga efecto ya, sin esperar redeploy del edge (que aún los incluye).
  const mismatches = (vmData?.valueMismatches ?? []).filter(m => {
    if (/CANCEL/i.test(String(m.estado ?? ''))) return false;
    return !mismatchFixed.has(String(m.external_id || m.shopify_name || ''));
  });
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
            Dropi va a cobrar más de lo que el cliente aceptó. Cada pedido afectado muestra el aviso
            en su ficha con un botón «Corregir a $X» que lo arregla desde acá (sin ir al panel de Dropi).
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
                    <span className="text-muted-foreground">Shopify <span className="tabular-nums text-foreground">{formatCOP(m.shopify_total)}</span></span>
                    <span className="text-muted-foreground">· Dropi <span className="tabular-nums font-semibold text-destructive">{formatCOP(m.dropi_valor)}</span></span>
                    <span className="font-semibold text-destructive">(+{formatCOP(m.overcharge)} de más)</span>
                  </div>
                </div>
                <a href={m.admin_url} target="_blank" rel="noreferrer" title="Abrir en Shopify"
                  className="h-7 w-7 rounded-lg border border-border bg-card flex items-center justify-center text-muted-foreground hover:text-foreground flex-shrink-0">
                  <ExternalLink size={12} />
                </a>
                <button onClick={() => markMismatchFixed(String(m.external_id || m.shopify_name || ''))}
                  title="Ya ajusté el valor en Dropi — sacarlo de la lista"
                  className="h-7 px-2.5 rounded-lg border border-border bg-card text-xs font-medium text-muted-foreground hover:text-foreground flex items-center gap-1 flex-shrink-0">
                  <Check size={12} /> Ya lo corregí
                </button>
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  ) : null;

  // Banner anti-duplicados: avisa cuántos están bloqueados por teléfono repetido.
  const dupBanner = dupBlockedCount > 0 ? (
    <div className="mb-4 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 flex items-center gap-3">
      <div className="w-10 h-10 rounded-lg bg-destructive/20 flex items-center justify-center flex-shrink-0">
        <Ban size={18} className="text-destructive" aria-hidden="true" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-2xl font-extrabold tabular-nums text-destructive">{dupBlockedCount}</span>
          <span className="text-sm font-semibold text-foreground">posible(s) duplicado(s) — mismo teléfono ya en Dropi</span>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">
          Bloqueé el envío de esos para que no se dupliquen. En la lista: «Quitar del CRM» si ya está en Dropi, o «No es duplicado» si es una recompra real. Si creaste 2 en Dropi, borrá el sobrante a mano en el panel de Dropi (el CRM no puede cancelarlo).
        </p>
      </div>
      <button onClick={() => setExpanded(true)}
        className="h-8 px-3 rounded-lg border border-destructive/40 bg-card text-xs font-medium text-destructive flex items-center gap-1 flex-shrink-0 hover:bg-destructive/10">
        Revisar
      </button>
    </div>
  ) : null;

  // Banner "fuera de ventana": ventas de +7 días que siguen sin pasar a Dropi y
  // ya NO aparecen en la cola (la cola solo muestra la ventana de 7d). Es un aviso
  // — no duplica la data en la lista — para que el operador las revise a mano en
  // el admin de Shopify antes de que se pierda la confirmación por completo.
  // Mientras vmData no cargó (outOfWindowCount === null) mostramos "…".
  const outOfWindowBanner = (outOfWindowCount === null || outOfWindowCount > 0) ? (
    <div className="mb-4 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 flex items-center gap-3">
      <div className="w-10 h-10 rounded-lg bg-destructive/20 flex items-center justify-center flex-shrink-0">
        <AlertTriangle size={18} className="text-destructive" aria-hidden="true" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-2xl font-extrabold tabular-nums text-destructive">
            {outOfWindowCount === null ? '…' : outOfWindowCount}
          </span>
          <span className="text-sm font-semibold text-foreground">venta(s) de +{days} días sin pasar a Dropi</span>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">
          Están fuera de la ventana de la cola (últimos {days}d) — revisalas en el admin de Shopify antes de que se pierda la confirmación.
        </p>
      </div>
    </div>
  ) : null;

  return (
    <>
    {outOfWindowBanner}
    {mismatchBanner}
    {dupBanner}
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

      {/* Productos sin vincular detectados en el último bulk. Vinculá cada uno UNA
          vez (el mapeo es por producto/tienda) → desbloquea todos los pedidos con
          ese producto. Después "Reintentar faltantes" los sube. */}
      {unmappedProducts.length > 0 && (
        <div className="px-4 py-3 border-t border-warning/30 bg-warning/5 space-y-3">
          <div className="flex items-center gap-2">
            <Link2 size={14} className="text-warning flex-shrink-0" />
            <span className="text-xs font-semibold text-foreground flex-1">
              {unmappedProducts.length} producto(s) sin vincular a Dropi — vinculá una vez y desbloqueás todos sus pedidos
            </span>
            <button onClick={runBulk} disabled={bulkRunning}
              className="h-7 px-3 rounded-lg bg-primary text-primary-foreground text-xs font-medium flex items-center gap-1 hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0">
              {bulkRunning ? <Loader2 size={12} className="animate-spin" /> : <Truck size={12} />} Reintentar faltantes
            </button>
          </div>
          <div className="space-y-2">
            {unmappedProducts.map(u => (
              <div key={u.product_id} className="rounded-lg border border-border bg-card p-2.5 space-y-2">
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-foreground truncate flex-1">{u.title}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-warning/15 text-warning flex-shrink-0">{u.count} pedido(s)</span>
                </div>
                {activeStoreId && (
                  <DropiProductSearch storeId={activeStoreId} busy={linkingId === u.product_id}
                    onSelect={(dropiId, varId) => doLinkProduct(u.product_id, dropiId, varId)} />
                )}
                <details className="text-[11px]">
                  <summary className="cursor-pointer text-muted-foreground select-none">o pegá el id de Dropi manual</summary>
                  <div className="flex items-center gap-2 mt-1.5">
                    <input inputMode="numeric" placeholder="ID producto Dropi"
                      value={manualLink[u.product_id] ?? ''}
                      onChange={e => setManualLink(s => ({ ...s, [u.product_id]: e.target.value }))}
                      className="h-8 flex-1 min-w-0 rounded border border-border bg-background px-2 text-sm" />
                    <button type="button"
                      onClick={() => doLinkProduct(u.product_id, Number((manualLink[u.product_id] ?? '').trim()), null)}
                      disabled={linkingId === u.product_id || !(manualLink[u.product_id] ?? '').trim()}
                      className="h-8 px-3 rounded bg-secondary text-secondary-foreground text-xs font-medium flex items-center gap-1 hover:bg-secondary/80 disabled:opacity-50 disabled:cursor-not-allowed shrink-0">
                      {linkingId === u.product_id ? <Loader2 size={12} className="animate-spin" /> : <Link2 size={12} />} Vincular
                    </button>
                  </div>
                </details>
              </div>
            ))}
          </div>
        </div>
      )}

      <AnimatePresence>
        {expanded && count > 0 && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            className="border-t border-warning/30 max-h-[28rem] overflow-y-auto bg-card/50">
            {/* CAUSA RAÍZ: productos que más se fugan. Vincular ese producto una vez
                (Shopify→Dropi) corta la fuga; si no, se auto-suben a mano cada día. */}
            {topLeakProducts.length > 0 && (
              <div className="px-4 py-2.5 border-b border-border bg-warning/5">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold text-foreground mb-1.5">
                  <Link2 size={12} className="text-warning" aria-hidden="true" />
                  Productos que más se fugan — vinculá una vez para cortar la fuga de raíz
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {topLeakProducts.map((t) => (
                    <span key={t.producto}
                      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2 py-0.5 text-[11px]">
                      <span className="text-foreground truncate max-w-[16rem]">{t.producto}</span>
                      <span className="tabular-nums font-bold text-warning">{t.count}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
            {/* Buscador de la lista (no afecta el contador ni "Subir todos") */}
            <div className="sticky top-0 z-20 px-3 py-2 bg-card/95 backdrop-blur border-b border-border">
              <div className="relative">
                <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" aria-hidden="true" />
                <input
                  type="search"
                  value={pendingSearch}
                  onChange={(e) => setPendingSearch(e.target.value)}
                  placeholder="Buscar por nombre, teléfono, #pedido o ciudad…"
                  aria-label="Buscar en pendientes de Dropi"
                  className="h-8 w-full rounded-lg border border-border bg-background pl-7 pr-7 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
                {pendingSearch && (
                  <button type="button" onClick={() => setPendingSearch('')} aria-label="Limpiar búsqueda"
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                    <X size={12} aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>
            {groups.length === 0 && (
              <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                Sin resultados para "{pendingSearch}".
              </div>
            )}
            {groups.map(([date, items]) => (
              <div key={date}>
                <div className="sticky top-0 z-10 px-4 py-1.5 bg-card/95 backdrop-blur border-b border-border flex items-center gap-2 text-xs">
                  <span className="font-semibold text-foreground">{dayLabel(date, data.today)}</span>
                  <span className="text-muted-foreground">· {items.length} sin pasar</span>
                </div>
                <div className="divide-y divide-border">
                  {items.map(p => {
                    const dupHits = dupMatchesFor(p.phone, dupMap);
                    const overridden = dupOverrides.has(p.id);
                    const blocked = dupHits.length > 0 && !overridden;
                    return (
                    <div key={p.id}>
                      <div className={`px-4 py-2.5 flex items-center gap-3 text-sm ${blocked ? 'bg-destructive/5' : ''}`}>
                        <span className="text-[10px] font-mono text-muted-foreground w-10 flex-shrink-0">{localTime(p.created_at)}</span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-foreground truncate">{p.customer}</span>
                            <span className="text-[10px] font-mono text-muted-foreground">{p.name}</span>
                            {p.sin_telefono && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-destructive/15 text-destructive">sin teléfono</span>
                            )}
                            {dupHits.length > 0 && (
                              <span className={`text-[10px] px-1.5 py-0.5 rounded inline-flex items-center gap-1 ${blocked ? 'bg-destructive/15 text-destructive' : 'bg-muted text-muted-foreground'}`}>
                                <Ban size={9} /> {blocked ? 'duplicado' : 'no es duplicado'}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                            {p.phone
                              ? <button onClick={() => copyPhone(p.phone)} className="font-mono hover:text-foreground flex items-center gap-1">
                                  {p.phone} {copied === p.phone ? <Check size={11} className="text-success" /> : <Copy size={10} />}
                                </button>
                              : <span className="italic">—</span>}
                            {p.city && <span>· {p.city}</span>}
                            {p.total > 0 && <span>· {formatCOP(p.total)}</span>}
                            {p.producto && <span className="truncate max-w-[12rem]" title={p.producto}>· {p.producto}</span>}
                          </div>
                        </div>
                        <a href={p.admin_url} target="_blank" rel="noreferrer" title="Abrir en Shopify"
                          className="h-7 w-7 rounded-lg border border-border bg-card flex items-center justify-center text-muted-foreground hover:text-foreground flex-shrink-0">
                          <ExternalLink size={12} />
                        </a>
                        <button onClick={() => setPushItem(p)} disabled={blocked}
                          title={blocked ? 'Bloqueado: ya hay un pedido en Dropi con este teléfono' : 'Subir este pedido a Dropi'}
                          className="h-7 px-2.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 flex items-center gap-1 flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed">
                          <Truck size={12} /> Subir a Dropi
                        </button>
                        <button onClick={() => handleYaLoMeti(p)} disabled={lockMarks || blocked}
                          title={blocked ? 'Bloqueado: posible duplicado' : 'Ya lo cargué manualmente'}
                          className="h-7 px-2.5 rounded-lg border border-border bg-card text-xs font-medium text-muted-foreground hover:text-foreground flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed">
                          Ya lo metí
                        </button>
                      </div>

                      {dupHits.length > 0 && (
                        <div className="ml-4 px-4 pb-2.5 pt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs border-l-2 border-destructive/40 bg-destructive/5">
                          <span className="text-muted-foreground">
                            Ya en Dropi:{' '}
                            <span className="text-foreground font-medium">
                              {dupHits.slice(0, 2).map(h => `#${h.external_id} · ${h.estado || '—'}${h.fecha ? ` · ${h.fecha}` : ''}`).join('   |   ')}
                              {dupHits.length > 2 ? `  (+${dupHits.length - 2})` : ''}
                            </span>
                          </span>
                          {blocked && (
                            <span className="flex items-center gap-2 ml-auto">
                              <button onClick={() => markNotDuplicate(p)}
                                title="Es una recompra real — enviar igual (queda registrado)"
                                className="h-7 px-2.5 rounded-lg border border-border bg-card text-xs font-medium text-foreground hover:bg-muted/40 flex items-center gap-1">
                                <ShieldCheck size={12} /> No es duplicado
                              </button>
                              <button onClick={() => quitarDelCrm(p.id)}
                                title="Ya está en Dropi — sacarlo de esta cola"
                                className="h-7 px-2.5 rounded-lg border border-destructive/40 bg-card text-xs font-medium text-destructive hover:bg-destructive/10 flex items-center gap-1">
                                Quitar del CRM
                              </button>
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    );
                  })}
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

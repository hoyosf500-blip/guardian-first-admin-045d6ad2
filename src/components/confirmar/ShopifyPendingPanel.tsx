import { useEffect, useMemo, useState, useCallback } from 'react';
import { useStore } from '@/contexts/StoreContext';
import { useAuth } from '@/contexts/AuthContext';
import { useShopifyPending, useShopifyValueMismatches, type ShopifyPendingItem } from '@/hooks/useShopifyPending';
import { usePushToDropi } from '@/hooks/usePushToDropi';
import DropiProductSearch from '@/components/DropiProductSearch';
import { useShopifyManualMarks } from '@/hooks/useShopifyManualMarks';
import { useShopifyPushAttempts } from '@/hooks/useShopifyPushAttempts';
import { useDuplicatePhones } from '@/hooks/useDuplicatePhones';
import { useAutoPushHealth } from '@/hooks/useAutoPushHealth';
import { dupMatchesFor, isBlockedByDuplicate, repetidosEnElLote, uniquePhones } from '@/lib/duplicatePhones';
import { matchesQuery } from '@/lib/textSearch';
import { supabase } from '@/integrations/supabase/client';
import { bogotaToday, formatCOP } from '@/lib/utils';
import PushToDropiModal from './PushToDropiModal';
import ShopifyMarksHistoryModal from './ShopifyMarksHistoryModal';
import CuadreDelDia from './CuadreDelDia';
import { pollWhenVisible } from '@/lib/pollWhenVisible';
import { ShoppingBag, RefreshCw, Copy, Check, ExternalLink, ChevronDown, ChevronUp, AlertTriangle, CheckCircle2, Truck, Loader2, History, Ban, ShieldCheck, Search, X, Link2, ClipboardCheck } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';

const DONE_KEY = (storeId: string) => `guardian.shopifyDone:${storeId}`;
const DUP_OVERRIDE_KEY = (storeId: string) => `guardian.dupOverride:${storeId}`;
const MISMATCH_FIXED_KEY = (storeId: string) => `guardian.mismatchFixed:${storeId}`;
const EXPANDED_KEY = (storeId: string) => `guardian.shopifyPendingAbierto:${storeId}`;
const CUADRE_KEY = (storeId: string) => `guardian.shopifyCuadreAbierto:${storeId}`;

/** El cuadre del día nace cerrado (son todas las ventas del día, no solo lo que
 *  falta) pero SE RECUERDA: al que lo usa para revisar no se le cierra solo en
 *  cada recarga. */
function loadCuadre(storeId: string): boolean {
  try { return localStorage.getItem(CUADRE_KEY(storeId)) === '1'; } catch { return false; }
}
function saveCuadre(storeId: string, open: boolean) {
  try { localStorage.setItem(CUADRE_KEY(storeId), open ? '1' : '0'); } catch { /* noop */ }
}

// La lista de pendientes arranca ABIERTA (2026-09-02). Antes `expanded` nacía en
// false y no se recordaba: cada recarga escondía los pedidos sin pasar a Dropi
// detrás de un botón, justo lo que hay que tener a la vista. Si el usuario la
// cierra a mano se respeta, por tienda, hasta que la vuelva a abrir.
function loadExpanded(storeId: string): boolean {
  try {
    const v = localStorage.getItem(EXPANDED_KEY(storeId));
    return v === null ? true : v === '1';
  } catch { return true; }
}

function saveExpanded(storeId: string, open: boolean) {
  try { localStorage.setItem(EXPANDED_KEY(storeId), open ? '1' : '0'); } catch { /* noop */ }
}
const BOGOTA = 'America/Bogota'; // UTC-5 — sirve para Colombia y Ecuador

/** Lee un set persistido por tienda de localStorage + la clave legacy de
 *  sessionStorage (así un deploy no borra lo marcado en la sesión en curso). */
function loadPersistedSet(key: string): Set<string> {
  const read = (store: Storage): string[] => {
    try { return JSON.parse(store.getItem(key) || '[]'); }
    catch { return []; }
  };
  return new Set([...read(localStorage), ...read(sessionStorage)]);
}

// `done` (incluye "Quitar del CRM" y "Ya lo metí") vive en localStorage, igual
// que los overrides de duplicado y por la MISMA razón: un pedido cuyo teléfono
// no matchea en el reconcile nunca reconcilia, así que en sessionStorage
// amanecía otra vez en rojo cada mañana. La asesora repetía el triage hasta
// que, apurada, dejaba una marca falsa en shopify_manual_marks o creaba un
// pedido doble real. La limpieza de abajo (ids que ya no están pendientes)
// mantiene el set acotado.
function loadDone(storeId: string): Set<string> {
  return loadPersistedSet(DONE_KEY(storeId));
}

function saveDone(storeId: string, ids: Set<string>) {
  try { localStorage.setItem(DONE_KEY(storeId), JSON.stringify([...ids])); } catch { /* noop */ }
}

// "No es duplicado" vive en localStorage (antes sessionStorage): si se
// evaporaba al cerrar la pestaña, el mismo pedido amanecía BLOQUEADO otra vez
// y la operadora sentía que "no deja subir".
function loadOverrides(storeId: string): Set<string> {
  return loadPersistedSet(DUP_OVERRIDE_KEY(storeId));
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
  // Salud del robot que sube solo. Sin esto, un robot trabado se ve igual que
  // uno sano: la cola llena y cero explicación.
  const { data: robot } = useAutoPushHealth(activeStoreId);
  // `vmData` alimenta el aviso de "valor distinto", que NO se dibuja acá desde el
  // 19-jul (ver la nota del return). Se conserva el hook porque React Query lo
  // dedupea con la instancia de ConfirmarTab que SÍ usan los chips «DE MÁS»: no
  // cuesta una sola petición extra.
  const { data: vmData } = useShopifyValueMismatches(activeStoreId);
  const { confirm: confirmPush, linkProduct } = usePushToDropi(activeStoreId);
  // `marks` son las marcas "Ya lo metí" GUARDADAS EN LA BASE (de cualquier
  // asesora, desde cualquier equipo). Antes solo se escribían acá y nunca se
  // leían de vuelta: el `done` de abajo vive en localStorage, así que la asesora
  // marcaba, el pedido desaparecía de SU pantalla y en la del dueño seguía en
  // rojo. El 1-sep-2026 eso terminó en un regaño injusto a un asesor de Ecuador.
  const { markEntered, marks, refetch: refetchMarks } = useShopifyManualMarks(activeStoreId);
  // Ids marcados "Ya lo metí" por CUALQUIERA, según la base. Se unen al `done`
  // local para decidir qué se esconde. Va acá arriba a propósito: `handleYaLoMeti`
  // lo necesita en sus dependencias y con el `const` más abajo quedaría en TDZ.
  const markedIds = useMemo(() => new Set(marks.map(m => m.shopify_order_id)), [marks]);
  const { user } = useAuth();
  const [expanded, setExpanded] = useState<boolean>(() => activeStoreId ? loadExpanded(activeStoreId) : true);
  const [showMismatches, setShowMismatches] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [done, setDone] = useState<Set<string>>(() => activeStoreId ? loadDone(activeStoreId) : new Set());
  // "No es duplicado" por id de pedido (escape para recompra legítima).
  const [dupOverrides, setDupOverrides] = useState<Set<string>>(() => activeStoreId ? loadOverrides(activeStoreId) : new Set());
  // "Ya lo corregí" en valor-distinto: ids que la operadora ya resolvió a mano.
  const [mismatchFixed, setMismatchFixed] = useState<Set<string>>(() => activeStoreId ? loadMismatchFixed(activeStoreId) : new Set());
  // Cuadre del día: la lista COMPLETA de ventas de Shopify del día con su
  // estado (en Dropi / sin pasar). Es la única forma de COMPROBAR el cuadre:
  // los números solos ya se leyeron mal una vez ("9 vs 10", 2-sep-2026).
  const [showCuadre, setShowCuadre] = useState<boolean>(() => activeStoreId ? loadCuadre(activeStoreId) : false);
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
  // Errores del ÚLTIMO bulk de ESTA sesión, por id de pedido — feedback inmediato
  // en la fila sin esperar el refetch de shopify_pushed_orders (y cubre fallos
  // que el edge no persiste, ej. bloqueo server-side previo al claim).
  const [lastBulkErrors, setLastBulkErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    setDone(activeStoreId ? loadDone(activeStoreId) : new Set());
    setDupOverrides(activeStoreId ? loadOverrides(activeStoreId) : new Set());
    setMismatchFixed(activeStoreId ? loadMismatchFixed(activeStoreId) : new Set());
    setExpanded(activeStoreId ? loadExpanded(activeStoreId) : true);
    setShowCuadre(activeStoreId ? loadCuadre(activeStoreId) : false);
    setLastBulkErrors({});
  }, [activeStoreId]);

  useEffect(() => {
    if (!activeStoreId) return;
    // 2026-09-02: estaba en 15 min y con `runOnVisible: false`. El dueño reportó
    // que los pedidos nuevos "no salían" y tenía que apretar Actualizar a mano —
    // y tenía razón: un pedido podía tardar 15 min en aparecer, y al volver de
    // otra pestaña NO se refrescaba nunca (el interval arrancaba de cero sin
    // disparar). En una operación COD eso es una venta esperando.
    //
    // Vuelve a 3 min y CON `runOnVisible: true`. El ahorro de COST-2 no se
    // pierde: lo que costaba plata eran las pestañas en segundo plano, y de eso
    // ya se encarga `pollWhenVisible`, que PARA el interval cuando la pestaña se
    // oculta. Acá solo se refresca la pestaña que alguien está mirando.
    const tick = () => { void refetch(); void refetchMarks(); };
    return pollWhenVisible(tick, 3 * 60_000, { runOnVisible: true });
  }, [activeStoreId, refetch, refetchMarks]);


  const pending: ShopifyPendingItem[] = useMemo(() => data?.pending ?? [], [data]);

  // Anti-duplicados: teléfonos de los pendientes → pedidos Dropi NO cancelados
  // que YA existen con ese mismo teléfono (regla "teléfono repetido siempre").
  const pendingPhones = useMemo(() => uniquePhones(pending), [pending]);
  const { dupMap } = useDuplicatePhones(activeStoreId, pendingPhones);

  // Intentos previos de push por pedido (shopify_pushed_orders): cada fila
  // muestra SU razón de no-pasar (falló con motivo / quedó a medias / ya se
  // subió pero el teléfono no matcheó). Complementa el guard anti-dup.
  const pendingIdsForAttempts = useMemo(() => pending.map(p => p.id), [pending]);
  const { attempts, refetch: refetchAttempts } = useShopifyPushAttempts(activeStoreId, pendingIdsForAttempts);

  // Limpieza del set local: si un pedido ya NO está pendiente (entró a Dropi),
  // lo sacamos del set para no inflar el "ya metidos".
  useEffect(() => {
    if (!activeStoreId || !data) return;
    // Un reconcile fallido devuelve la lista vacía: podar con eso borraría TODO
    // el triage guardado (ahora persistente) por un blip de red.
    if (!data.ok) return;
    const pendingIds = new Set(pending.map(p => p.id));
    setDone(prev => {
      const next = new Set([...prev].filter(id => pendingIds.has(id)));
      // Idempotente: si no se removió nada, devolver `prev` para no crear un
      // Set nuevo en cada `data` (evita un re-render extra del panel).
      if (next.size === prev.size) return prev;
      saveDone(activeStoreId, next);
      return next;
    });
  }, [data, pending, activeStoreId]);

  const markDone = useCallback((id: string) => {
    if (!activeStoreId) return;
    setDone(prev => {
      const next = new Set(prev).add(id);
      saveDone(activeStoreId, next);
      return next;
    });
  }, [activeStoreId]);

  // "Ya lo metí": esconde local (snappy) + PERSISTE la marca (auditable + revertible).
  // Guard anti-doble-click: ignora si ya está marcado o si hay un bloqueo activo.
  const handleYaLoMeti = useCallback(async (p: ShopifyPendingItem) => {
    if (!activeStoreId || lockMarks || done.has(p.id) || markedIds.has(p.id)) return;
    if (isBlockedByDuplicate(p, dupMap, dupOverrides)) return;  // bloqueo anti-duplicado
    setLockMarks(true);
    markDone(p.id);
    const r = await markEntered({ id: p.id, name: p.name, customer: p.customer, phone: p.phone, total: p.total, city: p.city });
    if (!r.ok) toast.error('No se pudo guardar la marca: ' + (r.error || ''));
    setTimeout(() => setLockMarks(false), 600);
  }, [activeStoreId, lockMarks, done, markedIds, dupMap, dupOverrides, markDone, markEntered]);

  // Revertir desde el historial: saca el pedido del `done` local y refetchea →
  // vuelve a aparecer en la cola de pendientes para meterlo bien.
  const handleReverted = useCallback((orderId: string) => {
    if (!activeStoreId) return;
    setDone(prev => {
      if (!prev.has(orderId)) return prev;
      const next = new Set(prev); next.delete(orderId);
      // También limpia la clave legacy: si el id quedó ahí, al recargar volvería.
      saveDone(activeStoreId, next);
      try { sessionStorage.removeItem(DONE_KEY(activeStoreId)); } catch { /* noop */ }
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
      try { localStorage.setItem(DUP_OVERRIDE_KEY(activeStoreId), JSON.stringify([...next])); } catch { /* noop */ }
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

  // "Quitar del CRM": el pedido YA está en Dropi → sale de la cola (NO crea nada;
  // el sobrante en Dropi se borra a mano).
  //
  // 2026-09-02: antes solo escondía en localStorage, así que la asesora lo sacaba
  // de SU cola y en la del dueño seguía ahí. Ahora se guarda como marca en
  // `shopify_manual_marks`, igual que "Ya lo metí": el equipo entero ve la misma
  // lista y queda con autor, hora y botón de revertir en el Historial.
  const quitarDelCrm = useCallback(async (p: ShopifyPendingItem) => {
    if (!activeStoreId || done.has(p.id) || markedIds.has(p.id)) return;
    markDone(p.id);
    const r = await markEntered({ id: p.id, name: p.name, customer: p.customer, phone: p.phone, total: p.total, city: p.city });
    if (!r.ok) toast.error('No se pudo compartir con el equipo: ' + (r.error || ''));
  }, [activeStoreId, done, markedIds, markDone, markEntered]);

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

  const visible = useMemo(
    () => pending.filter(p => !done.has(p.id) && !markedIds.has(p.id)),
    [pending, done, markedIds],
  );
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
    // ⛔ Y TAMPOCO EL LOTE CONTRA SÍ MISMO (3-sep-2026). `isBlockedByDuplicate`
    // compara contra lo que YA está en Dropi; dos ventas de Shopify distintas
    // con el MISMO teléfono no estaban ninguna, así que las dos pasaban el
    // filtro y este bucle las subía con segundos de diferencia: dos órdenes
    // reales, dos guías con números consecutivos, doble flete. Es el duplicado
    // que reportaron en Colombia 2 — tienda con el robot APAGADO, o sea que
    // salió de este botón. Se sube el primero de cada teléfono; el resto queda
    // en la lista con su motivo. Ver `repetidosEnElLote`.
    const repetidos = repetidosEnElLote(visible, dupOverrides);
    const skipped = visible.filter(p => isBlockedByDuplicate(p, dupMap, dupOverrides) || repetidos.has(p.id));
    const targets = visible.filter(p => !isBlockedByDuplicate(p, dupMap, dupOverrides) && !repetidos.has(p.id));

    // Camino "el botón no hace nada": si TODOS los visibles están bloqueados
    // por duplicado, no hay nada que invocar (el guard es correcto) — pero hay
    // que DECIRLO claro y llevar a la operadora a la lista para resolver fila
    // por fila. Antes: un solo toast de "omitidos" y cero acción → parecía roto.
    if (targets.length === 0) {
      setBulkRunning(false);
      setExpanded(true);
      toast.warning(
        `Subidos 0 · Bloqueados por duplicado ${skipped.length} · Con error 0`,
        {
          description: 'Todos los pendientes tienen un pedido en Dropi con el mismo teléfono. Revisalos abajo: «No es duplicado» (recompra real) o «Quitar del CRM» (ya está en Dropi).',
          duration: 12000,
        },
      );
      return;
    }

    let okCount = 0; const fails: Array<{ name: string; error: string }> = [];
    const newErrors: Record<string, string> = {};
    // Recolecta los productos sin vínculo que hicieron fallar pedidos: se muestran
    // abajo para vincularlos UNA vez (el mapeo es por producto/tienda → desbloquea
    // todos los pedidos con ese producto). Clave = shopify product_id.
    const unmap = new Map<number, { product_id: number; title: string; count: number }>();
    try {
      for (const p of targets) {
        // allow_duplicate solo si la operadora marcó "No es duplicado" en ESE pedido
        // (los otros duplicados ya se excluyeron arriba). El guard server-side revalida.
        const r = await confirmPush(p.id, undefined, dupOverrides.has(p.id));
        if (r.ok) { okCount++; markDone(p.id); }
        else {
          // El servidor explica CUÁL es el duplicado y por qué todavía no se ve
          // en el CRM (el «gemelo invisible»: Dropi tarda en devolver la orden
          // recién creada). Pisar eso con una frase genérica le quitaba a la
          // asesora justo el dato con el que puede decidir.
          const msg = r.blocked === 'duplicate_phone'
            ? (r.error || 'bloqueado por duplicado (teléfono ya en Dropi)')
            : (r.error || 'error');
          fails.push({ name: p.name, error: msg });
          newErrors[p.id] = msg;
          for (const u of (r.unmapped ?? [])) {
            if (typeof u.product_id !== 'number' || u.product_id <= 0) continue;
            const e = unmap.get(u.product_id) || { product_id: u.product_id, title: u.title || `Producto ${u.product_id}`, count: 0 };
            e.count++; unmap.set(u.product_id, e);
          }
        }
        await new Promise(res => setTimeout(res, 400)); // pacing suave
      }
    } finally {
      // Pase lo que pase, soltar el botón: sin esto, una excepción dejaba
      // "Subir todos" deshabilitado para siempre (otro camino de "no deja").
      setBulkRunning(false);
    }
    setLastBulkErrors(prev => ({ ...prev, ...newErrors }));
    setUnmappedProducts([...unmap.values()].sort((a, b) => b.count - a.count));

    // UN resumen claro (en vez de 2-3 toasts sueltos): qué subió, qué quedó
    // bloqueado por duplicado y qué falló (con el motivo más común).
    const topReason = (() => {
      if (fails.length === 0) return '';
      const counts = new Map<string, number>();
      for (const f of fails) {
        const k = f.error.slice(0, 120);
        counts.set(k, (counts.get(k) || 0) + 1);
      }
      return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    })();
    const summary = `Subidos ${okCount} · Bloqueados por duplicado ${skipped.length} · Con error ${fails.length}`;
    const descParts: string[] = [];
    if (skipped.length > 0) descParts.push('Duplicados: revisalos abajo en la lista.');
    if (topReason) descParts.push(`Motivo más común: ${topReason}`);
    if (unmap.size > 0) descParts.push(`${unmap.size} producto(s) sin vincular — vinculalos abajo y tocá «Reintentar faltantes».`);
    const description = descParts.join(' ') || undefined;
    if (fails.length === 0 && skipped.length === 0) toast.success(summary, { description });
    else if (okCount > 0) toast.warning(summary, { description, duration: 12000 });
    else toast.error(summary, { description, duration: 12000 });
    // Si quedó algo por resolver, abrir la lista: ahí cada fila muestra su razón.
    if (fails.length > 0 || skipped.length > 0) setExpanded(true);
    void refetch();
    void refetchAttempts();
  }, [activeStoreId, bulkRunning, visible, dupMap, dupOverrides, confirmPush, markDone, refetch, refetchAttempts]);

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
      <div className="mb-4 rounded-2xl border border-destructive/40 bg-destructive/10 shadow-card3d px-4 py-2.5 text-sm text-destructive flex items-center gap-2">
        <AlertTriangle size={15} />
        <span>No se pudo revisar Shopify: {data.error || 'error'}</span>
        <button onClick={() => refetch()} className="ml-auto text-destructive/80 hover:text-destructive" title="Reintentar">
          <RefreshCw size={13} className={isFetching ? 'animate-spin' : ''} />
        </button>
      </div>
    );
  }

  // ⛔ 2026-09-02 — LA TIRA DE RECONCILIACIÓN ES DATO DEL SERVIDOR, NO UNA RESTA.
  //
  // Antes decía `periodMatched = periodShopify - count` y
  // `todayMatched = todayShopify - todayPendingVisible`, donde `count` sale de
  // `visible`, que está filtrado por el `done` de ESTE navegador. O sea: el
  // número "en Dropi" no lo medía nadie — era una resta de lo que cada quien
  // tenía escondido en su localStorage. La asesora con 16 pedidos marcados veía
  // "420 en Dropi · 5 sin pasar" y el dueño, en la misma tienda y al mismo
  // segundo, "403 en Dropi · 21 sin pasar". El dueño regañó por esa diferencia.
  //
  // `shopify-reconcile` YA devuelve los conteos reales (`matchedCount`,
  // `pendingCount`, `todayMatched`, `todayPending`). Se usan esos. La tira es
  // idéntica para todos; lo único personal es el titular (lo que a esa persona
  // le queda por hacer), y si difiere se explica abajo con `yaResueltos`.
  const count = visible.length;
  const allClear = count === 0;
  const days = data.days ?? 3;
  const periodShopify = data.shopifyTotal ?? 0;
  const periodPending = data.pendingCount ?? count;
  const periodMatched = data.matchedCount ?? Math.max(0, periodShopify - periodPending);
  const todayShopify = data.todayShopify ?? 0;
  const todayPending = data.todayPending ?? 0;
  const todayMatched = data.todayMatched ?? Math.max(0, todayShopify - todayPending);
  // Cuántos de los pendientes del servidor ya los resolvió alguien del equipo
  // (marca compartida en `shopify_manual_marks`). Sin esto, el titular y la tira
  // se contradicen y nadie sabe cuál creer.
  const yaResueltos = Math.max(0, periodPending - count);
  const cancelled = data.cancelledCount ?? 0;

  const accent = allClear ? 'success' : 'warning';


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
    <div className="mb-4 rounded-2xl border border-destructive/40 bg-destructive/10 shadow-card3d overflow-hidden">
      <div className="px-4 py-3 flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-destructive/30 to-destructive/12 border border-destructive/30 glow-danger flex items-center justify-center flex-shrink-0">
          <AlertTriangle size={18} className="text-destructive" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-extrabold font-mono tabular-nums leading-none text-destructive num-glow-danger">{mismatches.length}</span>
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
    <div className="mb-4 rounded-2xl border border-destructive/40 bg-destructive/10 shadow-card3d px-4 py-3 flex items-center gap-3">
      <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-destructive/30 to-destructive/12 border border-destructive/30 glow-danger flex items-center justify-center flex-shrink-0">
        <Ban size={18} className="text-destructive" aria-hidden="true" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-3xl font-extrabold font-mono tabular-nums leading-none text-destructive num-glow-danger">{dupBlockedCount}</span>
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

  return (
    <>
    {/* `mismatchBanner` YA NO SE RENDERIZA acá (pedido del dueño, 2026-07-19):
        "en vez que aparezcan esas alertas de los pedidos que están en un valor
        diferente, que aparezca cuando el asesor lo toque o que en el mismo
        cliente se señale".
        Y ya está señalado en los dos lugares donde importa, ambos con datos que
        NO salen de este panel (vienen de ConfirmarTab, así que quitar el banner
        no los rompe):
          · WorkList.tsx:168 — chip «DE MÁS» en la fila del cliente, en la cola.
          · CallView.tsx:960 — aviso en la ficha, con botón «Corregir a $X» que
            lo arregla de verdad; el banner solo informaba.
        Un tercer aviso arriba de la cola era ruido que empujaba el trabajo real
        hacia abajo. La definición se conserva por si se quiere en una vista de
        dueño; no está borrada, está desconectada. */}
    {dupBanner}
    {/* EL ROBOT SE TRABÓ. Va arriba de todo y en rojo porque no es un pendiente
        más: son pedidos que el robot YA intentó subir y no pudo, así que la
        cola no se va a vaciar sola por más que espere.
        Medido el 2026-08-13: 386 corridas bloqueadas seguidas desde el 6-ago —
        8 días — y el motivo vivía solo en sync_logs, que ninguna pantalla abría. */}
    {/* Robot MUDO: hace más de 3 ciclos que no reporta, teniéndolo encendido.
        Va ANTES del de bloqueados porque es peor: un robot que reporta pedidos
        trabados por lo menos se ve. Uno que murió a mitad de corrida no escribe
        nada, y hasta hoy esa ausencia se leía como "todo bien" (misma forma que
        el nightly que starvaba tiendas y que el wallet que fallaba en verde). */}
    {robot?.mudo && (
      <div
        role="alert"
        className="mb-3 flex flex-wrap items-start gap-3 rounded-2xl border border-warning/40 bg-warning/10 px-4 pl-5 py-3 shadow-card3d relative"
      >
        <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-warning" aria-hidden="true" />
        <span className="w-9 h-9 rounded-xl bg-warning/15 border border-warning/30 text-warning flex items-center justify-center flex-shrink-0" aria-hidden="true">
          <Ban size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-warning">
            El robot de Shopify no está reportando
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Debería dejar señal cada 15 minutos y no lo hace hace rato. No quiere decir
            que se hayan perdido pedidos, pero sí que nadie los está subiendo solo:
            revisá la cola de acá abajo a mano hasta que vuelva.
          </p>
          <p className="text-[11px] text-muted-foreground mt-1">
            {robot.cuando
              ? `Última señal: ${robot.cuando.toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' })}`
              : 'Sin ninguna señal registrada.'}
          </p>
        </div>
      </div>
    )}

    {robot?.bloqueado && (
      <div
        role="alert"
        className="mb-3 flex flex-wrap items-start gap-3 rounded-2xl border border-danger/40 bg-danger/10 px-4 pl-5 py-3 shadow-card3d relative"
      >
        <span className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-danger" aria-hidden="true" />
        <span className="w-9 h-9 rounded-xl bg-danger/15 border border-danger/30 text-danger flex items-center justify-center flex-shrink-0" aria-hidden="true">
          <Ban size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-danger">
            El robot no pudo subir {robot.cuantos} {robot.cuantos === 1 ? 'pedido' : 'pedidos'} a Dropi
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Reintenta cada 15 minutos y le vuelve a pasar lo mismo: estos no se van a
            subir solos. Hay que subirlos a mano acá abajo, o resolver el motivo.
          </p>
          {robot.motivos.length > 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {robot.motivos.map((m, i) => (
                <li key={i} className="text-xs text-danger/90 leading-snug">· {m}</li>
              ))}
            </ul>
          )}
          {robot.cuando && (
            <p className="text-[11px] text-muted-foreground mt-1">
              Último intento: {robot.cuando.toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' })}
            </p>
          )}
        </div>
      </div>
    )}
    {/* No `initial` animation: el panel se re-monta cada refetch (cuando
        `data` flipa momentáneamente, o cuando el guard `!data || configured`
        cambia), y `motion.div initial=opacity:0,y:8` re-disparaba la animación
        de entrada → la pila visual de arriba "parpadeaba" cada poll. */}
    <div
      className={`relative mb-4 rounded-2xl border shadow-card3d hairline-top overflow-hidden ${allClear ? 'border-success/40 bg-success/10' : 'border-warning/40 bg-warning/10'}`}>
      {/* Barra lateral del tono (fórmula de banner del DS): el estado se lee
          por el borde izquierdo antes de leer la cifra. */}
      <span className={`absolute left-0 top-3 bottom-3 w-1 rounded-full z-10 ${allClear ? 'bg-success' : 'bg-warning'}`} aria-hidden="true" />
      {/* Layout 2-rows en mobile, 1-row en sm+:
            - Row 1 (siempre): icono · texto principal · Actualizar (refresh).
            - Row 2: botones de acción (Subir todos / Ver lista). En mobile son
              full-width; en sm+ se acomodan a la derecha en la misma fila.
            En mobile el texto principal NO compite con 2 botones por espacio,
            así que "N sin pasar a Dropi" ya no se apila letra por palabra. */}
      <div className="px-4 pl-5 py-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className={`w-10 h-10 rounded-xl border flex items-center justify-center flex-shrink-0 ${allClear ? 'bg-gradient-to-br from-success/30 to-success/12 border-success/30 glow-success' : 'bg-gradient-to-br from-warning/30 to-warning/12 border-warning/30 glow-warning'}`}>
          {allClear ? <CheckCircle2 size={18} className="text-success" aria-hidden="true" /> : <ShoppingBag size={18} className="text-warning" aria-hidden="true" />}
        </div>
        <div className="flex-1 min-w-0 basis-[14rem]">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className={`text-3xl font-extrabold font-mono tabular-nums leading-none ${allClear ? 'text-success num-glow-success' : 'text-foreground'}`}>{count}</span>
            <span className="text-sm font-semibold text-foreground">
              {allClear ? 'sin pasar a Dropi — todo al día ✓' : 'sin pasar a Dropi'}
            </span>
          </div>
          {/* Tira de reconciliación: hoy y período, UNA LÍNEA CADA UNO.
              ⛔ 2026-09-02: iban en la misma línea separados por "|", y en
              pantalla ancha eso se lee como una sola frase. El dueño leyó el
              "10 en Shopify" de HOY contra el "9 ya en Dropi" de los 7 DÍAS y
              reportó un pedido perdido que no existía. Dos ventanas de tiempo
              distintas nunca van en el mismo renglón. */}
          <div className="mt-1 flex flex-col gap-y-0.5 text-xs text-muted-foreground">
            <span>
              <span className="font-medium text-foreground">Hoy:</span> {todayShopify} en Shopify · {todayMatched} ya en Dropi ·{' '}
              <span className={todayPending > 0 ? 'font-semibold text-warning' : ''}>{todayPending} sin pasar</span>
            </span>
            <span>
              <span className="font-medium text-foreground">Últimos {days} días:</span> {periodShopify} en Shopify · {periodMatched} ya en Dropi ·{' '}
              <span className={periodPending > 0 ? 'font-semibold text-warning' : ''}>{periodPending} sin pasar</span>
              {cancelled > 0 && <span className="opacity-70"> · {cancelled} cancelados</span>}
              {yaResueltos > 0 && <span className="opacity-70"> · {yaResueltos} ya los marcó el equipo</span>}
            </span>
          </div>
        </div>
        <button onClick={() => setShowCuadre(v => { const n = !v; if (activeStoreId) saveCuadre(activeStoreId, n); return n; })} aria-label="Ver el cuadre del día pedido por pedido"
          aria-expanded={showCuadre}
          title="Cuadre del día — cada venta de Shopify con su estado"
          className={`h-9 px-2.5 rounded-lg border flex items-center justify-center gap-1.5 flex-shrink-0 text-xs font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${showCuadre ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border bg-card text-muted-foreground hover:text-foreground'}`}>
          <ClipboardCheck size={14} aria-hidden="true" /> <span className="hidden sm:inline">Cuadre del día</span>
        </button>
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
            <button onClick={() => setExpanded(e => { const n = !e; if (activeStoreId) saveExpanded(activeStoreId, n); return n; })}
              aria-label={expanded ? 'Ocultar lista de pendientes' : 'Ver lista de pendientes'}
              aria-expanded={expanded}
              className="h-9 px-3 rounded-lg border border-border bg-card text-xs font-semibold text-foreground inline-flex items-center justify-center gap-1.5 hover:border-border-strong cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none flex-1 sm:flex-none">
              {expanded ? 'Ocultar' : 'Ver lista'}
              {expanded ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
            </button>
          </div>
        )}
      </div>

      {/* Cuadre del día: TODAS las ventas del día, una por una, con su estado.
          Se dibuja con `pending` del SERVIDOR (no `visible`): esta pantalla es
          para comprobar, y lo que alguien escondió en su navegador no puede
          cambiar el cuadre. */}
      {showCuadre && (
        <CuadreDelDia
          dia={data.today ?? bogotaToday()}
          shopifyDelDia={todayShopify}
          matched={data.matched}
          pending={pending}
          duplicates={data.duplicates}
          timeZone={BOGOTA}
          onClose={() => { setShowCuadre(false); if (activeStoreId) saveCuadre(activeStoreId, false); }}
        />
      )}

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
              <div key={u.product_id} className="rounded-2xl border border-border bg-card p-2.5 space-y-2 shadow-card3d hairline-top">
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
                    // Razón de no-pasar de ESTA fila: error del último bulk de la
                    // sesión (más fresco) o el último intento persistido en
                    // shopify_pushed_orders (sobrevive refresh/sesión).
                    const att = attempts.get(p.id);
                    const prevErr = lastBulkErrors[p.id]
                      || (att?.status === 'error' ? (att.error_message || 'falló el intento anterior') : '');
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
                            {/* Razón de no-pasar (cuando NO es el bloqueo por duplicado,
                                que ya tiene su badge + strip "Ya en Dropi" abajo). */}
                            {!blocked && prevErr && (
                              <span title={prevErr}
                                className="text-[10px] px-1.5 py-0.5 rounded bg-warning/15 text-warning inline-flex items-center gap-1 max-w-[18rem] min-w-0">
                                <AlertTriangle size={9} className="flex-shrink-0" aria-hidden="true" />
                                <span className="truncate">falló: {prevErr}</span>
                              </span>
                            )}
                            {!blocked && !prevErr && att?.status === 'created' && (
                              <span title="Un intento anterior YA creó la orden en Dropi, pero el cruce por teléfono no la encontró — verificá en Dropi antes de re-subir (re-subir crearía un doble)."
                                className="text-[10px] px-1.5 py-0.5 rounded bg-warning/15 text-warning">
                                ya se subió{att.dropi_order_id ? ` (Dropi #${att.dropi_order_id})` : ''} — verificá
                              </span>
                            )}
                            {!blocked && !prevErr && att?.status === 'pending' && (
                              <span title="Un intento anterior quedó a medias (sin confirmación de Dropi) — verificá en el panel de Dropi antes de reintentar."
                                className="text-[10px] px-1.5 py-0.5 rounded bg-warning/15 text-warning">
                                intento a medias — verificá
                              </span>
                            )}
                            {!blocked && !prevErr && !att && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-success/15 text-success">listo para subir</span>
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
                              <button onClick={() => { void quitarDelCrm(p); }}
                                title="Ya está en Dropi — sacarlo de esta cola (lo ve todo el equipo)"
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

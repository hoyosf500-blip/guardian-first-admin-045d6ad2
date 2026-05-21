import { useEffect, useMemo, useState, useCallback } from 'react';
import { useStore } from '@/contexts/StoreContext';
import { useShopifyPending, type ShopifyPendingItem } from '@/hooks/useShopifyPending';
import { pollWhenVisible } from '@/lib/pollWhenVisible';
import { ShoppingBag, RefreshCw, Copy, Check, ExternalLink, ChevronDown, ChevronUp, AlertTriangle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

const DONE_KEY = (storeId: string) => `guardian.shopifyDone:${storeId}`;

function loadDone(storeId: string): Set<string> {
  try { return new Set(JSON.parse(sessionStorage.getItem(DONE_KEY(storeId)) || '[]')); }
  catch { return new Set(); }
}

/**
 * Panel "Sin pasar a Dropi" (arriba de la cola de Confirmar).
 * Muestra cuántos pedidos de Shopify aún no llegaron a Dropi + la lista para
 * que la operadora los meta a mano. El contador baja con cada "Ya lo metí"
 * (optimista local) y se confirma en el próximo refresh, cuando el pedido ya
 * aparece en Dropi (su teléfono entra a `orders`).
 */
export default function ShopifyPendingPanel() {
  const { activeStoreId } = useStore();
  const { data, isLoading, isFetching, refetch } = useShopifyPending(activeStoreId);
  const [expanded, setExpanded] = useState(false);
  const [done, setDone] = useState<Set<string>>(() => activeStoreId ? loadDone(activeStoreId) : new Set());
  const [copied, setCopied] = useState<string | null>(null);

  // Al cambiar de tienda, recargar el set local.
  useEffect(() => { setDone(activeStoreId ? loadDone(activeStoreId) : new Set()); }, [activeStoreId]);

  // Auto-refresh suave cada 2 min (solo pestaña visible).
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
      if (next.size !== prev.size) {
        try { sessionStorage.setItem(DONE_KEY(activeStoreId), JSON.stringify([...next])); } catch { /* noop */ }
      }
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

  const copyPhone = useCallback(async (phone: string) => {
    try { await navigator.clipboard.writeText(phone); setCopied(phone); setTimeout(() => setCopied(null), 1500); } catch { /* noop */ }
  }, []);

  const visible = pending.filter(p => !done.has(p.id));
  const count = visible.length;

  // No configurado, o cargando la primera vez sin datos → no estorbar la cola.
  if (!activeStoreId) return null;
  if (data && data.configured === false) return null;
  if (isLoading && !data) return null;
  // Sin pendientes y ya cargó → mensaje mínimo de "todo al día".
  if (data?.ok && count === 0) {
    return (
      <div className="mb-4 rounded-xl border border-border bg-card px-4 py-2.5 flex items-center gap-2 text-sm">
        <ShoppingBag size={15} className="text-success" />
        <span className="text-foreground font-medium">Shopify al día</span>
        <span className="text-muted-foreground">— todos los pedidos pasaron a Dropi</span>
        <button onClick={() => refetch()} className="ml-auto text-muted-foreground hover:text-foreground" title="Actualizar">
          <RefreshCw size={13} className={isFetching ? 'animate-spin' : ''} />
        </button>
      </div>
    );
  }
  if (data && !data.ok) {
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

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      className="mb-4 rounded-xl border border-warning/40 bg-warning/10 overflow-hidden">
      <div className="px-4 py-3 flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-warning/20 flex items-center justify-center flex-shrink-0">
          <ShoppingBag size={18} className="text-warning" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-extrabold text-foreground tabular-nums">{count}</span>
            <span className="text-sm font-semibold text-foreground">sin pasar a Dropi</span>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Pedidos de Shopify (últimos {data?.days ?? 3} días) que todavía no están en Dropi. Metelos a mano y marcá "ya lo metí".
          </p>
        </div>
        <button onClick={() => refetch()} title="Actualizar"
          className="h-8 w-8 rounded-lg border border-border bg-card flex items-center justify-center text-muted-foreground hover:text-foreground flex-shrink-0">
          <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} />
        </button>
        <button onClick={() => setExpanded(e => !e)}
          className="h-8 px-3 rounded-lg border border-border bg-card text-xs font-medium text-foreground flex items-center gap-1 flex-shrink-0">
          {expanded ? 'Ocultar' : 'Ver lista'}
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
      </div>

      <AnimatePresence>
        {expanded && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            className="border-t border-warning/30 max-h-96 overflow-y-auto divide-y divide-border bg-card/50">
            {visible.map(p => (
              <div key={p.id} className="px-4 py-2.5 flex items-center gap-3 text-sm">
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
                <button onClick={() => markDone(p.id)}
                  className="h-7 px-2.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 flex-shrink-0">
                  Ya lo metí
                </button>
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

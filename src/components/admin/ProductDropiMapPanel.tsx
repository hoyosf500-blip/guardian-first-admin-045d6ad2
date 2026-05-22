import { useEffect, useState, useCallback, useMemo } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useStore } from '@/contexts/StoreContext';
import { useAuth } from '@/contexts/AuthContext';
import { usePushToDropi, type ShopifyProductLite } from '@/hooks/usePushToDropi';
import DropiProductSearch from '@/components/DropiProductSearch';
import { Link2, Save, Loader2, Trash2, CheckCircle2, AlertTriangle, RefreshCw, Package } from 'lucide-react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';

const fadeUp = { initial: { opacity: 0, y: 16 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.35, ease: 'easeOut' } };

interface MapRow {
  shopify_product_id: number;
  dropi_product_id: number;
  dropi_variation_id: number | null;
  created_at: string;
}

/**
 * Panel de vínculos Shopify → Dropi (POR TIENDA), estilo Dropify.
 * Lista TODOS los productos de Shopify de la tienda y marca cuáles ya están
 * vinculados (✓ Dropi #id) y cuáles faltan (⚠). Para los que faltan, se busca
 * el producto en Dropi por nombre y se vincula con un clic. El mapeo es por
 * id de producto de Shopify, así que se carga UNA vez por producto y aplica a
 * todos los pedidos. RLS deja LEER a miembros; escribir/borrar va por RPCs.
 */
export default function ProductDropiMapPanel() {
  const { activeStore, activeStoreId, isManagerOfActive } = useStore();
  const { user } = useAuth();
  const { listShopifyProducts } = usePushToDropi(activeStoreId);

  const [loading, setLoading] = useState(true);
  const [shopProducts, setShopProducts] = useState<ShopifyProductLite[]>([]);
  const [shopError, setShopError] = useState<string | null>(null);
  const [rows, setRows] = useState<MapRow[]>([]);
  const [linkingFor, setLinkingFor] = useState<number | null>(null); // shopify product id mostrando el buscador
  const [savingFor, setSavingFor] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  // Alta manual (fallback): para vincular un id que no aparece en la lista.
  const [showManual, setShowManual] = useState(false);
  const [mShopifyId, setMShopifyId] = useState('');
  const [mDropiId, setMDropiId] = useState('');
  const [mVariationId, setMVariationId] = useState('');
  const [savingManual, setSavingManual] = useState(false);

  const loadMap = useCallback(async () => {
    if (!activeStoreId) { setRows([]); return; }
    const { data } = await supabase
      .from('shopify_product_dropi_map')
      .select('shopify_product_id, dropi_product_id, dropi_variation_id, created_at')
      .eq('store_id', activeStoreId)
      .order('created_at', { ascending: false });
    setRows((data as MapRow[]) ?? []);
  }, [activeStoreId]);

  const loadAll = useCallback(async () => {
    if (!isManagerOfActive || !activeStoreId) { setLoading(false); return; }
    setLoading(true); setShopError(null);
    await loadMap();
    try { setShopProducts(await listShopifyProducts()); }
    catch (e) { setShopError(e instanceof Error ? e.message : 'No se pudieron leer los productos de Shopify'); setShopProducts([]); }
    setLoading(false);
  }, [isManagerOfActive, activeStoreId, listShopifyProducts, loadMap]);

  useEffect(() => { void loadAll(); }, [loadAll]);

  const mapById = useMemo(() => {
    const m = new Map<number, MapRow>();
    rows.forEach(r => m.set(Number(r.shopify_product_id), r));
    return m;
  }, [rows]);

  // Vínculos cuyo producto ya no está en el catálogo de Shopify (huérfanos).
  const orphans = useMemo(() => {
    const ids = new Set(shopProducts.map(p => p.id));
    return rows.filter(r => !ids.has(Number(r.shopify_product_id)));
  }, [rows, shopProducts]);

  const linkedCount = useMemo(
    () => shopProducts.filter(p => mapById.has(p.id)).length,
    [shopProducts, mapById],
  );

  async function linkOne(shopifyProductId: number, dropiProductId: number, dropiVariationId: number | null) {
    if (!activeStoreId) return;
    setSavingFor(shopifyProductId);
    const args: { p_store_id: string; p_shopify_product_id: number; p_dropi_product_id: number; p_dropi_variation_id?: number } = {
      p_store_id: activeStoreId, p_shopify_product_id: shopifyProductId, p_dropi_product_id: dropiProductId,
    };
    if (dropiVariationId != null) args.p_dropi_variation_id = dropiVariationId;
    const { error } = await supabase.rpc('upsert_shopify_product_dropi_map', args);
    setSavingFor(null); setLinkingFor(null);
    if (error) { toast.error('No se pudo vincular', { description: error.message }); return; }
    toast.success('Producto vinculado a Dropi ✓');
    await loadMap();
  }

  async function remove(shopifyProductId: number) {
    if (!activeStoreId) return;
    setDeletingId(shopifyProductId);
    const { error } = await supabase.rpc('delete_shopify_product_dropi_map', {
      p_store_id: activeStoreId, p_shopify_product_id: shopifyProductId,
    });
    setDeletingId(null);
    if (error) { toast.error('No se pudo borrar', { description: error.message }); return; }
    toast.success('Vínculo borrado');
    await loadMap();
  }

  async function saveManual() {
    const sId = Number(mShopifyId.trim());
    const dId = Number(mDropiId.trim());
    if (!Number.isInteger(sId) || sId <= 0) { toast.error('Id de producto de Shopify inválido.'); return; }
    if (!Number.isInteger(dId) || dId <= 0) { toast.error('Id de producto de Dropi inválido.'); return; }
    const vRaw = mVariationId.trim();
    const vId = vRaw ? Number(vRaw) : null;
    if (vRaw && (!Number.isInteger(vId as number) || (vId as number) <= 0)) { toast.error('Id de variación inválido.'); return; }
    setSavingManual(true);
    await linkOne(sId, dId, vId);
    setSavingManual(false);
    setMShopifyId(''); setMDropiId(''); setMVariationId('');
  }

  if (!user || !activeStore) return null;
  if (!isManagerOfActive) {
    return (
      <div className="md:col-span-2 rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
        Solo el dueño o supervisor de <span className="font-medium text-foreground">{activeStore.name}</span> puede ver/editar los vínculos de productos.
      </div>
    );
  }

  return (
    <motion.div {...fadeUp} className="bg-card rounded-xl border border-border overflow-hidden md:col-span-2">
      <div className="px-5 py-4 border-b border-border flex items-center gap-2">
        <Link2 size={16} className="text-primary" />
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-foreground">Vínculos de productos Shopify → Dropi · {activeStore.name}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Vinculá cada producto con su id de Dropi una sola vez. Aplica a todos los pedidos (no se vuelve a pedir).
            {shopProducts.length > 0 && <> <span className="text-foreground font-medium">{linkedCount}/{shopProducts.length}</span> vinculados.</>}
          </p>
        </div>
        <button onClick={() => void loadAll()} disabled={loading} title="Actualizar"
          className="h-8 w-8 rounded-lg border border-border bg-card flex items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-50">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="px-5 py-4 space-y-3">
        {loading ? (
          <div className="py-6 flex items-center justify-center"><Loader2 className="animate-spin text-muted-foreground" size={18} /></div>
        ) : (
          <>
            {shopError && (
              <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning flex items-start gap-2">
                <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                <span>No se pudo leer el catálogo de Shopify ({shopError}). Podés vincular igual cargando los ids a mano abajo.</span>
              </div>
            )}

            {/* Lista de productos de Shopify con su estado */}
            {shopProducts.length > 0 && (
              <div className="rounded-lg border border-border divide-y divide-border overflow-hidden">
                {shopProducts.map(p => {
                  const m = mapById.get(p.id);
                  return (
                    <div key={p.id}>
                      <div className="px-3 py-2.5 flex items-center gap-3 text-sm">
                        {p.image
                          ? <img src={p.image} alt="" loading="lazy" className="w-9 h-9 rounded object-cover border border-border shrink-0" />
                          : <div className="w-9 h-9 rounded bg-muted flex items-center justify-center shrink-0"><Package size={14} className="text-muted-foreground" /></div>}
                        <div className="flex-1 min-w-0">
                          <div className="truncate text-foreground">{p.title}</div>
                          <div className="text-[10px] font-mono text-muted-foreground">Shopify #{p.id}{p.status && p.status !== 'active' ? ` · ${p.status}` : ''}</div>
                        </div>
                        {m ? (
                          <span className="text-xs text-success flex items-center gap-1 shrink-0">
                            <CheckCircle2 size={13} /> Dropi #{m.dropi_product_id}{m.dropi_variation_id ? ` · var ${m.dropi_variation_id}` : ''}
                          </span>
                        ) : (
                          <span className="text-xs text-warning flex items-center gap-1 shrink-0"><AlertTriangle size={13} /> falta vincular</span>
                        )}
                        <button onClick={() => setLinkingFor(linkingFor === p.id ? null : p.id)}
                          className="h-7 px-2.5 rounded-lg border border-border bg-card text-xs font-medium text-foreground hover:bg-muted/40 shrink-0">
                          {m ? 'Cambiar' : 'Vincular'}
                        </button>
                        {m && (
                          <button onClick={() => remove(p.id)} disabled={deletingId === p.id} title="Borrar vínculo"
                            className="h-7 w-7 rounded-lg border border-border flex items-center justify-center text-muted-foreground hover:text-destructive hover:border-destructive/40 disabled:opacity-50 shrink-0">
                            {deletingId === p.id ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                          </button>
                        )}
                      </div>
                      {linkingFor === p.id && (
                        <div className="px-3 pb-3 pt-1 bg-muted/20">
                          <DropiProductSearch storeId={activeStoreId} busy={savingFor === p.id}
                            onSelect={(dId, vId) => linkOne(p.id, dId, vId)} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {!shopError && shopProducts.length === 0 && (
              <div className="py-4 text-center text-sm text-muted-foreground">No se encontraron productos en Shopify para esta tienda.</div>
            )}

            {/* Huérfanos: vínculos cuyo producto ya no está en Shopify */}
            {orphans.length > 0 && (
              <div className="space-y-1">
                <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Otros vínculos (producto no encontrado en Shopify)</div>
                <div className="rounded-lg border border-border divide-y divide-border">
                  {orphans.map(r => (
                    <div key={r.shopify_product_id} className="px-3 py-2 grid grid-cols-[1fr,1fr,2rem] gap-2 items-center text-sm font-mono">
                      <span className="truncate text-muted-foreground">Shopify {r.shopify_product_id}</span>
                      <span className="truncate text-foreground">Dropi #{r.dropi_product_id}{r.dropi_variation_id ? ` · var ${r.dropi_variation_id}` : ''}</span>
                      <button onClick={() => remove(r.shopify_product_id)} disabled={deletingId === r.shopify_product_id}
                        className="h-7 w-7 rounded-lg border border-border flex items-center justify-center text-muted-foreground hover:text-destructive hover:border-destructive/40 disabled:opacity-50" title="Borrar vínculo">
                        {deletingId === r.shopify_product_id ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Alta manual (fallback) */}
            <details open={showManual} onToggle={e => setShowManual((e.target as HTMLDetailsElement).open)} className="text-xs">
              <summary className="cursor-pointer text-muted-foreground select-none">Agregar un vínculo a mano (por id)</summary>
              <div className="mt-2 grid grid-cols-1 sm:grid-cols-[1fr,1fr,7rem,auto] gap-2 items-end">
                <div>
                  <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Id Shopify</label>
                  <input inputMode="numeric" value={mShopifyId} onChange={e => setMShopifyId(e.target.value)} placeholder="9483772952801"
                    className="mt-1 w-full h-9 rounded-lg border border-border bg-background px-2 text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30" />
                </div>
                <div>
                  <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Id Dropi</label>
                  <input inputMode="numeric" value={mDropiId} onChange={e => setMDropiId(e.target.value)} placeholder="2034257"
                    className="mt-1 w-full h-9 rounded-lg border border-border bg-background px-2 text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30" />
                </div>
                <div>
                  <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Variación</label>
                  <input inputMode="numeric" value={mVariationId} onChange={e => setMVariationId(e.target.value)} placeholder="—"
                    className="mt-1 w-full h-9 rounded-lg border border-border bg-background px-2 text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30" />
                </div>
                <button onClick={saveManual} disabled={savingManual || !mShopifyId.trim() || !mDropiId.trim()}
                  className="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium flex items-center gap-2 hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed">
                  {savingManual ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Guardar
                </button>
              </div>
            </details>
          </>
        )}
      </div>
    </motion.div>
  );
}

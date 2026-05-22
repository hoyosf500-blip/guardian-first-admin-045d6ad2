import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useStore } from '@/contexts/StoreContext';
import { useAuth } from '@/contexts/AuthContext';
import { Link2, Save, Loader2, Trash2, ExternalLink } from 'lucide-react';
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
 * Panel de vínculos Shopify → Dropi (POR TIENDA).
 * Para tiendas cuyo catálogo se cargó a mano en Shopify (sin la app de Dropi),
 * los productos no tienen el metafield `dropi/_dropi_product`. Acá se registra
 * manualmente el id de Dropi de cada producto para que "Subir a Dropi" lo
 * resuelva (igual que el metafield en Colombia). RLS deja LEER a miembros;
 * escribir/borrar va por RPCs gated por is_store_member.
 */
export default function ProductDropiMapPanel() {
  const { activeStore, activeStoreId, isManagerOfActive } = useStore();
  const { user } = useAuth();

  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<MapRow[]>([]);
  const [shopifyId, setShopifyId] = useState('');
  const [dropiId, setDropiId] = useState('');
  const [variationId, setVariationId] = useState('');
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!activeStoreId) { setRows([]); setLoading(false); return; }
    setLoading(true);
    const { data } = await supabase
      .from('shopify_product_dropi_map')
      .select('shopify_product_id, dropi_product_id, dropi_variation_id, created_at')
      .eq('store_id', activeStoreId)
      .order('created_at', { ascending: false });
    setRows((data as MapRow[]) ?? []);
    setLoading(false);
  }, [activeStoreId]);

  useEffect(() => { if (isManagerOfActive) void load(); else setLoading(false); }, [load, isManagerOfActive]);

  async function save() {
    if (!activeStoreId) return;
    const sId = Number(shopifyId.trim());
    const dId = Number(dropiId.trim());
    if (!Number.isInteger(sId) || sId <= 0) { toast.error('Id de producto de Shopify inválido (solo números).'); return; }
    if (!Number.isInteger(dId) || dId <= 0) { toast.error('Id de producto de Dropi inválido (solo números).'); return; }
    const vRaw = variationId.trim();
    const vId = vRaw ? Number(vRaw) : null;
    if (vRaw && (!Number.isInteger(vId as number) || (vId as number) <= 0)) { toast.error('Id de variación inválido.'); return; }

    setSaving(true);
    const args: { p_store_id: string; p_shopify_product_id: number; p_dropi_product_id: number; p_dropi_variation_id?: number } = {
      p_store_id: activeStoreId, p_shopify_product_id: sId, p_dropi_product_id: dId,
    };
    if (vId != null) args.p_dropi_variation_id = vId;
    const { error } = await supabase.rpc('upsert_shopify_product_dropi_map', args);
    setSaving(false);
    if (error) { toast.error('No se pudo guardar', { description: error.message }); return; }
    toast.success('Vínculo guardado');
    setShopifyId(''); setDropiId(''); setVariationId('');
    await load();
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
    await load();
  }

  if (!user || !activeStore) return null;
  if (!isManagerOfActive) {
    return (
      <div className="md:col-span-2 rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
        Solo el dueño o supervisor de <span className="font-medium text-foreground">{activeStore.name}</span> puede ver/editar los vínculos de productos.
      </div>
    );
  }

  const dropiHost = activeStore.country_code === 'EC' ? 'app.dropi.ec' : 'app.dropi.co';

  return (
    <motion.div {...fadeUp} className="bg-card rounded-xl border border-border overflow-hidden md:col-span-2">
      <div className="px-5 py-4 border-b border-border flex items-center gap-2">
        <Link2 size={16} className="text-primary" />
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-foreground">Vínculos de productos Shopify → Dropi · {activeStore.name}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Para productos cargados a mano en Shopify (sin la app de Dropi). Registrá el id de Dropi una vez por producto y "Subir a Dropi" lo resuelve solo.
          </p>
        </div>
      </div>

      <div className="px-5 py-4 space-y-4">
        {/* Form de alta/edición */}
        <div className="grid grid-cols-1 sm:grid-cols-[1fr,1fr,8rem,auto] gap-2 items-end">
          <div>
            <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Id producto Shopify</label>
            <input inputMode="numeric" value={shopifyId} onChange={e => setShopifyId(e.target.value)} placeholder="9483772952801"
              className="mt-1 w-full h-10 rounded-lg border border-border bg-background px-3 text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30" />
          </div>
          <div>
            <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Id producto Dropi</label>
            <input inputMode="numeric" value={dropiId} onChange={e => setDropiId(e.target.value)} placeholder="106244"
              className="mt-1 w-full h-10 rounded-lg border border-border bg-background px-3 text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30" />
          </div>
          <div>
            <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Variación (opc.)</label>
            <input inputMode="numeric" value={variationId} onChange={e => setVariationId(e.target.value)} placeholder="—"
              className="mt-1 w-full h-10 rounded-lg border border-border bg-background px-3 text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30" />
          </div>
          <button onClick={save} disabled={saving || !shopifyId.trim() || !dropiId.trim()}
            className="h-10 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium flex items-center gap-2 hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Guardar vínculo
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          El <strong>id de Shopify</strong> lo ves en el modal «Subir a Dropi» (<code className="bg-muted px-1 rounded">Shopify #…</code>) o en la URL del producto en Shopify admin.
          El <strong>id de Dropi</strong> lo sacás de <a href={`https://${dropiHost}`} target="_blank" rel="noreferrer" className="text-primary inline-flex items-center gap-0.5 hover:underline">{dropiHost} <ExternalLink size={10} /></a> abriendo el producto. Guardar un id ya existente lo sobreescribe.
        </p>

        {/* Tabla de vínculos */}
        {loading ? (
          <div className="py-6 flex items-center justify-center"><Loader2 className="animate-spin text-muted-foreground" size={18} /></div>
        ) : rows.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">Todavía no hay vínculos cargados para esta tienda.</div>
        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            <div className="px-3 py-2 bg-muted/40 text-[10px] font-medium text-muted-foreground uppercase tracking-wider grid grid-cols-[1fr,1fr,5rem,2rem] gap-2">
              <span>Shopify</span><span>Dropi</span><span>Variación</span><span></span>
            </div>
            <div className="divide-y divide-border">
              {rows.map(r => (
                <div key={r.shopify_product_id} className="px-3 py-2 grid grid-cols-[1fr,1fr,5rem,2rem] gap-2 items-center text-sm font-mono">
                  <span className="truncate text-foreground">{r.shopify_product_id}</span>
                  <span className="truncate text-foreground">#{r.dropi_product_id}</span>
                  <span className="text-muted-foreground">{r.dropi_variation_id ?? '—'}</span>
                  <button onClick={() => remove(r.shopify_product_id)} disabled={deletingId === r.shopify_product_id}
                    className="h-7 w-7 rounded-lg border border-border flex items-center justify-center text-muted-foreground hover:text-destructive hover:border-destructive/40 disabled:opacity-50"
                    title="Borrar vínculo">
                    {deletingId === r.shopify_product_id ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}

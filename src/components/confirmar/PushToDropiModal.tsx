import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { X, Loader2, Truck, AlertTriangle, CheckCircle2, Link2 } from 'lucide-react';
import { usePushToDropi, type PushClient, type PushProduct, type PushUnmapped, type PushDuplicate } from '@/hooks/usePushToDropi';
import DropiProductSearch from '@/components/DropiProductSearch';
import { toast } from 'sonner';

interface Props {
  storeId: string;
  shopifyOrderId: string;
  shopifyName?: string;     // "#1234" para el encabezado
  onClose: () => void;
  onSuccess: (dropiOrderId: string | null) => void;  // el panel marca el pedido como subido
}

const EMPTY_CLIENT: PushClient = { name: '', surname: '', phone: '', dir: '', city: '', state: '', email: '', notes: '' };

/**
 * Modal de "Subir a Dropi": muestra la vista previa (cliente + productos)
 * editable y, al confirmar, crea la orden real en Dropi. Crear es irreversible
 * (genera guía/flete), por eso siempre pasa por esta confirmación.
 */
export default function PushToDropiModal({ storeId, shopifyOrderId, shopifyName, onClose, onSuccess }: Props) {
  const { preview, confirm, linkProduct } = usePushToDropi(storeId);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [client, setClient] = useState<PushClient>(EMPTY_CLIENT);
  const [lines, setLines] = useState<PushProduct[]>([]);
  const [shipping, setShipping] = useState(0);
  const [unmapped, setUnmapped] = useState<PushUnmapped[]>([]);
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const [alreadyPushed, setAlreadyPushed] = useState(false);
  const [shopifyTotal, setShopifyTotal] = useState<number | null>(null);
  const [codMismatch, setCodMismatch] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Bloqueo server-side por teléfono duplicado (guard de la edge). Guarda los
  // pedidos Dropi que ya existen con ese teléfono → el operador decide "subir igual".
  const [dupBlock, setDupBlock] = useState<PushDuplicate[] | null>(null);
  // Vinculación manual (estilo Dropify): por product_id, el id de Dropi que el
  // operador pega para productos sin metafield (catálogo cargado a mano).
  const [linkInputs, setLinkInputs] = useState<Record<number, { dropiId: string; variationId: string }>>({});
  const [linkingId, setLinkingId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true); setLoadError(null);
      const p = await preview(shopifyOrderId);
      if (cancelled) return;
      if (!p.ok) { setLoadError(p.error || 'No se pudo armar la vista previa'); setLoading(false); return; }
      setClient(p.client ?? EMPTY_CLIENT);
      setLines(p.products ?? []);
      setShipping(Number(p.shipping) || 0);
      setUnmapped(p.unmapped ?? []);
      setDiagnostic(p.diagnostic ?? null);
      setAlreadyPushed(Boolean(p.alreadyPushed));
      setShopifyTotal(typeof p.shopify_total === 'number' ? p.shopify_total : null);
      setCodMismatch(Boolean(p.cod_mismatch));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [preview, shopifyOrderId]);

  const productsTotal = useMemo(() => lines.reduce((s, l) => s + (Number(l.price) || 0) * (Number(l.quantity) || 0), 0), [lines]);
  const total = productsTotal + (Number(shipping) || 0);
  const setField = (k: keyof PushClient, v: string) => setClient(c => ({ ...c, [k]: v }));
  const setLine = (i: number, k: 'price' | 'quantity', v: number) =>
    setLines(ls => ls.map((l, idx) => idx === i ? { ...l, [k]: v } : l));

  const setLinkInput = (productId: number, k: 'dropiId' | 'variationId', v: string) =>
    setLinkInputs(s => ({ ...s, [productId]: { dropiId: '', variationId: '', ...s[productId], [k]: v } }));

  /** Guarda el vínculo Shopify→Dropi y resuelve la línea en el acto (sin
   *  recargar, para no perder ediciones). El confirm re-valida server-side. */
  async function doLinkResolved(shopifyProductId: number, dropiProductId: number, dropiVariationId: number | null) {
    setLinkingId(shopifyProductId);
    const r = await linkProduct(shopifyProductId, dropiProductId, dropiVariationId);
    setLinkingId(null);
    if (!r.ok) { toast.error(r.error || 'No se pudo guardar el vínculo'); return; }
    toast.success('Producto vinculado a Dropi ✓');
    setLines(ls => ls.map(l => l.product_id === shopifyProductId
      ? { ...l, dropiId: dropiProductId, variationId: dropiVariationId } : l));
    const nextUnmapped = unmapped.filter(u => u.product_id !== shopifyProductId);
    setUnmapped(nextUnmapped);
    if (nextUnmapped.length === 0) setDiagnostic(null);
  }

  /** Fallback manual: parsea el id pegado a mano y vincula. */
  async function doLink(productId: number) {
    const inp = linkInputs[productId];
    const dropiProductId = Number((inp?.dropiId ?? '').trim());
    if (!Number.isInteger(dropiProductId) || dropiProductId <= 0) {
      toast.error('Poné el id del producto en Dropi (solo números).'); return;
    }
    const variationRaw = (inp?.variationId ?? '').trim();
    const dropiVariationId = variationRaw ? Number(variationRaw) : null;
    if (variationRaw && (!Number.isInteger(dropiVariationId as number) || (dropiVariationId as number) <= 0)) {
      toast.error('El id de variación debe ser un número.'); return;
    }
    await doLinkResolved(productId, dropiProductId, dropiVariationId);
  }

  const blockedReason =
    unmapped.length > 0 ? (diagnostic || `${unmapped.length} producto(s) sin vínculo a Dropi — no se importaron por Dropify. Súbelo manual en Dropi o vinculá el producto primero.`)
    : !client.name || !client.dir || !client.city || !client.state || !client.phone ? 'Faltan datos del cliente (nombre, dirección, ciudad, departamento, teléfono).'
    : null;

  async function doConfirm(allowDuplicate = false) {
    setSubmitting(true); setSubmitError(null);
    if (allowDuplicate) setDupBlock(null);
    const overrides = {
      client,
      lines: Object.fromEntries(lines.map((l, i) => [String(i), { price: Number(l.price), quantity: Number(l.quantity) }])),
    };
    const r = await confirm(shopifyOrderId, overrides, allowDuplicate);
    setSubmitting(false);
    // Guard server-side: el teléfono ya está en Dropi. Mostramos los pedidos que
    // existen y dejamos "subir igual" (recompra real) sin cerrar el modal.
    if (!r.ok && r.blocked === 'duplicate_phone') {
      setDupBlock(r.duplicates ?? []);
      setSubmitError(null);
      return;
    }
    if (!r.ok) { setSubmitError(r.error || 'Dropi rechazó el pedido'); return; }
    toast.success(`Subido a Dropi${r.dropi_order_id ? ` (orden ${r.dropi_order_id})` : ''}`);
    onSuccess(r.dropi_order_id ?? null);
  }

  const input = 'w-full h-9 rounded-lg border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30';
  const label = 'text-[10px] font-medium text-muted-foreground uppercase tracking-wider';

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50" onClick={onClose}>
      <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}
        onClick={e => e.stopPropagation()}
        className="w-full max-w-lg max-h-[88vh] overflow-y-auto rounded-2xl border border-border bg-card shadow-xl">
        <div className="sticky top-0 z-10 px-5 py-4 border-b border-border bg-card flex items-center gap-2">
          <Truck size={16} className="text-primary" />
          <h3 className="text-sm font-semibold text-foreground flex-1">Subir a Dropi {shopifyName && <span className="text-muted-foreground font-mono">· {shopifyName}</span>}</h3>
          <button onClick={onClose} className="h-7 w-7 rounded-lg border border-border flex items-center justify-center text-muted-foreground hover:text-foreground"><X size={14} /></button>
        </div>

        {loading ? (
          <div className="p-8 flex items-center justify-center"><Loader2 className="animate-spin text-muted-foreground" size={20} /></div>
        ) : loadError ? (
          <div className="p-5 text-sm text-destructive flex items-center gap-2"><AlertTriangle size={15} /> {loadError}</div>
        ) : alreadyPushed ? (
          <div className="p-6 text-center space-y-2">
            <CheckCircle2 size={28} className="text-success mx-auto" />
            <p className="text-sm text-foreground">Este pedido ya fue subido a Dropi.</p>
            <button onClick={() => onSuccess(null)} className="mt-2 h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium">Entendido</button>
          </div>
        ) : (
          <div className="p-5 space-y-4">
            {codMismatch && shopifyTotal != null && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive flex items-start gap-2">
                <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                <span>
                  El COD calculado (<strong>${total.toLocaleString()}</strong>) supera el total real de Shopify
                  (<strong>${shopifyTotal.toLocaleString()}</strong>). Probablemente se perdió un descuento —
                  revisá los precios antes de subir para no cobrarle de más al cliente.
                </span>
              </div>
            )}
            {unmapped.length > 0 && (
              <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning flex items-start gap-2">
                <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                <span>
                  {diagnostic || 'Estos productos no tienen vínculo a Dropi.'}
                  <span className="block mt-1 text-warning/80">Pegá el <strong>id de Dropi</strong> de cada producto marcado abajo y tocá «Vincular». Se guarda para esta tienda — solo lo hacés una vez por producto.</span>
                </span>
              </div>
            )}

            {/* Cliente */}
            <div className="grid grid-cols-2 gap-3">
              <div><label className={label}>Nombre</label><input className={input} value={client.name} onChange={e => setField('name', e.target.value)} /></div>
              <div><label className={label}>Apellido</label><input className={input} value={client.surname} onChange={e => setField('surname', e.target.value)} /></div>
              <div><label className={label}>Teléfono</label><input className={input} value={client.phone} onChange={e => setField('phone', e.target.value)} /></div>
              <div><label className={label}>Email</label><input className={input} value={client.email} onChange={e => setField('email', e.target.value)} /></div>
              <div className="col-span-2"><label className={label}>Dirección</label><input className={input} value={client.dir} onChange={e => setField('dir', e.target.value)} /></div>
              <div><label className={label}>Ciudad</label><input className={input} value={client.city} onChange={e => setField('city', e.target.value)} /></div>
              <div><label className={label}>Departamento</label><input className={input} value={client.state} onChange={e => setField('state', e.target.value)} /></div>
              <div className="col-span-2"><label className={label}>Notas (van en la guía)</label><input className={input} value={client.notes} onChange={e => setField('notes', e.target.value)} /></div>
            </div>

            {/* Productos */}
            <div className="rounded-lg border border-border overflow-hidden">
              <div className="px-3 py-2 bg-muted/40 text-[10px] font-medium text-muted-foreground uppercase tracking-wider grid grid-cols-[1fr,3rem,5rem] gap-2">
                <span>Producto</span><span className="text-center">Cant.</span><span className="text-right">Precio u.</span>
              </div>
              <div className="divide-y divide-border">
                {lines.map((l, i) => (
                  <div key={i} className="px-3 py-2 text-sm">
                    <div className="grid grid-cols-[1fr,3rem,5rem] gap-2 items-center">
                      <div className="min-w-0">
                        <div className="truncate text-foreground">{l.title}</div>
                        <div className="text-[10px] text-muted-foreground font-mono">
                          {l.dropiId ? `Dropi #${l.dropiId}` : <span className="text-warning">sin vínculo</span>}{l.sku ? ` · ${l.sku}` : ''}
                        </div>
                      </div>
                      <input type="number" min={1} value={l.quantity} onChange={e => setLine(i, 'quantity', Number(e.target.value))}
                        className="h-8 w-full rounded border border-border bg-background px-1 text-center text-sm" />
                      <input type="number" min={0} value={l.price} onChange={e => setLine(i, 'price', Number(e.target.value))}
                        className="h-8 w-full rounded border border-border bg-background px-1 text-right text-sm font-mono" />
                    </div>

                    {l.dropiId == null && (
                      <div className="mt-2 rounded-lg border border-warning/40 bg-warning/5 p-2 space-y-2">
                        <div className="text-[10px] text-muted-foreground">
                          Vinculá con Dropi · buscá el producto por su <strong>nombre</strong> y elegilo (se guarda para esta tienda — una sola vez)
                        </div>
                        <DropiProductSearch storeId={storeId} busy={linkingId === l.product_id}
                          onSelect={(dropiId, varId) => doLinkResolved(l.product_id, dropiId, varId)} />
                        <details className="text-[11px]">
                          <summary className="cursor-pointer text-muted-foreground select-none">o pegá el id de Dropi manual</summary>
                          <div className="flex items-center gap-2 mt-1.5">
                            <input inputMode="numeric" placeholder="ID producto Dropi"
                              value={linkInputs[l.product_id]?.dropiId ?? ''}
                              onChange={e => setLinkInput(l.product_id, 'dropiId', e.target.value)}
                              className="h-8 flex-1 min-w-0 rounded border border-border bg-background px-2 text-sm" />
                            <input inputMode="numeric" placeholder="Variación (opc.)"
                              value={linkInputs[l.product_id]?.variationId ?? ''}
                              onChange={e => setLinkInput(l.product_id, 'variationId', e.target.value)}
                              className="h-8 w-28 rounded border border-border bg-background px-2 text-sm" />
                            <button type="button" onClick={() => doLink(l.product_id)}
                              disabled={linkingId === l.product_id || !(linkInputs[l.product_id]?.dropiId ?? '').trim()}
                              className="h-8 px-3 rounded bg-secondary text-secondary-foreground text-xs font-medium flex items-center gap-1 hover:bg-secondary/80 disabled:opacity-50 disabled:cursor-not-allowed shrink-0">
                              {linkingId === l.product_id ? <Loader2 size={12} className="animate-spin" /> : <Link2 size={12} />} Vincular
                            </button>
                          </div>
                        </details>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              {shipping > 0 && (
                <div className="px-3 py-1.5 flex items-center justify-between text-xs border-t border-border">
                  <span className="text-muted-foreground">Envío prioritario</span>
                  <span className="tabular-nums text-foreground">+${shipping.toLocaleString()}</span>
                </div>
              )}
              <div className="px-3 py-2 bg-muted/40 flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Total a cobrar (COD)</span>
                <span className="font-bold tabular-nums text-foreground">${total.toLocaleString()}</span>
              </div>
            </div>

            {submitError && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive flex items-start gap-2">
                <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" /><span>{submitError}</span>
              </div>
            )}

            {/* Bloqueo por teléfono duplicado (guard server-side). Muestra los pedidos
                que YA existen en Dropi con este teléfono y deja "subir igual" para
                recompra real. */}
            {dupBlock && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs text-destructive space-y-2">
                <div className="flex items-start gap-2">
                  <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                  <span>
                    Este teléfono ya tiene {dupBlock.length > 0 ? 'un pedido' : 'pedidos'} en Dropi:
                    <span className="block mt-1 font-medium text-foreground">
                      {dupBlock.slice(0, 3).map(d => `#${d.external_id}${d.estado ? ` · ${d.estado}` : ''}${d.fecha ? ` · ${d.fecha}` : ''}`).join('   |   ')}
                      {dupBlock.length > 3 ? `  (+${dupBlock.length - 3})` : ''}
                    </span>
                    Podría ser un duplicado. Si es una recompra real, subilo igual.
                  </span>
                </div>
                <div className="flex justify-end">
                  <button onClick={() => doConfirm(true)} disabled={submitting}
                    className="h-8 px-3 rounded-lg border border-destructive/40 bg-card text-xs font-medium text-destructive hover:bg-destructive/10 flex items-center gap-1 disabled:opacity-50">
                    {submitting ? <Loader2 size={12} className="animate-spin" /> : <Truck size={12} />} Subir igual (no es duplicado)
                  </button>
                </div>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button onClick={onClose} className="h-9 px-4 rounded-lg border border-border text-sm font-medium text-foreground hover:bg-muted/40">Cancelar</button>
              <button onClick={() => doConfirm()} disabled={submitting || !!blockedReason} title={blockedReason || undefined}
                className="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium flex items-center gap-2 hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed">
                {submitting ? <Loader2 size={14} className="animate-spin" /> : <Truck size={14} />} Confirmar y crear en Dropi
              </button>
            </div>
            {blockedReason && <p className="text-[11px] text-warning text-right">{blockedReason}</p>}
          </div>
        )}
      </motion.div>
    </div>,
    document.body,
  );
}

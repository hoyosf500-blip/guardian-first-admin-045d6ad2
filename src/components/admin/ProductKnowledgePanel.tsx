import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { SupabaseClient } from '@supabase/supabase-js';
import { useStore } from '@/contexts/StoreContext';
import { Package, Save, Loader2, Trash2, Plus, X, BookOpen } from 'lucide-react';
import { motion } from 'framer-motion';
import { TiltCard } from '@/components/ui3d';
import { toast } from 'sonner';
import DropiProductSearch from '@/components/DropiProductSearch';
import type { DropiProductHit } from '@/hooks/usePushToDropi';

// product_knowledge es nueva y aún no está en los tipos generados → cast sin `any`
// (mismo patrón que WaBotConfigPanel / useWaConversations).
const sb = supabase as unknown as SupabaseClient;
type RpcRes = { error: { message: string } | null };
// .bind(supabase) obligatorio: guardar `supabase.rpc` en una constante suelta
// le saca el `this` y al invocarla revienta con "Cannot read properties of
// undefined (reading 'rest')". Acá era una bomba de tiempo: se usa para
// guardar y borrar el conocimiento del bot (líneas ~92 y ~247).
// La forma `(supabase.rpc as X)(...)` que usa el resto del repo SÍ es segura —
// el paréntesis conserva la referencia; lo que rompe es asignarla a una
// variable.
const rpc = supabase.rpc.bind(supabase) as unknown as (fn: string, args: Record<string, unknown>) => Promise<RpcRes>;

const fadeUp = { initial: { opacity: 0, y: 16 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.35, ease: 'easeOut' } };

const KNOWLEDGE_PLACEHOLDER = `Escribilo como si se lo explicaras a una asesora nueva — el bot lo usa tal cual.

Ej (ClearZal, crema de crioterapia):
- Qué es / para qué sirve: crema para dolor muscular y articular (espalda, rodillas, hombros, golpes).
- Cómo se usa: una capa fina en la zona, masajear hasta absorber, 2-3 veces al día.
- Preguntas frecuentes: ¿mancha la ropa? No. ¿Es para adultos? Sí. ¿En heridas abiertas? No.
- Objeciones / cómo responder: "¿funciona?" → el alivio se siente a los pocos minutos por el efecto frío.`;

interface PkRow {
  id: string;
  label: string;
  match_text: string | null;
  dropi_product_id: number | null;
  knowledge: string;
  image_url: string | null;
  active: boolean;
}

type EditState = { mode: 'new' } | { mode: 'edit'; row: PkRow } | null;

/**
 * Conocimiento por producto para el bot de WhatsApp (/admin → "Productos (bot)").
 * El dueño define, por producto, QUÉ es y cómo acompañar al cliente. El bot
 * (wa-ai-responder) cruza el producto del pedido contra estas fichas e inyecta el
 * conocimiento en la conversación. Lee/escribe `product_knowledge` por RPC gated
 * a is_store_manager. Espejo de WaBotConfigPanel + patrón de cards de
 * ProductDropiMapPanel.
 */
export default function ProductKnowledgePanel() {
  const { activeStore, activeStoreId, isManagerOfActive } = useStore();

  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<PkRow[]>([]);
  const [productNames, setProductNames] = useState<string[]>([]); // distinct orders.producto (datalist)
  const [edit, setEdit] = useState<EditState>(null);

  const load = useCallback(async () => {
    if (!activeStoreId || !isManagerOfActive) { setLoading(false); return; }
    setLoading(true);
    const { data } = await sb
      .from('product_knowledge')
      .select('id, label, match_text, dropi_product_id, knowledge, image_url, active')
      .eq('store_id', activeStoreId)
      .order('created_at', { ascending: false });
    setRows((data as PkRow[]) ?? []);

    // Nombres distintos de productos de los pedidos → datalist para elegir el
    // match_text exacto sin tipear. Se lee con RLS del usuario (su tienda).
    const { data: prods } = await sb
      .from('orders')
      .select('producto')
      .eq('store_id', activeStoreId)
      .not('producto', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1000);
    const set = new Set<string>();
    (prods as Array<{ producto: string | null }> | null)?.forEach((p) => {
      const v = (p.producto || '').trim();
      if (v) set.add(v);
    });
    setProductNames([...set].sort());
    setLoading(false);
  }, [activeStoreId, isManagerOfActive]);

  useEffect(() => { void load(); }, [load]);

  // Al cambiar de tienda activa, cerrar cualquier editor abierto: su fila pertenece
  // a la tienda anterior y quedaría huérfana (editor invisible + botón bloqueado).
  useEffect(() => { setEdit(null); }, [activeStoreId]);

  async function remove(id: string) {
    if (!activeStoreId) return;
    const { error } = await rpc('delete_product_knowledge', { p_store_id: activeStoreId, p_id: id });
    if (error) { toast.error('No se pudo borrar', { description: error.message }); return; }
    toast.success('Producto eliminado');
    if (edit && edit.mode === 'edit' && edit.row.id === id) setEdit(null);
    await load();
  }

  if (!isManagerOfActive) {
    return (
      <div className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
        Solo el dueño o supervisor de la tienda puede configurar el conocimiento de los productos.
      </div>
    );
  }
  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-card p-5 flex items-center justify-center">
        <Loader2 className="animate-spin text-muted-foreground" size={18} />
      </div>
    );
  }

  return (
    <motion.div {...fadeUp} className="">
    <TiltCard className="bg-card/40 border border-border rounded-2xl shadow-card3d">
      {/* Header */}
      <div className="px-5 py-4 border-b border-border flex items-center gap-2">
        <span className="w-8 h-8 rounded-xl bg-accent/14 border border-accent/30 text-accent flex items-center justify-center flex-shrink-0" aria-hidden="true">
          <BookOpen size={15} />
        </span>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-foreground">Conocimiento de productos (bot) · {activeStore?.name}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            El "cerebro" de cada producto: qué es, para qué sirve, preguntas frecuentes y objeciones. El bot lo suma a su personalidad (pestaña <span className="font-medium text-foreground">Bot WhatsApp</span>) SOLO cuando el cliente compró ese producto.
          </p>
        </div>
        {edit === null && (
          <button
            type="button"
            onClick={() => setEdit({ mode: 'new' })}
            className="h-9 px-3 rounded-lg bg-accent text-accent-foreground text-sm font-medium flex items-center gap-1.5 hover:bg-accent/90 transition-colors shrink-0"
          >
            <Plus size={14} /> Agregar producto
          </button>
        )}
      </div>

      <div className="px-5 py-4 space-y-3">
        {/* Editor de alta (arriba de la lista) */}
        {edit?.mode === 'new' && (
          <ProductEditor
            storeId={activeStoreId!}
            productNames={productNames}
            onClose={() => setEdit(null)}
            onSaved={async () => { setEdit(null); await load(); }}
          />
        )}

        {rows.length === 0 && edit === null && (
          <div className="py-8 text-center text-sm text-muted-foreground">
            Todavía no cargaste productos. Tocá <span className="font-medium text-foreground">"Agregar producto"</span> para que el bot sepa de qué se trata cada uno.
          </div>
        )}

        {/* Lista de productos */}
        {rows.length > 0 && (
          <div className="rounded-lg border border-border divide-y divide-border overflow-hidden">
            {rows.map((r) => (
              <div key={r.id}>
                <div className="px-3 py-2.5 flex items-center gap-3 text-sm">
                  {r.image_url
                    ? <img src={r.image_url} alt="" loading="lazy" className="w-9 h-9 rounded object-cover border border-border shrink-0" />
                    : <div className="w-9 h-9 rounded bg-muted flex items-center justify-center shrink-0"><Package size={14} className="text-muted-foreground" /></div>}
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-foreground font-medium">{r.label}</div>
                    <div className="text-[10px] text-muted-foreground truncate">
                      {r.dropi_product_id ? <span className="font-mono">Dropi #{r.dropi_product_id} · </span> : null}
                      {r.match_text ? <>coincide con "{r.match_text}"</> : <span className="text-warning">sin coincidencia configurada</span>}
                    </div>
                  </div>
                  {!r.active && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground shrink-0">inactivo</span>}
                  <button
                    onClick={() => setEdit(edit?.mode === 'edit' && edit.row.id === r.id ? null : { mode: 'edit', row: r })}
                    className="h-7 px-2.5 rounded-lg border border-border bg-card text-xs font-medium text-foreground hover:bg-muted/40 shrink-0"
                  >
                    Configurar
                  </button>
                  <button
                    onClick={() => remove(r.id)}
                    title="Eliminar producto"
                    className="h-7 w-7 rounded-lg border border-border flex items-center justify-center text-muted-foreground hover:text-destructive hover:border-destructive/40 shrink-0"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
                {edit?.mode === 'edit' && edit.row.id === r.id && (
                  <div className="px-3 pb-3 pt-1 bg-muted/20">
                    <ProductEditor
                      storeId={activeStoreId!}
                      productNames={productNames}
                      row={r}
                      onClose={() => setEdit(null)}
                      onSaved={async () => { setEdit(null); await load(); }}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="rounded-lg border border-accent/20 bg-accent/5 px-3 py-2 text-[11px] text-muted-foreground">
          💡 <strong className="text-foreground">Cómo se combinan:</strong> la <strong className="text-foreground">personalidad y reglas generales</strong> viven en la pestaña <strong className="text-foreground">Bot WhatsApp</strong> (valen para todo); <strong className="text-foreground">acá</strong> va lo específico de cada producto. El bot junta las dos cosas y usa la ficha SOLO del producto que el cliente compró (lo cruza por el <strong>nombre</strong> de "coincide con"). Las reglas de seguridad (no inventar guía/estado) siguen activas siempre.
        </div>
      </div>
    </TiltCard>
    </motion.div>
  );
}

/** Formulario de alta/edición de una ficha de producto. */
function ProductEditor({
  storeId,
  productNames,
  row,
  onClose,
  onSaved,
}: {
  storeId: string;
  productNames: string[];
  row?: PkRow;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [label, setLabel] = useState(row?.label ?? '');
  const [matchText, setMatchText] = useState(row?.match_text ?? '');
  const [dropiId, setDropiId] = useState(row?.dropi_product_id != null ? String(row.dropi_product_id) : '');
  const [knowledge, setKnowledge] = useState(row?.knowledge ?? '');
  const [imageUrl, setImageUrl] = useState(row?.image_url ?? '');
  const [active, setActive] = useState(row?.active ?? true);
  const [saving, setSaving] = useState(false);

  const dlistId = `pk-products-${row?.id ?? 'new'}`;

  async function save() {
    if (!label.trim()) { toast.error('Ponle un nombre al producto.'); return; }
    if (!knowledge.trim()) { toast.error('Escribí qué es el producto (el conocimiento del bot).'); return; }
    const dRaw = dropiId.trim();
    let dId: number | null = null;
    if (dRaw) {
      const n = Number(dRaw);
      if (!Number.isInteger(n) || n <= 0) { toast.error('El ID de Dropi debe ser un número válido.'); return; }
      dId = n;
    }
    setSaving(true);
    const { error } = await rpc('upsert_product_knowledge', {
      p_store_id: storeId,
      p_id: row?.id ?? null,
      p_label: label.trim(),
      p_match_text: matchText.trim() || null,
      p_dropi_product_id: dId,
      p_knowledge: knowledge.trim(),
      p_image_url: imageUrl.trim() || null,
      p_active: active,
    });
    setSaving(false);
    if (error) { toast.error('No se pudo guardar', { description: error.message }); return; }
    toast.success(row ? 'Producto actualizado' : 'Producto agregado — el bot ya lo conoce');
    await onSaved();
  }

  // Traer del catálogo de Dropi: autocompleta nombre + ID + foto, y (si está
  // vacío) la descripción como conocimiento. El dueño edita después.
  function onPickDropi(id: number, _variationId: number | null, lbl: string, hit?: DropiProductHit) {
    const name = hit?.name || lbl;
    setDropiId(String(id));
    setLabel(name);
    setMatchText(name); // así el match por NOMBRE funciona ya (antes del match por ID, Fase B)
    if (hit?.image) setImageUrl(hit.image);
    if (hit?.description && !knowledge.trim()) setKnowledge(hit.description);
    toast.success(`Traído de Dropi: ${name} (#${id})`);
  }

  return (
    <div className="rounded-xl border border-border bg-card/40 p-4 space-y-3">
      <datalist id={dlistId}>
        {productNames.map((n) => <option key={n} value={n} />)}
      </datalist>

      {/* Traer de Dropi (recomendado): autocompleta nombre + ID + foto */}
      <div className="rounded-lg border border-accent/30 bg-accent/5 p-3">
        <div className="text-[11px] font-semibold text-foreground mb-1.5 flex items-center gap-1.5">
          <Package size={12} className="text-accent" /> Traer de Dropi (recomendado)
        </div>
        <DropiProductSearch storeId={storeId} onSelect={onPickDropi} />
        <div className="mt-2 flex items-center gap-3">
          {imageUrl && (
            <img
              src={imageUrl}
              alt=""
              className="h-14 w-14 rounded-lg object-cover border border-border shrink-0"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
            />
          )}
          <p className="text-[11px] text-muted-foreground">
            Buscá por nombre <strong className="text-foreground">o pegá el ID de Dropi</strong> y se autocompletan <strong className="text-foreground">nombre, foto y descripción</strong>. Después editá lo que quieras abajo.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="hud-label">Nombre del producto *</label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Ej: ClearZal Stop Dolor Total"
            className="mt-1 w-full h-10 rounded-lg border border-border bg-card px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </div>
        <div>
          <label className="hud-label">Coincide con (nombre en los pedidos)</label>
          <input
            type="text"
            list={dlistId}
            value={matchText}
            onChange={(e) => setMatchText(e.target.value)}
            placeholder="Elegí o escribí parte del nombre…"
            className="mt-1 w-full h-10 rounded-lg border border-border bg-card px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
          <p className="mt-1 text-[11px] text-muted-foreground">Cómo aparece el producto en tus pedidos. El bot lo cruza por aquí.</p>
        </div>
      </div>

      <div>
        <label className="hud-label">¿Qué sabe el bot de este producto? — su mini-prompt *</label>
        <textarea
          value={knowledge}
          onChange={(e) => setKnowledge(e.target.value)}
          placeholder={KNOWLEDGE_PLACEHOLDER}
          rows={9}
          className="mt-1 w-full rounded-lg border border-border bg-card px-3 py-2.5 text-sm text-foreground leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-accent/30"
        />
        <p className="mt-1 text-[11px] text-muted-foreground">
          Poné acá <strong className="text-foreground">todo lo de ESTE producto</strong>: qué es, para qué sirve, cómo se usa, preguntas frecuentes y objeciones (con cómo responderlas). La personalidad y las reglas generales NO van acá — van en <strong className="text-foreground">Bot WhatsApp</strong>.
        </p>
      </div>

      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground select-none">Opciones avanzadas (ID de Dropi, imagen, activo)</summary>
        <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="hud-label">ID de producto en Dropi (opcional)</label>
            <input
              inputMode="numeric"
              value={dropiId}
              onChange={(e) => setDropiId(e.target.value)}
              placeholder="Ej: 2034257"
              className="mt-1 w-full h-9 rounded-lg border border-border bg-card px-2 text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">Para match exacto a futuro. Hoy se usa el nombre.</p>
          </div>
          <div>
            <label className="hud-label">URL de imagen (opcional)</label>
            <input
              type="text"
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              placeholder="https://…"
              className="mt-1 w-full h-9 rounded-lg border border-border bg-card px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
          </div>
        </div>
        <label className="mt-3 flex items-center gap-2 text-xs text-foreground cursor-pointer">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="rounded border-border" />
          Activo (el bot usa este conocimiento)
        </label>
      </details>

      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          onClick={onClose}
          className="h-9 px-3 rounded-lg border border-border bg-card text-sm font-medium text-muted-foreground hover:bg-muted/40 flex items-center gap-1.5"
        >
          <X size={14} /> Cancelar
        </button>
        <button
          onClick={save}
          disabled={saving}
          className="h-9 px-4 rounded-lg bg-accent text-accent-foreground text-sm font-medium flex items-center gap-2 hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {row ? 'Guardar cambios' : 'Agregar producto'}
        </button>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { useStore } from '@/contexts/StoreContext';
import { useWaQuickReplies } from '@/hooks/useWaQuickReplies';
import { Zap, Plus, Save, Trash2, X, Loader2, Pencil } from 'lucide-react';
import { motion } from 'framer-motion';
import { TiltCard } from '@/components/ui3d';
import { toast } from 'sonner';

const fadeUp = { initial: { opacity: 0, y: 16 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.35, ease: 'easeOut' } };

/**
 * Gestión de respuestas rápidas del inbox de WhatsApp (/admin → "Bot WhatsApp").
 * Las asesoras las insertan de un clic en el composer del hilo. Solo managers
 * (owner/supervisor) las crean/editan/borran vía RPC (upsert/delete_wa_quick_reply);
 * cualquier miembro las LEE (las usa). Ver useWaQuickReplies + migración 20260626170000.
 */
export default function WaQuickRepliesPanel() {
  const { activeStore, activeStoreId, isManagerOfActive } = useStore();
  const { items, loading, save, remove } = useWaQuickReplies(isManagerOfActive ? activeStoreId : null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  if (!isManagerOfActive) {
    return (
      <div className="rounded-2xl border border-border bg-card/40 p-5 text-sm text-muted-foreground shadow-card3d hairline-top">
        Solo el dueño o supervisor de la tienda puede gestionar respuestas rápidas.
      </div>
    );
  }

  const resetForm = () => { setEditingId(null); setLabel(''); setBody(''); };

  const startEdit = (id: string, l: string, b: string) => { setEditingId(id); setLabel(l); setBody(b); };

  async function onSave() {
    if (!label.trim() || !body.trim()) { toast.error('Poné una etiqueta y un mensaje'); return; }
    setSaving(true);
    const res = await save({ id: editingId ?? undefined, label, body });
    setSaving(false);
    if (!res.ok) { toast.error('No se pudo guardar', { description: res.error }); return; }
    toast.success(editingId ? 'Respuesta actualizada' : 'Respuesta creada');
    resetForm();
  }

  async function onDelete(id: string) {
    setBusyId(id);
    const res = await remove(id);
    setBusyId(null);
    if (!res.ok) { toast.error('No se pudo borrar', { description: res.error }); return; }
    if (editingId === id) resetForm();
    toast.success('Respuesta borrada');
  }

  return (
    <motion.div {...fadeUp} className="">
    <TiltCard className="bg-card/40 border border-border rounded-2xl shadow-card3d">
      <div className="px-5 py-4 border-b border-border flex items-center gap-2">
        <span className="w-8 h-8 rounded-xl bg-accent/14 border border-accent/30 text-accent flex items-center justify-center flex-shrink-0" aria-hidden="true">
          <Zap size={15} />
        </span>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-foreground">Respuestas rápidas · {activeStore?.name}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Plantillas que las asesoras insertan de un clic en el chat (botón ⚡ del composer).
          </p>
        </div>
      </div>

      <div className="px-5 py-4 space-y-5">
        {/* Lista */}
        <div className="space-y-2">
          {loading ? (
            <div className="flex items-center justify-center py-4"><Loader2 className="animate-spin text-muted-foreground" size={18} /></div>
          ) : items.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border bg-background px-4 py-3 text-xs text-muted-foreground">
              Todavía no hay respuestas rápidas. Creá la primera abajo (ej. "Saludo", "Pedido en camino", "Recoger en oficina").
            </div>
          ) : (
            items.map((q) => (
              <div key={q.id} className="flex items-start justify-between gap-3 rounded-xl border border-border bg-card/40 px-4 py-2.5">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground truncate">{q.label}</div>
                  <div className="text-[11px] text-muted-foreground line-clamp-2 whitespace-pre-wrap">{q.body}</div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button" onClick={() => startEdit(q.id, q.label, q.body)}
                    className="h-8 w-8 inline-flex items-center justify-center rounded-lg border border-border text-muted-foreground hover:text-accent hover:border-accent/40 transition-colors"
                    aria-label="Editar"
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    type="button" onClick={() => void onDelete(q.id)} disabled={busyId === q.id}
                    className="h-8 w-8 inline-flex items-center justify-center rounded-lg border border-border text-muted-foreground hover:text-destructive hover:border-destructive/40 transition-colors disabled:opacity-50"
                    aria-label="Borrar"
                  >
                    {busyId === q.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Form alta/edición */}
        <div className="rounded-2xl border border-border bg-card/40 p-4 space-y-3 shadow-card3d hairline-top">
          <div className="text-sm font-medium text-foreground flex items-center gap-1.5">
            {editingId ? <><Pencil size={13} /> Editar respuesta</> : <><Plus size={13} /> Nueva respuesta</>}
          </div>
          <div>
            <label className="hud-label">Etiqueta (título corto)</label>
            <input
              type="text" value={label} onChange={e => setLabel(e.target.value)} placeholder="Ej: Pedido en camino"
              className="mt-1 w-full h-10 rounded-lg border border-border bg-card px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
          </div>
          <div>
            <label className="hud-label">Mensaje</label>
            <textarea
              value={body} onChange={e => setBody(e.target.value)} rows={3}
              placeholder="Ej: ¡Hola! Tu pedido ya va en camino 🚚. Apenas llegue a tu ciudad te lo entregan. ¿Te paso el link para rastrearlo?"
              className="mt-1 w-full rounded-lg border border-border bg-card px-3 py-2.5 text-sm text-foreground leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
          </div>
          <div className="flex items-center justify-end gap-2">
            {editingId && (
              <button
                type="button" onClick={resetForm}
                className="h-9 px-3 rounded-lg border border-border text-sm text-muted-foreground flex items-center gap-1.5 hover:bg-card transition-colors"
              >
                <X size={14} /> Cancelar
              </button>
            )}
            <button
              type="button" onClick={() => void onSave()} disabled={saving || !label.trim() || !body.trim()}
              className="h-9 px-4 rounded-lg bg-accent text-accent-foreground text-sm font-medium flex items-center gap-2 hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {editingId ? 'Guardar cambios' : 'Crear respuesta'}
            </button>
          </div>
        </div>
      </div>
    </TiltCard>
    </motion.div>
  );
}

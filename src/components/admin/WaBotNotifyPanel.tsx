import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { SupabaseClient } from '@supabase/supabase-js';
import { useStore } from '@/contexts/StoreContext';
import { Bell, Save, Loader2, Power } from 'lucide-react';
import { motion } from 'framer-motion';
import { TiltCard } from '@/components/ui3d';
import { toast } from 'sonner';

// wa_bot_config.notify aún no está en los tipos generados → cast sin `any`.
const sb = supabase as unknown as SupabaseClient;

const fadeUp = { initial: { opacity: 0, y: 16 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.35, ease: 'easeOut' } };

type Bucket = 'guia_generada' | 'en_camino' | 'reparto' | 'oficina' | 'novedad' | 'entregado';

const BUCKETS: { key: Bucket; label: string; hint: string }[] = [
  { key: 'guia_generada', label: 'Guía generada (manda número + link)', hint: 'Cuando Dropi genera la guía y prepara el pedido. Manda el número de guía real + link de rastreo.' },
  { key: 'en_camino', label: 'Va en camino / despachado', hint: 'Cuando el pedido sale de bodega y entra en tránsito.' },
  { key: 'reparto', label: 'Sale a reparto hoy', hint: 'Cuando el mensajero sale a entregarlo ese día.' },
  { key: 'oficina', label: 'Disponible en oficina (recoger)', hint: 'Cuando el pedido queda en una oficina para que el cliente lo recoja. Clave para que no se devuelva.' },
  { key: 'novedad', label: 'Novedad / problema', hint: 'Cuando hay una novedad de entrega (dirección, no estaba, etc.).' },
  { key: 'entregado', label: 'Entregado', hint: 'Cuando el pedido se marca como entregado.' },
];

// Deben coincidir con DEFAULT_TEMPLATES de la edge function wa-status-notifier.
const DEFAULT_TEMPLATES: Record<Bucket, string> = {
  guia_generada: '¡Buenas noticias {nombre}! 📦 Tu pedido de {producto} ya tiene guía y se está preparando con {transportadora}.\nTu número de guía es: {guia}\nLo podés rastrear acá: {link}\nCualquier cosa, acá estoy 💛 — {agente}',
  en_camino: '¡Hola {nombre}! 📦 Tu pedido de {producto} ya va en camino con {transportadora}. Lo podés seguir acá: {link}\nCualquier cosa me escribís, acá estoy 💛 — {agente}',
  reparto: '¡Hola {nombre}! 🚚 ¡Hoy sale tu pedido a entrega! Tené listo el pago contra entrega de {total}. Apenas llegue el mensajero te lo entrega. ¿Alguna duda? Acá estoy 💛 — {agente}',
  oficina: 'Hola {nombre} 📍 ¡Tu pedido de {producto} ya llegó a tu ciudad y está en oficina de {transportadora} para que lo recojas! Llevá tu cédula y ten listo el pago de {total}. Tu guía es {guia}. ¿Necesitás algo más? Acá estoy 💛 — {agente}',
  novedad: 'Hola {nombre} 🙏 Tu pedido tuvo una novedad con la entrega. ¿Me confirmás tu dirección y un horario en que estés, así lo reprogramamos y te llega bien? 📦',
  entregado: '¡Llegó tu pedido, {nombre}! 🎉 Espero que lo disfrutes muchísimo. Si necesitás cualquier cosa, acá sigo para ayudarte 💛 — {agente}',
};

interface NotifyState {
  enabled: boolean;
  buckets: Record<Bucket, boolean>;
  templates: Record<Bucket, string>;
}

const DEFAULT_STATE: NotifyState = {
  enabled: true,
  buckets: { guia_generada: true, en_camino: true, reparto: true, oficina: true, novedad: true, entregado: true },
  templates: { guia_generada: '', en_camino: '', reparto: '', oficina: '', novedad: '', entregado: '' },
};

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onClick}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${on ? 'bg-success' : 'bg-muted'}`}
    >
      <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${on ? 'translate-x-5' : 'translate-x-0.5'}`} />
    </button>
  );
}

/**
 * Avisos PROACTIVOS de WhatsApp (/admin → Bot WhatsApp).
 * El bot le escribe SOLO al cliente cuando su pedido cambia de estado en Dropi.
 * Guarda en wa_bot_config.notify (jsonb) vía upsert_wa_bot_notify. La edge
 * function wa-status-notifier (cron) lo lee y envía las plantillas.
 */
export default function WaBotNotifyPanel() {
  const { activeStoreId, isManagerOfActive } = useStore();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [st, setSt] = useState<NotifyState>(DEFAULT_STATE);
  const [savedJson, setSavedJson] = useState('');

  useEffect(() => {
    if (!activeStoreId || !isManagerOfActive) { setLoading(false); return; }
    let cancelled = false;
    void (async () => {
      setLoading(true);
      const { data } = await sb.from('wa_bot_config').select('notify').eq('store_id', activeStoreId).maybeSingle();
      if (cancelled) return;
      const raw = (data as { notify?: Partial<NotifyState> } | null)?.notify ?? null;
      const merged: NotifyState = raw && Object.keys(raw).length
        ? {
            enabled: raw.enabled ?? true,
            buckets: { ...DEFAULT_STATE.buckets, ...(raw.buckets ?? {}) },
            templates: { ...DEFAULT_STATE.templates, ...(raw.templates ?? {}) },
          }
        : DEFAULT_STATE;
      setSt(merged);
      setSavedJson(JSON.stringify(merged));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [activeStoreId, isManagerOfActive]);

  async function save() {
    if (!activeStoreId) return;
    setSaving(true);
    // Limpia plantillas vacías (la edge usa el default cuando falta).
    const templates: Record<string, string> = {};
    (Object.keys(st.templates) as Bucket[]).forEach((k) => {
      const v = st.templates[k].trim();
      if (v) templates[k] = v;
    });
    const payload = { enabled: st.enabled, buckets: st.buckets, templates };
    type RpcRes = { error: { message: string } | null };
    const { error } = await (supabase.rpc as unknown as (fn: string, args: Record<string, unknown>) => Promise<RpcRes>)(
      'upsert_wa_bot_notify',
      { p_store_id: activeStoreId, p_notify: payload },
    );
    setSaving(false);
    if (error) { toast.error('No se pudo guardar', { description: error.message }); return; }
    setSavedJson(JSON.stringify(st));
    toast.success('Avisos guardados');
  }

  if (!isManagerOfActive) return null;
  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-card p-5 flex items-center justify-center">
        <Loader2 className="animate-spin text-muted-foreground" size={18} />
      </div>
    );
  }

  const dirty = JSON.stringify(st) !== savedJson;

  return (
    <motion.div {...fadeUp} className="">
    <TiltCard className="bg-card/40 border border-border rounded-2xl shadow-card3d">
      <div className="px-5 py-4 border-b border-border flex items-center gap-2">
        <span className="w-8 h-8 rounded-xl bg-accent/14 border border-accent/30 text-accent flex items-center justify-center flex-shrink-0" aria-hidden="true">
          <Bell size={15} />
        </span>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-foreground">Avisos automáticos al cliente</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            El bot le escribe <strong>solo</strong> al cliente cuando su pedido cambia de estado en Dropi (una vez por cambio).
          </p>
        </div>
      </div>

      <div className="px-5 py-4 space-y-4">
        {/* Master switch */}
        <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card/40 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <Power size={15} className={st.enabled ? 'text-success' : 'text-muted-foreground'} />
            <div>
              <div className="text-sm font-medium text-foreground">Avisos activos</div>
              <div className="text-[11px] text-muted-foreground">
                {st.enabled ? 'El bot avisa solo en los momentos elegidos.' : 'Apagado: el bot no envía avisos automáticos.'}
              </div>
            </div>
          </div>
          <Toggle on={st.enabled} onClick={() => setSt(s => ({ ...s, enabled: !s.enabled }))} />
        </div>

        {/* Momentos + plantillas */}
        <div className={`space-y-3 ${st.enabled ? '' : 'opacity-50 pointer-events-none'}`}>
          {BUCKETS.map(b => (
            <div key={b.key} className="rounded-lg border border-border overflow-hidden">
              <div className="flex items-center justify-between gap-3 px-4 py-2.5 bg-background">
                <div>
                  <div className="text-sm font-medium text-foreground">{b.label}</div>
                  <div className="text-[11px] text-muted-foreground">{b.hint}</div>
                </div>
                <Toggle on={st.buckets[b.key]} onClick={() => setSt(s => ({ ...s, buckets: { ...s.buckets, [b.key]: !s.buckets[b.key] } }))} />
              </div>
              {st.buckets[b.key] && (
                <div className="px-4 py-3 border-t border-border">
                  <textarea
                    value={st.templates[b.key]}
                    onChange={e => setSt(s => ({ ...s, templates: { ...s.templates, [b.key]: e.target.value } }))}
                    placeholder={DEFAULT_TEMPLATES[b.key]}
                    rows={3}
                    className="w-full rounded-xl border border-border bg-card/40 px-3 py-2 text-sm text-foreground leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-accent/30"
                  />
                  <p className="mt-1 text-[11px] text-muted-foreground">Vacío = usa el mensaje por defecto que ves en gris.</p>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Leyenda de variables */}
        <div className="rounded-lg border border-accent/20 bg-accent/5 px-3 py-2 text-[11px] text-muted-foreground">
          <strong className="text-foreground">Variables que podés usar:</strong>{' '}
          <code className="bg-muted px-1 rounded">{'{nombre}'}</code>{' '}
          <code className="bg-muted px-1 rounded">{'{producto}'}</code>{' '}
          <code className="bg-muted px-1 rounded">{'{transportadora}'}</code>{' '}
          <code className="bg-muted px-1 rounded">{'{link}'}</code>{' '}
          <code className="bg-muted px-1 rounded">{'{total}'}</code>{' '}
          <code className="bg-muted px-1 rounded">{'{ciudad}'}</code>{' '}
          <code className="bg-muted px-1 rounded">{'{guia}'}</code>{' '}
          <code className="bg-muted px-1 rounded">{'{agente}'}</code>{' '}
          — se reemplazan con los datos reales del pedido.
        </div>

        <div className="flex items-center justify-between gap-3 pt-1 border-t border-border">
          <span className="text-[11px] text-muted-foreground">Se envían cada ~10 min cuando Dropi mueve el pedido.</span>
          <button
            onClick={save}
            disabled={saving || !dirty}
            className="h-9 px-4 rounded-lg bg-accent text-accent-foreground text-sm font-medium flex items-center gap-2 hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Guardar avisos
          </button>
        </div>
      </div>
    </TiltCard>
    </motion.div>
  );
}

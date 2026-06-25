import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { SupabaseClient } from '@supabase/supabase-js';
import { useStore } from '@/contexts/StoreContext';
import { Bot, Save, Loader2, Sparkles, Power, MessageSquare } from 'lucide-react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';

// wa_bot_config es nueva y aún no está en los tipos generados → cast sin `any`
// (mismo patrón que useWaConversations).
const sb = supabase as unknown as SupabaseClient;

const fadeUp = { initial: { opacity: 0, y: 16 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.35, ease: 'easeOut' } };

// Opciones de modelo (strings de kie.ai). value '' = usar el del sistema (secreto WA_AI_MODEL).
const MODEL_OPTIONS = [
  { value: '', label: 'Automático (según el secreto del sistema)' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5 — rápido y económico' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6 — equilibrado (recomendado)' },
  { value: 'claude-opus-4-5', label: 'Opus 4.5 — máxima calidad (más caro)' },
];

const PROMPT_PLACEHOLDER = `Ej: Sos Sara, asesora de seguimiento de "Mi Tienda". Acompañás al cliente con calidez hasta que reciba su pedido. Hablás en español colombiano, cercano y tranquilizador. Tu trabajo es informar el estado del pedido, mandar el link de rastreo cuando lo pidan, y dar tranquilidad si están impacientes. No vendés nada.`;

interface CfgRow {
  enabled: boolean;
  agent_name: string | null;
  model: string | null;
  system_prompt: string | null;
  greeting: string | null;
}

/**
 * Configurador del bot de WhatsApp POR TIENDA (/admin → "Bot WhatsApp").
 * Lee/escribe `wa_bot_config` vía RPC gated por is_store_manager. La IA
 * (wa-ai-responder) lee esta config EN VIVO → los cambios aplican al instante,
 * sin redeploy. Las reglas de seguridad las re-aplica siempre la edge function.
 */
export default function WaBotConfigPanel() {
  const { activeStore, activeStoreId, isManagerOfActive } = useStore();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [enabled, setEnabled] = useState(true);
  const [agentName, setAgentName] = useState('');
  const [model, setModel] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [greeting, setGreeting] = useState('');

  // snapshots para detectar cambios sin guardar
  const [saved, setSaved] = useState<CfgRow>({ enabled: true, agent_name: '', model: '', system_prompt: '', greeting: '' });

  useEffect(() => {
    if (!activeStoreId || !isManagerOfActive) { setLoading(false); return; }
    let cancelled = false;
    void (async () => {
      setLoading(true);
      const { data } = await sb
        .from('wa_bot_config')
        .select('enabled, agent_name, model, system_prompt, greeting')
        .eq('store_id', activeStoreId)
        .maybeSingle();
      if (cancelled) return;
      const row = (data as CfgRow | null) ?? null;
      const en = row?.enabled ?? true;
      const an = row?.agent_name ?? '';
      const md = row?.model ?? '';
      const sp = row?.system_prompt ?? '';
      const gr = row?.greeting ?? '';
      setEnabled(en); setAgentName(an); setModel(md); setSystemPrompt(sp); setGreeting(gr);
      setSaved({ enabled: en, agent_name: an, model: md, system_prompt: sp, greeting: gr });
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [activeStoreId, isManagerOfActive]);

  async function save() {
    if (!activeStoreId) return;
    setSaving(true);
    type RpcRes = { error: { message: string } | null };
    const { error } = await (supabase.rpc as unknown as (fn: string, args: Record<string, unknown>) => Promise<RpcRes>)(
      'upsert_wa_bot_config',
      {
        p_store_id: activeStoreId,
        p_enabled: enabled,
        p_agent_name: agentName.trim() || null,
        p_model: model.trim() || null,
        p_system_prompt: systemPrompt.trim() || null,
        p_greeting: greeting.trim() || null,
      },
    );
    setSaving(false);
    if (error) { toast.error('No se pudo guardar', { description: error.message }); return; }
    setSaved({ enabled, agent_name: agentName, model, system_prompt: systemPrompt, greeting });
    toast.success('Bot actualizado — aplica al instante, sin redeploy');
  }

  if (!isManagerOfActive) {
    return (
      <div className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
        Solo el dueño o supervisor de la tienda puede configurar el bot.
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

  const dirty =
    enabled !== saved.enabled ||
    agentName !== (saved.agent_name ?? '') ||
    model !== (saved.model ?? '') ||
    systemPrompt !== (saved.system_prompt ?? '') ||
    greeting !== (saved.greeting ?? '');

  return (
    <motion.div {...fadeUp} className="bg-card rounded-xl border border-border overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-border flex items-center gap-2">
        <Bot size={16} className="text-accent" />
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-foreground">Bot de WhatsApp · {activeStore?.name}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Personalizá cómo responde la IA de seguimiento. Los cambios aplican <strong>al instante</strong> (sin redeploy).
          </p>
        </div>
      </div>

      <div className="px-5 py-4 space-y-5">
        {/* Switch global on/off */}
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-4 py-3">
          <div className="flex items-center gap-2.5">
            <Power size={15} className={enabled ? 'text-success' : 'text-muted-foreground'} />
            <div>
              <div className="text-sm font-medium text-foreground">Bot activo</div>
              <div className="text-[11px] text-muted-foreground">
                {enabled ? 'La IA responde en los hilos con "IA ON".' : 'Apagado: la IA no responde en ninguna conversación de la tienda.'}
              </div>
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={() => setEnabled(v => !v)}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${enabled ? 'bg-success' : 'bg-muted'}`}
          >
            <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>

        {/* Nombre del asesor + modelo */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Nombre del asesor</label>
            <input
              type="text"
              value={agentName}
              onChange={e => setAgentName(e.target.value)}
              placeholder="Sara"
              className="mt-1 w-full h-10 rounded-lg border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">Con el que el bot se presenta. Vacío = "Sara".</p>
          </div>
          <div>
            <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1"><Sparkles size={10} /> Modelo de IA</label>
            <select
              value={model}
              onChange={e => setModel(e.target.value)}
              className="mt-1 w-full h-10 rounded-lg border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30"
            >
              {MODEL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <p className="mt-1 text-[11px] text-muted-foreground">Sonnet es más inteligente; Haiku más barato.</p>
          </div>
        </div>

        {/* Prompt / personalidad */}
        <div>
          <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Personalidad e instrucciones GENERALES (prompt)</label>
          <textarea
            value={systemPrompt}
            onChange={e => setSystemPrompt(e.target.value)}
            placeholder={PROMPT_PLACEHOLDER}
            rows={10}
            className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-foreground leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
          <div className="mt-1.5 rounded-lg border border-accent/20 bg-accent/5 px-3 py-2 text-[11px] text-muted-foreground">
            🔒 <strong className="text-foreground">Seguridad siempre activa:</strong> aunque dejes esto vacío o cambies todo, el bot
            <strong> nunca inventa</strong> estado/guía, <strong>escala a un humano</strong> ante enojo o reclamos de dinero, y <strong>no vende</strong> nada.
            Esas reglas se aplican solas. Acá definís tono y estilo. Vacío = usa la personalidad por defecto de seguimiento.
            <br /><br />
            👉 Esto es la <strong className="text-foreground">personalidad y reglas GENERALES</strong> (valen para todos los productos). Lo específico de cada producto —qué es, preguntas y objeciones— va en la pestaña <strong className="text-foreground">Productos (bot)</strong>; el bot lo suma solo cuando el cliente compró ese producto.
          </div>
        </div>

        {/* Saludo */}
        <div>
          <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1"><MessageSquare size={10} /> Saludo (opcional)</label>
          <textarea
            value={greeting}
            onChange={e => setGreeting(e.target.value)}
            placeholder="¡Hola! Soy Sara de Mi Tienda 💛 ¿En qué te ayudo con tu pedido?"
            rows={2}
            className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-foreground resize-y focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
          <p className="mt-1 text-[11px] text-muted-foreground">Cómo abre la conversación cuando es el primer mensaje del cliente.</p>
        </div>

        {/* Guardar */}
        <div className="flex items-center justify-between gap-3 pt-1 border-t border-border">
          <span className="text-[11px] text-muted-foreground">
            Probalo en <strong className="text-foreground">/seguimiento → WhatsApp</strong> con un hilo en "IA ON".
          </span>
          <button
            onClick={save}
            disabled={saving || !dirty}
            className="h-9 px-4 rounded-lg bg-accent text-accent-foreground text-sm font-medium flex items-center gap-2 hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Guardar configuración
          </button>
        </div>
      </div>
    </motion.div>
  );
}

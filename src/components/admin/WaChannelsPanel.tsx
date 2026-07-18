import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { SupabaseClient } from '@supabase/supabase-js';
import { useStore } from '@/contexts/StoreContext';
import { Smartphone, Plug, Save, Loader2, QrCode, Copy, CheckCircle2, RefreshCw } from 'lucide-react';
import { motion } from 'framer-motion';
import { TiltCard } from '@/components/ui3d';
import { toast } from 'sonner';

// wa_channels RPCs no están en los tipos generados → cast sin `any`
// (mismo patrón que WaBotConfigPanel / useWaConversations).
const sb = supabase as unknown as SupabaseClient;

const fadeUp = { initial: { opacity: 0, y: 16 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.35, ease: 'easeOut' } };

interface ChannelStatus {
  channel_id: string;
  provider: string;
  phone_number: string | null;
  status: string;
  updated_at: string;
}

const STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  connected: { label: 'Conectado', cls: 'bg-success/10 text-success border-success/20' },
  qr_pending: { label: 'Esperando QR', cls: 'bg-amber-500/10 text-amber-600 border-amber-500/20' },
  disconnected: { label: 'Desconectado', cls: 'bg-destructive/10 text-destructive border-destructive/20' },
};

/**
 * Alta/gestión del CANAL de WhatsApp por tienda (/admin → "Canales WhatsApp").
 * Es la conexión al gateway (distinto del "Bot WhatsApp", que es la personalidad).
 *
 * El QR se escanea en el panel propio del gateway (Manager de Evolution, o el
 * dashboard de Whapi). Acá se REGISTRA el canal (proveedor, URL, token, instancia,
 * número) vía RPC `upsert_wa_channel` (owner-only). El estado sale de
 * `get_wa_channel_status`. La edge function lee el canal con service role.
 */
export default function WaChannelsPanel() {
  const { activeStore, activeStoreId, isManagerOfActive, isOwnerOfActive } = useStore();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [channels, setChannels] = useState<ChannelStatus[]>([]);

  const [provider, setProvider] = useState<'evolution' | 'whapi' | 'waha'>('evolution');
  const [base, setBase] = useState('');
  const [token, setToken] = useState('');
  const [instance, setInstance] = useState('');
  const [phone, setPhone] = useState('');
  const [copied, setCopied] = useState(false);

  const loadChannels = useCallback(async () => {
    if (!activeStoreId || !isManagerOfActive) { setLoading(false); return; }
    setLoading(true);
    const { data } = await (supabase.rpc as unknown as (fn: string, args: Record<string, unknown>) => Promise<{ data: ChannelStatus[] | null }>)(
      'get_wa_channel_status', { p_store_id: activeStoreId },
    );
    setChannels(Array.isArray(data) ? data : []);
    setLoading(false);
  }, [activeStoreId, isManagerOfActive]);

  useEffect(() => { void loadChannels(); }, [loadChannels]);

  // Webhook que hay que configurar en el gateway (Evolution/Whapi) para ESTA tienda.
  // El secreto NO se muestra (es server-side) — va como placeholder a reemplazar.
  const supaUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined) || '';
  const webhookUrl = supaUrl && activeStoreId
    ? `${supaUrl}/functions/v1/wa-webhook?secret=<WA_WEBHOOK_SECRET>&store_id=${activeStoreId}`
    : '';

  // Evolution y WAHA son gateways "server propio" (URL + sesión/instancia + token).
  // Whapi es manejado (solo token). isServer agrupa los dos primeros para la UI.
  const isServer = provider === 'evolution' || provider === 'waha';

  async function save() {
    if (!activeStoreId) return;
    const tk = token.trim();
    if (!tk) { toast.error('Falta el token / API key del gateway'); return; }
    if (!phone.trim()) { toast.error('Falta el número de teléfono del canal'); return; }
    if (isServer && (!base.trim() || !instance.trim())) {
      toast.error('Para Evolution/WAHA: URL del server e instancia/sesión son obligatorios'); return;
    }
    setSaving(true);
    type RpcRes = { error: { message: string } | null };
    const { error } = await (supabase.rpc as unknown as (fn: string, args: Record<string, unknown>) => Promise<RpcRes>)(
      'upsert_wa_channel',
      {
        p_store_id: activeStoreId,
        p_provider: provider,
        p_provider_token: tk,
        p_provider_base: base.trim() || null,
        p_instance_name: instance.trim() || null,
        p_phone_number: phone.trim() || null,
      },
    );
    setSaving(false);
    if (error) { toast.error('No se pudo guardar el canal', { description: error.message }); return; }
    toast.success('Canal registrado — escaneá el QR en el gateway si aún no lo hiciste');
    setToken('');
    void loadChannels();
  }

  function copyWebhook() {
    if (!webhookUrl) return;
    void navigator.clipboard.writeText(webhookUrl).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 1500);
    });
  }

  if (!isManagerOfActive) {
    return (
      <div className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
        Solo el dueño o supervisor de la tienda puede ver los canales de WhatsApp.
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
          <Smartphone size={15} />
        </span>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-foreground">Canales WhatsApp · {activeStore?.name}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            La conexión al gateway. El QR se escanea en el panel del gateway; acá registrás el canal.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadChannels()}
          className="h-8 px-2.5 rounded-lg border border-border text-xs text-muted-foreground flex items-center gap-1.5 hover:bg-background transition-colors"
        >
          <RefreshCw size={13} /> Refrescar
        </button>
      </div>

      <div className="px-5 py-4 space-y-5">
        {/* Lista de canales */}
        <div className="space-y-2">
          {channels.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border bg-background px-4 py-3 text-xs text-muted-foreground">
              Esta tienda no tiene ningún canal de WhatsApp todavía. Registrá uno abajo.
            </div>
          ) : channels.map((c) => {
            const st = STATUS_STYLE[c.status] || { label: c.status, cls: 'bg-muted text-muted-foreground border-border' };
            return (
              <div key={c.channel_id} className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card/40 px-4 py-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <Plug size={15} className="text-muted-foreground shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground truncate">
                      {c.phone_number || '(sin número)'} <span className="text-[11px] text-muted-foreground">· {c.provider}</span>
                    </div>
                    <div className="text-[11px] text-muted-foreground">Actualizado {new Date(c.updated_at).toLocaleString()}</div>
                  </div>
                </div>
                <span className={`shrink-0 text-[11px] font-medium px-2 py-1 rounded-full border ${st.cls}`}>{st.label}</span>
              </div>
            );
          })}
        </div>

        {/* Webhook a configurar en el gateway */}
        {webhookUrl && (
          <div className="rounded-lg border border-accent/20 bg-accent/5 px-3 py-2.5">
            <div className="hud-label mb-1 flex items-center gap-1">
              <QrCode size={11} /> Webhook a configurar en el gateway {provider === 'waha' ? '(WAHA: evento "message")' : '(evento messages.upsert, webhookByEvents = false)'}
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-[11px] text-foreground bg-background rounded px-2 py-1.5 border border-border break-all">{webhookUrl}</code>
              <button type="button" onClick={copyWebhook} className="h-8 px-2.5 rounded-lg border border-border text-xs flex items-center gap-1.5 hover:bg-background transition-colors shrink-0">
                {copied ? <CheckCircle2 size={13} className="text-success" /> : <Copy size={13} />} {copied ? 'Copiado' : 'Copiar'}
              </button>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">Reemplazá <code>&lt;WA_WEBHOOK_SECRET&gt;</code> por el secreto real (server-side). El <code>store_id</code> ya está puesto para esta tienda.</p>
          </div>
        )}

        {/* Form de alta (solo dueño) */}
        {!isOwnerOfActive ? (
          <div className="rounded-xl border border-border bg-card/40 px-4 py-3 text-xs text-muted-foreground">
            Solo el <strong>dueño</strong> de la tienda puede registrar o editar el canal.
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-card/40 p-4 space-y-4">
            <div className="text-sm font-medium text-foreground">Registrar / actualizar canal</div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="hud-label">Proveedor</label>
                <select
                  value={provider}
                  onChange={e => setProvider(e.target.value as 'evolution' | 'whapi' | 'waha')}
                  className="mt-1 w-full h-10 rounded-lg border border-border bg-card px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30"
                >
                  <option value="waha">WAHA (server propio · WhatsApp Web)</option>
                  <option value="evolution">Evolution (server propio)</option>
                  <option value="whapi">Whapi</option>
                </select>
              </div>
              <div>
                <label className="hud-label">Número (con código país)</label>
                <input
                  type="text" value={phone} onChange={e => setPhone(e.target.value)} placeholder="573164291009"
                  className="mt-1 w-full h-10 rounded-lg border border-border bg-card px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30"
                />
              </div>
            </div>

            {isServer && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="hud-label">
                    {provider === 'waha' ? 'URL del server WAHA' : 'URL del server Evolution'}
                  </label>
                  <input
                    type="text" value={base} onChange={e => setBase(e.target.value)}
                    placeholder={provider === 'waha' ? 'https://tu-server/waha' : 'https://bot.tudominio.com'}
                    className="mt-1 w-full h-10 rounded-lg border border-border bg-card px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30"
                  />
                </div>
                <div>
                  <label className="hud-label">
                    {provider === 'waha' ? 'Sesión (session name)' : 'Instancia (instance name)'}
                  </label>
                  <input
                    type="text" value={instance} onChange={e => setInstance(e.target.value)}
                    placeholder={provider === 'waha' ? 'default' : 'rushmira-co'}
                    className="mt-1 w-full h-10 rounded-lg border border-border bg-card px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30"
                  />
                </div>
              </div>
            )}

            <div>
              <label className="hud-label">
                {provider === 'evolution' ? 'API key de Evolution (apikey)' : provider === 'waha' ? 'API key de WAHA (X-Api-Key)' : 'Token de Whapi (Bearer)'}
              </label>
              <input
                type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="••••••••••••••••"
                autoComplete="off"
                className="mt-1 w-full h-10 rounded-lg border border-border bg-card px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">Se guarda como secreto (solo lo lee el servidor). No se vuelve a mostrar.</p>
            </div>

            {isServer && (
              <div className="rounded-lg border border-accent/20 bg-accent/5 px-3 py-2 text-[11px] text-muted-foreground">
                {provider === 'waha' ? (
                  <>
                    📲 <strong className="text-foreground">Para conectar el número:</strong> en el dashboard de WAHA
                    (<code>{base.trim() ? `${base.trim().replace(/\/+$/, '')}/dashboard` : '<URL>/dashboard'}</code>) usá la sesión
                    <strong> "{instance.trim() || 'default'}"</strong>, escaneá su QR con el WhatsApp del número, configurá el webhook de arriba (evento <code>message</code>), y registrá acá el canal.
                  </>
                ) : (
                  <>
                    📲 <strong className="text-foreground">Para conectar el número:</strong> en el Manager de Evolution
                    (<code>{base.trim() ? `${base.trim().replace(/\/+$/, '')}/manager` : '<URL>/manager'}</code>) creá la instancia
                    <strong> "{instance.trim() || '...'}"</strong>, escaneá su QR con el WhatsApp del número, configurá el webhook de arriba, y registrá acá el canal.
                  </>
                )}
              </div>
            )}

            <div className="flex justify-end pt-1 border-t border-border">
              <button
                onClick={save}
                disabled={saving}
                className="h-9 px-4 rounded-lg bg-accent text-accent-foreground text-sm font-medium flex items-center gap-2 hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                Guardar canal
              </button>
            </div>
          </div>
        )}
      </div>
    </TiltCard>
    </motion.div>
  );
}

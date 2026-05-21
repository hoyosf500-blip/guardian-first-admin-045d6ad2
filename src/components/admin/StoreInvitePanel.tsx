import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useStore } from '@/contexts/StoreContext';
import { UserPlus, Loader2, Copy, Check, Link2 } from 'lucide-react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';

const fadeUp = { initial: { opacity: 0, y: 16 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.35, ease: 'easeOut' } };

/**
 * Panel "Invitar operadora" (solo dueño de la tienda activa).
 * Genera un link de invitación atado a ESTA tienda vía RPC create_store_invite.
 * La invitada se registra por el link y queda como operadora SOLO de esta tienda
 * (ver migración 20260521120000_store_invites.sql + redención en ProtectedLayout).
 */
export default function StoreInvitePanel() {
  const { activeStore, activeStoreId, isOwnerOfActive } = useStore();
  const [generating, setGenerating] = useState(false);
  const [link, setLink] = useState('');
  const [copied, setCopied] = useState(false);

  // Solo el dueño de la tienda activa puede invitar.
  if (!activeStore || !isOwnerOfActive) return null;

  async function generate() {
    if (!activeStoreId) return;
    setGenerating(true);
    setLink('');
    setCopied(false);
    type RpcRes = { data: string | null; error: { message: string } | null };
    const { data, error } = await (supabase.rpc as unknown as (fn: string, args: Record<string, unknown>) => Promise<RpcRes>)(
      'create_store_invite',
      { p_store_id: activeStoreId, p_role: 'operator' },
    );
    setGenerating(false);
    if (error || !data) {
      toast.error('No se pudo generar el link', { description: error?.message });
      return;
    }
    setLink(`${window.location.origin}/auth?invite=${data}`);
    toast.success('Link de invitación generado');
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('No se pudo copiar — seleccioná y copiá manualmente');
    }
  }

  return (
    <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.04 }} className="bg-card rounded-xl border border-border overflow-hidden md:col-span-2">
      <div className="px-5 py-4 border-b border-border flex items-center gap-2">
        <UserPlus size={16} className="text-primary" />
        <div>
          <h3 className="text-sm font-semibold text-foreground">Invitar operadora · {activeStore.name}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Generá un link y mandáselo. Al registrarse queda como operadora <span className="font-medium text-foreground">solo de {activeStore.name}</span> — no puede ver otras tiendas. El link vence en 7 días y sirve una sola vez.
          </p>
        </div>
      </div>

      <div className="px-5 py-4 space-y-3">
        <button
          onClick={generate}
          disabled={generating}
          className="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium flex items-center gap-2 hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {generating ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />}
          {generating ? 'Generando…' : 'Generar link de invitación'}
        </button>

        {link && (
          <div className="flex items-stretch gap-2">
            <input
              readOnly
              value={link}
              onFocus={e => e.currentTarget.select()}
              className="flex-1 h-10 rounded-lg border border-border bg-background px-3 text-xs font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            <button
              onClick={copy}
              className="h-10 px-3 rounded-lg border border-border bg-secondary text-secondary-foreground text-xs font-medium flex items-center gap-2 hover:bg-secondary/80 transition-colors"
            >
              {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
              {copied ? 'Copiado' : 'Copiar'}
            </button>
          </div>
        )}
      </div>
    </motion.div>
  );
}

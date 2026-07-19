import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useStore } from '@/contexts/StoreContext';
import { UserPlus, Loader2, Copy, Check, Link2 } from 'lucide-react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { TiltCard } from '@/components/ui3d';

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
  const [role, setRole] = useState<'operator' | 'supervisor'>('operator');

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
      { p_store_id: activeStoreId, p_role: role },
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
    <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.04 }} className="md:col-span-2">
    <TiltCard className="bg-card/40 border border-border rounded-2xl shadow-card3d">
      <div className="px-5 py-4 border-b border-border flex items-center gap-2.5">
        <span className="w-9 h-9 rounded-xl bg-accent/14 border border-accent/30 text-accent glow-accent flex items-center justify-center flex-shrink-0" aria-hidden="true">
          <UserPlus size={15} />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">Invitar a tu equipo · {activeStore.name}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Elegí el rol, generá el link y mandáselo. Al registrarse queda <span className="font-medium text-foreground">solo en {activeStore.name}</span> con ese rol — no ve otras tiendas. El link vence en 7 días y sirve una sola vez.
          </p>
        </div>
      </div>

      <div className="px-5 py-4 space-y-3">
        <div>
          <label className="hud-label" htmlFor="invite-role">Rol de la invitación</label>
          <select
            id="invite-role"
            value={role}
            onChange={e => { setRole(e.target.value as 'operator' | 'supervisor'); setLink(''); }}
            className="mt-1 w-full h-10 rounded-xl border border-border bg-card/40 px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30"
          >
            <option value="operator">Operadora — solo Confirmar / Seguimiento / Novedades</option>
            <option value="supervisor">Supervisor — además Admin y Logística (no CFO)</option>
          </select>
        </div>
        <button
          onClick={generate}
          disabled={generating}
          className="btn-accent-3d h-9 px-4 rounded-xl text-sm font-semibold flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
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
              className="flex-1 h-10 rounded-xl border border-border bg-card/40 px-3 text-xs font-mono tabular-nums text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
            <button
              onClick={copy}
              className="h-10 px-3 rounded-xl border border-border bg-card/40 text-muted-foreground hover:text-foreground hover:border-border-strong text-xs font-medium flex items-center gap-2 transition-colors"
            >
              {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
              {copied ? 'Copiado' : 'Copiar'}
            </button>
          </div>
        )}
      </div>
    </TiltCard>
    </motion.div>
  );
}

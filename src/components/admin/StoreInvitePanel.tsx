import { useCallback, useEffect, useState } from 'react';
import { appBaseUrl } from '@/lib/appUrl';
import { supabase } from '@/integrations/supabase/client';
import { useStore } from '@/contexts/StoreContext';
import { UserPlus, Loader2, Copy, Check, Link2 } from 'lucide-react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { TiltCard } from '@/components/ui3d';
import { isRpcMissing } from '@/lib/rpcError';

/** Invitación vigente (sin usar, sin vencer) — shape de la RPC list_store_invites. */
interface InviteRow {
  id: string;
  role: string;
  email: string | null;
  created_at: string;
  expires_at: string;
}

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
  // Invitaciones vigentes de la tienda (auditoría 2026-08-13: un link generado
  // por error quedaba vivo 7 días sin forma de anularlo). `soportado=false` =
  // la RPC list_store_invites aún no está aplicada en la base → el panel
  // degrada al comportamiento anterior (solo generar) sin romperse.
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [soportado, setSoportado] = useState(true);
  const [revoking, setRevoking] = useState<string | null>(null);

  const loadInvites = useCallback(async () => {
    if (!activeStoreId || !isOwnerOfActive) return;
    type Res = { data: InviteRow[] | null; error: { message: string; code?: string } | null };
    const { data, error } = await (supabase.rpc as unknown as (fn: string, args: Record<string, unknown>) => Promise<Res>)(
      'list_store_invites',
      { p_store_id: activeStoreId },
    );
    if (error) {
      if (isRpcMissing(error)) setSoportado(false);
      return;
    }
    setSoportado(true);
    setInvites(data ?? []);
  }, [activeStoreId, isOwnerOfActive]);

  useEffect(() => { loadInvites(); }, [loadInvites]);

  // Solo el dueño de la tienda activa puede invitar.
  if (!activeStore || !isOwnerOfActive) return null;

  async function revocar(id: string) {
    setRevoking(id);
    type Res = { error: { message: string; code?: string } | null };
    const { error } = await (supabase.rpc as unknown as (fn: string, args: Record<string, unknown>) => Promise<Res>)(
      'revoke_store_invite',
      { p_invite_id: id },
    );
    setRevoking(null);
    if (error) {
      toast.error('No se pudo revocar la invitación', { description: error.message });
      return;
    }
    toast.success('Invitación revocada — el link ya no sirve');
    loadInvites();
  }

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
    // Origen CANÓNICO configurable: si el dueño genera el link desde un preview
    // de Lovable, un staging o localhost, `window.location.origin` produciría un
    // link que su equipo no puede abrir. VITE_PUBLIC_APP_URL fija el dominio de
    // producción; si no está seteada, cae al origen actual (comportamiento previo).
    const base = appBaseUrl();
    setLink(`${base}/auth?invite=${data}`);
    toast.success('Link de invitación generado');
    loadInvites();
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

        {soportado && invites.length > 0 && (
          <div className="pt-1">
            <div className="hud-label mb-1.5">Invitaciones vigentes · {invites.length}</div>
            <div className="space-y-1.5">
              {invites.map(inv => {
                const dias = Math.max(0, Math.ceil((Date.parse(inv.expires_at) - Date.now()) / 86400000));
                return (
                  <div key={inv.id} className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl bg-card/40 border border-border">
                    <div className="min-w-0 text-xs text-foreground truncate">
                      <span className="font-semibold">{inv.role === 'supervisor' ? 'Supervisor' : 'Operadora'}</span>
                      <span className="text-muted-foreground"> · vence {dias === 0 ? 'hoy' : `en ${dias} día${dias === 1 ? '' : 's'}`}</span>
                    </div>
                    <button
                      onClick={() => revocar(inv.id)}
                      disabled={revoking === inv.id}
                      className="h-8 px-2.5 rounded-lg border border-red/40 text-red hover:bg-red/5 text-[11px] font-semibold transition-colors disabled:opacity-50 flex-shrink-0"
                    >
                      {revoking === inv.id ? 'Revocando…' : 'Revocar'}
                    </button>
                  </div>
                );
              })}
            </div>
            <p className="text-[10px] text-muted-foreground mt-1.5">
              Revocar mata el link al instante — útil si lo mandaste al chat equivocado o con el rol equivocado.
            </p>
          </div>
        )}
      </div>
    </TiltCard>
    </motion.div>
  );
}

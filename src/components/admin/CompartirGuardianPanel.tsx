import { useState } from 'react';
import { appBaseUrl } from '@/lib/appUrl';
import { toast } from 'sonner';
import { Share2, Copy, Check } from 'lucide-react';
import { TiltCard } from '@/components/ui3d';

/**
 * Compartir Guardian con un AMIGO que va a abrir su propia tienda.
 *
 * Distinto de StoreInvitePanel (que invita OPERADORAS a TU tienda): esto entrega
 * el link de alta autoservicio `/registro`, donde el amigo crea SU cuenta y SU
 * tienda (queda de dueño, aislado). Antes ese link no existía en ninguna parte
 * de la app y había que tipearlo de memoria (auditoría 2026-08-13).
 *
 * Origen canónico: VITE_PUBLIC_APP_URL (para no generar un link de preview/
 * localhost), con fallback al origen actual. Mismo criterio que el link de invite.
 */
export default function CompartirGuardianPanel() {
  const [copied, setCopied] = useState(false);
  const base = appBaseUrl();
  const link = `${base}/registro`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      toast.success('Link de registro copiado');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('No se pudo copiar; seleccioná y copiá el link a mano');
    }
  }

  return (
    <TiltCard className="bg-card/40 border border-border rounded-2xl shadow-card3d">
      <div className="px-5 py-4 border-b border-border flex items-center gap-2.5">
        <span className="w-9 h-9 rounded-xl bg-accent/14 border border-accent/30 text-accent glow-accent flex items-center justify-center flex-shrink-0" aria-hidden="true">
          <Share2 size={15} />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">Compartir Guardian</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Enviale este link a un amigo para que abra su propia tienda (crea su cuenta y queda de dueño).
          </p>
        </div>
      </div>
      <div className="px-5 py-4 flex items-center gap-2 flex-wrap">
        <input
          readOnly
          value={link}
          onFocus={(e) => e.currentTarget.select()}
          className="flex-1 min-w-0 rounded-xl border border-border bg-background px-3 py-2.5 text-xs font-mono text-foreground"
        />
        <button
          type="button"
          onClick={() => void copy()}
          className="inline-flex items-center gap-2 px-4 h-11 rounded-xl bg-accent text-accent-foreground text-sm font-semibold hover:opacity-90 transition cursor-pointer"
        >
          {copied ? <Check size={15} /> : <Copy size={15} />}
          {copied ? 'Copiado' : 'Copiar link'}
        </button>
      </div>
    </TiltCard>
  );
}

import { useState } from 'react';
import { Store, Loader2, Package } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

/**
 * Pantalla de alta autoservicio: un usuario registrado SIN tiendas crea la
 * suya y queda de owner (RPC `create_my_store`, migración 20260730120000).
 * Reemplaza el callejón "Sin tiendas asignadas" ahora que Guardian se abre a
 * terceros — el flujo completo queda: registro → crear tienda → SetupWizard
 * (pide su api key de Dropi) → adentro.
 *
 * El camino de INVITACIÓN sigue intacto: si vino con ?invite=TOKEN,
 * ProtectedLayout lo canjea antes y esta pantalla ni se muestra.
 */
export default function CreateStoreScreen({ onCreated, onSignOut }: {
  onCreated: () => void | Promise<void>;
  onSignOut: () => void;
}) {
  const [name, setName] = useState('');
  const [country, setCountry] = useState<'CO' | 'EC'>('CO');
  const [busy, setBusy] = useState(false);

  const crear = async () => {
    const nombre = name.trim();
    if (nombre.length < 2) {
      toast.error('Poné el nombre de tu tienda (mínimo 2 letras)');
      return;
    }
    setBusy(true);
    try {
      // El binding directo pierde `this` (ver memoria rpc_supabase_binding_pattern).
      type Rpc = (fn: string, p: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
      const rpc = supabase.rpc.bind(supabase) as unknown as Rpc;
      const { error } = await rpc('create_my_store', { p_name: nombre, p_country_code: country });
      if (error) {
        // El mensaje de la RPC ya viene en español y accionable.
        toast.error(error.message.replace(/^.*Exception: /, ''));
        return;
      }
      toast.success(`¡Tienda "${nombre}" creada! Ahora configurá tu conexión con Dropi.`);
      await onCreated();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="max-w-md w-full bg-card border border-border rounded-2xl p-8 space-y-5">
        <div className="text-center space-y-2">
          <div className="w-12 h-12 rounded-xl bg-accent/15 border border-accent/30 flex items-center justify-center mx-auto">
            <Store size={22} className="text-accent" aria-hidden="true" />
          </div>
          <h1 className="text-lg font-bold text-foreground">Creá tu tienda</h1>
          <p className="text-sm text-muted-foreground">
            Vas a ser el dueño: tus pedidos y tus datos son privados de tu tienda.
            Después te pedimos la conexión con Dropi.
          </p>
        </div>

        <div className="space-y-3 text-left">
          <div>
            <label htmlFor="store-name" className="block text-xs font-semibold text-muted-foreground mb-1">
              Nombre de la tienda
            </label>
            <input
              id="store-name"
              type="text"
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void crear(); }}
              placeholder="Ej: Tienda de Carlos"
              className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/60 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
            />
          </div>
          <div>
            <label htmlFor="store-country" className="block text-xs font-semibold text-muted-foreground mb-1">
              País de operación
            </label>
            <select
              id="store-country"
              value={country}
              onChange={(e) => setCountry(e.target.value === 'EC' ? 'EC' : 'CO')}
              className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none cursor-pointer"
            >
              <option value="CO">Colombia (Dropi CO)</option>
              <option value="EC">Ecuador (Dropi EC)</option>
            </select>
          </div>
        </div>

        <button
          type="button"
          onClick={() => void crear()}
          disabled={busy}
          className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-accent text-accent-foreground font-bold py-3 text-sm hover:bg-accent/90 transition-colors disabled:opacity-60 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
        >
          {busy ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Package size={15} aria-hidden="true" />}
          {busy ? 'Creando…' : 'Crear mi tienda'}
        </button>

        <div className="pt-1 border-t border-border/60 text-center space-y-2">
          <p className="text-[11px] text-muted-foreground pt-2">
            ¿Te invitaron a una tienda que ya existe? Entrá con el <strong className="text-foreground/80">link de invitación</strong> que
            te pasó el dueño y quedás adentro sin crear nada.
          </p>
          <button onClick={onSignOut} className="text-xs text-muted-foreground hover:text-foreground cursor-pointer">
            Cerrar sesión
          </button>
        </div>
      </div>
    </div>
  );
}

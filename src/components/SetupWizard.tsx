import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useStore } from '@/contexts/StoreContext';
import { Package, Loader2, CheckCircle2, ExternalLink } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';

interface FieldDef {
  key: 'dropi_api_key' | 'dropi_session_token' | 'dropi_store_url' | 'brand_logo_url' | 'name';
  label: string;
  hint?: string;
  required: boolean;
  type?: 'text' | 'password' | 'url';
}

const FIELDS: FieldDef[] = [
  { key: 'name',                 label: 'Nombre de la tienda',       required: true,  hint: 'Ej. "Rushmira (Colombia)" — aparece en el sidebar.' },
  { key: 'dropi_api_key',        label: 'API Key de Dropi (Bearer)', required: true,  type: 'password', hint: 'Token permanente. En Dropi → Configuración → API.' },
  { key: 'dropi_session_token',  label: 'Token de sesión Dropi',     required: true,  type: 'password', hint: 'JWT del navegador. DevTools → Network → header x-authorization en cualquier request a api.dropi.co. Vence cada ~12-24h.' },
  { key: 'dropi_store_url',      label: 'URL de integración Dropi',  required: true,  type: 'url',      hint: 'URL del tipo de integración (ej: https://rushmira.com/). NO es la URL pública de tu tienda.' },
  { key: 'brand_logo_url',       label: 'URL del logo (opcional)',   required: false, type: 'url' },
];

/**
 * Wizard POR-TIENDA. Se muestra al owner cuando la tienda activa no tiene
 * dropi_api_key cargada. Escribe vía RPCs `upsert_store_dropi_config` y
 * `update_store_branding` (ambas validan ownership server-side).
 */
export default function SetupWizard({ onDone }: { onDone: () => void }) {
  const { activeStore, isOwnerOfActive, refresh } = useStore();
  const [vals, setVals] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!activeStore || !isOwnerOfActive) { setLoading(false); return; }
    let cancelled = false;
    void (async () => {
      const { data: cfg } = await supabase
        .from('store_dropi_config')
        .select('dropi_api_key, dropi_session_token, dropi_store_url')
        .eq('store_id', activeStore.id)
        .maybeSingle();
      if (cancelled) return;
      setVals({
        name: activeStore.name,
        brand_logo_url: activeStore.brand_logo_url ?? '',
        dropi_api_key: cfg?.dropi_api_key ?? '',
        dropi_session_token: cfg?.dropi_session_token ?? '',
        dropi_store_url: cfg?.dropi_store_url ?? '',
      });
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [activeStore, isOwnerOfActive]);

  if (!activeStore || !isOwnerOfActive) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-card border border-border rounded-2xl p-8 text-center space-y-3">
          <div className="w-12 h-12 rounded-xl bg-warning/10 border border-warning/25 flex items-center justify-center mx-auto">
            <Package size={22} className="text-warning" />
          </div>
          <h1 className="text-lg font-bold text-foreground">Configuración pendiente</h1>
          <p className="text-sm text-muted-foreground">
            El dueño de esta tienda aún no cargó las credenciales de Dropi.
          </p>
        </div>
      </div>
    );
  }

  const missing = FIELDS.filter(f => f.required && !(vals[f.key] ?? '').trim()).map(f => f.key);
  const canSubmit = missing.length === 0 && !saving;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || !activeStore) return;
    setSaving(true);

    type RpcRes = { error: { message: string } | null };
    const { error: brandErr } = await (supabase.rpc as unknown as (fn: string, args: Record<string, unknown>) => Promise<RpcRes>)(
      'update_store_branding',
      { p_store_id: activeStore.id, p_name: vals.name ?? '', p_brand_logo_url: vals.brand_logo_url ?? '' },
    );
    if (brandErr) {
      toast.error('No se pudo guardar branding', { description: brandErr.message });
      setSaving(false); return;
    }

    const { error: cfgErr } = await (supabase.rpc as unknown as (fn: string, args: Record<string, unknown>) => Promise<RpcRes>)(
      'upsert_store_dropi_config',
      {
        p_store_id: activeStore.id,
        p_country_code: activeStore.country_code,
        p_dropi_api_key: vals.dropi_api_key ?? '',
        p_dropi_session_token: vals.dropi_session_token ?? '',
        p_dropi_store_url: vals.dropi_store_url ?? '',
      },
    );
    if (cfgErr) {
      toast.error('No se pudo guardar credenciales', { description: cfgErr.message });
      setSaving(false); return;
    }

    toast.success(`Tienda "${vals.name}" configurada`);
    await refresh();
    onDone();
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="animate-spin text-accent" size={28} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background overflow-y-auto">
      <div className="max-w-2xl mx-auto p-6 sm:p-10">
        <header className="mb-8 space-y-2">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-accent flex items-center justify-center">
              <Package size={20} className="text-accent-foreground" />
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-[0.12em] font-semibold text-muted-foreground">
                Setup tienda · {activeStore.country_code}
              </div>
              <h1 className="text-2xl font-bold text-foreground tracking-tight">{activeStore.name}</h1>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            Cargá las credenciales Dropi de esta tienda. Podés editarlas después en <code className="text-xs bg-muted px-1 py-0.5 rounded">/admin</code>.
          </p>
        </header>

        <form onSubmit={handleSubmit} className="space-y-5 bg-card border border-border rounded-2xl p-6 sm:p-8">
          {FIELDS.map(f => (
            <div key={f.key} className="space-y-1.5">
              <Label htmlFor={f.key} className="text-sm font-semibold">
                {f.label}
                {f.required && <span className="text-danger ml-1" aria-hidden>*</span>}
              </Label>
              <Input
                id={f.key}
                type={f.type ?? 'text'}
                value={vals[f.key] ?? ''}
                onChange={(e) => setVals(v => ({ ...v, [f.key]: e.target.value }))}
                autoComplete="off"
                spellCheck={false}
              />
              {f.hint && <p className="text-xs text-muted-foreground">{f.hint}</p>}
            </div>
          ))}

          <div className="pt-3 border-t border-border flex items-center justify-between gap-3">
            <a
              href="https://app.dropi.co" target="_blank" rel="noreferrer"
              className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
            >
              Ir a Dropi <ExternalLink size={11} />
            </a>
            <button
              type="submit" disabled={!canSubmit}
              className="inline-flex items-center gap-2 px-4 h-10 rounded-lg bg-accent text-accent-foreground text-sm font-semibold shadow-sm hover:opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? <Loader2 className="animate-spin" size={15} /> : <CheckCircle2 size={15} />}
              Guardar y continuar
            </button>
          </div>
          {missing.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Faltan {missing.length} campo(s) requerido(s).
            </p>
          )}
        </form>
      </div>
    </div>
  );
}

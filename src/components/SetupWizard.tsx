import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { Package, Loader2, CheckCircle2, ExternalLink } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { REQUIRED_SETTING_KEYS } from '@/hooks/useAppSettings';

interface FieldDef {
  key: typeof REQUIRED_SETTING_KEYS[number] | 'brand_logo_url';
  label: string;
  hint?: string;
  required: boolean;
  type?: 'text' | 'password' | 'url';
}

const FIELDS: FieldDef[] = [
  { key: 'brand_name',           label: 'Nombre de tu negocio',     required: true,  hint: 'Ej. "Mi Tienda CRM" — aparece en el sidebar y en el título.' },
  { key: 'dropi_token',          label: 'API Key de Dropi (Bearer)', required: true,  type: 'password', hint: 'Token permanente. En Dropi → Configuración → API.' },
  { key: 'dropi_session_token',  label: 'Token de sesión Dropi',    required: true,  type: 'password', hint: 'JWT del navegador. DevTools → Network → header x-authorization en cualquier request a api.dropi.co. Vence cada ~12-24h.' },
  { key: 'dropi_store_url',      label: 'URL de integración Dropi', required: true,  type: 'url', hint: 'La URL registrada en tu integración Dropi. NO es la URL pública de tu tienda online — es la URL del "tipo" de integración que elegiste al crear la API key (ej: https://rushmira.com/ si tu integración es tipo RUSHMIRA, https://yaxa.com/ si es Yaxa). La encontrás en app.dropi.co → Mis Integraciones.' },
  { key: 'brand_logo_url',       label: 'URL del logo (opcional)',  required: false, type: 'url' },
];

export default function SetupWizard({ onDone }: { onDone: () => void }) {
  const { isAdmin } = useAuth();
  const [vals, setVals] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isAdmin) { setLoading(false); return; }
    void supabase
      .from('app_settings')
      .select('key, value')
      .in('key', FIELDS.map(f => f.key))
      .then(({ data }) => {
        const m: Record<string, string> = {};
        (data ?? []).forEach((r: { key: string; value: string | null }) => { m[r.key] = r.value ?? ''; });
        setVals(m);
        setLoading(false);
      });
  }, [isAdmin]);

  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-card border border-border rounded-2xl p-8 text-center space-y-3">
          <div className="w-12 h-12 rounded-xl bg-warning/10 border border-warning/25 flex items-center justify-center mx-auto">
            <Package size={22} className="text-warning" />
          </div>
          <h1 className="text-lg font-bold text-foreground">Configuración pendiente</h1>
          <p className="text-sm text-muted-foreground">
            Pedile al administrador que complete el setup inicial del CRM antes de empezar a trabajar.
          </p>
        </div>
      </div>
    );
  }

  const missing = FIELDS.filter(f => f.required && !(vals[f.key] ?? '').trim()).map(f => f.key);
  const canSubmit = missing.length === 0 && !saving;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    const rows = FIELDS
      .filter(f => (vals[f.key] ?? '').trim() || f.required)
      .map(f => ({ key: f.key, value: (vals[f.key] ?? '').trim() }));
    const { error } = await supabase.from('app_settings').upsert(rows, { onConflict: 'key' });
    if (error) {
      toast.error('No se pudo guardar', { description: error.message });
      setSaving(false);
      return;
    }
    toast.success('Configuración guardada');
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
              <div className="text-[11px] uppercase tracking-[0.12em] font-semibold text-muted-foreground">Setup inicial</div>
              <h1 className="text-2xl font-bold text-foreground tracking-tight">Configurá tu CRM</h1>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            Completá estos campos una sola vez para activar el CRM. Podés editarlos después en <code className="text-xs bg-muted px-1 py-0.5 rounded">/admin</code>.
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
              href="https://app.dropi.co"
              target="_blank"
              rel="noreferrer"
              className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
            >
              Ir a Dropi <ExternalLink size={11} />
            </a>
            <button
              type="submit"
              disabled={!canSubmit}
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

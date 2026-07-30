import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import {
  Building2, RefreshCw, Loader2, Search, AlertTriangle, CheckCircle2,
  PauseCircle, PlayCircle, CreditCard, Users, Package,
} from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { formatDateES } from '@/lib/orderUtils';
import {
  type PlatformStore, type PlanKey, PLAN_LABEL,
  subscriptionState, storeHealth, filterStores, soloFecha,
} from '@/lib/platformOverview';

/** Fecha legible tolerando timestamptz o date; sin fecha → guion, nunca "Invalid Date". */
const fecha = (iso: string | null | undefined): string => {
  const f = soloFecha(iso);
  return f ? formatDateES(f) : '—';
};

/**
 * Panel de PLATAFORMA — la vista del dueño de Guardian sobre sus inquilinos.
 * Solo admin GLOBAL: el ítem del menú no se dibuja para nadie más y las RPC
 * (`platform_*`) tiran 42501 si el que llama no es admin, así que entrar por
 * URL directa no sirve de nada.
 *
 * Muestra AGREGADOS (cuántos pedidos, si sincroniza, qué versión tienen
 * cargada, cómo va la suscripción). NUNCA el contenido de los pedidos ni los
 * clientes de otro tenant: acá se administra la plataforma, no el negocio ajeno.
 */

type Rpc = (fn: string, p?: Record<string, unknown>) => Promise<{
  data: unknown; error: { message: string } | null;
}>;

const PLANS: PlanKey[] = ['prueba', 'pro', 'cortesia'];

export default function PlataformaPage() {
  const { isAdmin, profileLoaded } = useAuth();
  const [rows, setRows] = useState<PlatformStore[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [soloProblemas, setSoloProblemas] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setLoading(true);
    setError(null);
    const rpc = supabase.rpc.bind(supabase) as unknown as Rpc;
    const { data, error: err } = await rpc('platform_stores_overview');
    if (err) {
      setError(err.message);
      setRows([]);
    } else if (Array.isArray(data)) {
      setRows(data as PlatformStore[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => { if (isAdmin) void cargar(); }, [isAdmin, cargar]);

  const visibles = useMemo(() => filterStores(rows, q, soloProblemas), [rows, q, soloProblemas]);

  // Gate de UI (el de verdad está en la DB). Se espera a profileLoaded para no
  // rebotar a alguien que SÍ es admin mientras carga su perfil.
  if (!profileLoaded) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="animate-spin text-accent" size={20} aria-hidden="true" />
      </div>
    );
  }
  if (!isAdmin) return <Navigate to="/dashboard" replace />;

  const setPlan = async (store: PlatformStore, plan: PlanKey, paidUntil: string | null) => {
    const rpc = supabase.rpc.bind(supabase) as unknown as Rpc;
    const { error: err } = await rpc('platform_set_subscription', {
      p_store_id: store.store_id,
      p_plan: plan,
      p_paid_until: paidUntil || null,
      p_notes: store.sub_notes ?? null,
    });
    if (err) { toast.error(`No se pudo guardar: ${err.message}`); return; }
    toast.success(`${store.store_name}: ${PLAN_LABEL[plan]}${paidUntil ? ` hasta ${fecha(paidUntil)}` : ''}`);
    setEditing(null);
    void cargar();
  };

  const toggleStatus = async (store: PlatformStore) => {
    const next = store.status === 'active' ? 'suspended' : 'active';
    const verbo = next === 'suspended' ? 'Suspender' : 'Reactivar';
    if (next === 'suspended' && !confirm(
      `¿Suspender "${store.store_name}"?\n\nSu dueño no va a poder entrar. Los datos NO se borran y podés reactivarla cuando quieras.`
    )) return;
    const rpc = supabase.rpc.bind(supabase) as unknown as Rpc;
    const { error: err } = await rpc('platform_set_store_status', { p_store_id: store.store_id, p_status: next });
    if (err) { toast.error(`No se pudo ${verbo.toLowerCase()}: ${err.message}`); return; }
    toast.success(`${store.store_name}: ${next === 'suspended' ? 'suspendida' : 'reactivada'}`);
    void cargar();
  };

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-[1400px] mx-auto">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="hud-label">Plataforma · Administración</p>
          <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
            <Building2 size={20} className="text-accent" aria-hidden="true" />
            Mis tiendas
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {rows.length} {rows.length === 1 ? 'tienda' : 'tiendas'} en la plataforma.
            Acá ves el uso y la suscripción — nunca los pedidos ni los clientes de cada una.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void cargar()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card/40 px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:border-border-strong transition-colors cursor-pointer disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} aria-hidden="true" /> Actualizar
        </button>
      </header>

      {error && (
        <div className="rounded-2xl border border-danger/30 bg-danger/5 p-4">
          <p className="text-sm font-bold text-danger mb-1">No se pudo cargar el panel</p>
          <p className="text-xs font-mono text-foreground/80 break-all">{error}</p>
          <p className="text-[11px] text-muted-foreground mt-1">
            Si dice <code className="px-1 rounded bg-muted/40">does not exist</code>, falta aplicar la migración del panel.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar por tienda, dueño o correo…"
            aria-label="Buscar tienda"
            className="w-full rounded-xl border border-border bg-card/40 pl-9 pr-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          />
        </div>
        <label className="inline-flex items-center gap-2 rounded-xl border border-border bg-card/40 px-3 py-2 text-xs text-muted-foreground cursor-pointer">
          <input type="checkbox" checked={soloProblemas} onChange={(e) => setSoloProblemas(e.target.checked)} className="cursor-pointer" />
          Solo con problemas
        </label>
      </div>

      {loading && rows.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card/40 p-10 flex items-center justify-center">
          <Loader2 className="animate-spin text-accent" size={20} aria-hidden="true" />
        </div>
      ) : visibles.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card/40 p-10 text-center">
          <p className="text-sm text-muted-foreground">
            {rows.length === 0 ? 'Todavía no hay tiendas.' : 'Ninguna tienda coincide con el filtro.'}
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {visibles.map((s) => {
            const sub = subscriptionState(s);
            const health = storeHealth(s);
            const suspendida = s.status !== 'active';
            return (
              <li
                key={s.store_id}
                className={`rounded-2xl border p-4 ${suspendida ? 'border-border bg-muted/20 opacity-80' : 'border-border bg-card/40'}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-bold text-foreground">{s.store_name}</span>
                      <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                        {s.country_code}
                      </span>
                      {suspendida && (
                        <span className="rounded-full border border-danger/40 bg-danger/15 px-2 py-0.5 text-[10px] font-bold text-danger">
                          SUSPENDIDA
                        </span>
                      )}
                      <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${sub.tone}`} title={sub.detail}>
                        {sub.label}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground truncate">
                      {s.owner_name} · {s.owner_email} · desde {fecha(s.created_at)}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setEditing(editing === s.store_id ? null : s.store_id)}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card/60 px-3 py-1.5 text-xs font-semibold text-foreground hover:border-accent/50 transition-colors cursor-pointer"
                    >
                      <CreditCard size={13} aria-hidden="true" /> Suscripción
                    </button>
                    <button
                      type="button"
                      onClick={() => void toggleStatus(s)}
                      className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer ${
                        suspendida
                          ? 'border-success/40 bg-success/15 text-success hover:bg-success/25'
                          : 'border-border bg-card/60 text-muted-foreground hover:text-danger hover:border-danger/40'
                      }`}
                    >
                      {suspendida
                        ? <><PlayCircle size={13} aria-hidden="true" /> Reactivar</>
                        : <><PauseCircle size={13} aria-hidden="true" /> Suspender</>}
                    </button>
                  </div>
                </div>

                {/* Métricas de uso y salud — agregados, nunca contenido. */}
                <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <Metric icon={Package} label="Pedidos 30d" value={String(s.orders_30d)} />
                  <Metric icon={Users} label="Miembros" value={String(s.members)} />
                  <Metric
                    icon={health.syncOk ? CheckCircle2 : AlertTriangle}
                    label="Sincronía"
                    value={health.syncLabel}
                    tone={health.syncOk ? 'success' : 'danger'}
                  />
                  <Metric
                    icon={health.walletOk ? CheckCircle2 : AlertTriangle}
                    label="Billetera"
                    value={health.walletLabel}
                    tone={health.walletOk ? 'success' : 'warning'}
                  />
                </div>

                <p className="mt-2 text-[11px] text-muted-foreground">
                  Versión cargada: <span className="font-mono text-foreground/80">{s.app_versions}</span>
                  {!s.has_dropi_key && (
                    <span className="ml-2 text-warning font-semibold">· sin credenciales Dropi</span>
                  )}
                </p>

                {editing === s.store_id && (
                  <SubscriptionEditor store={s} onSave={setPlan} onCancel={() => setEditing(null)} />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Metric({ icon: Icon, label, value, tone }: {
  icon: typeof Package; label: string; value: string; tone?: 'success' | 'danger' | 'warning';
}) {
  const toneCls = tone === 'success' ? 'text-success' : tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : 'text-foreground';
  return (
    <div className="rounded-xl border border-border bg-surface/40 px-3 py-2">
      <div className="flex items-center gap-1.5 text-muted-foreground mb-0.5">
        <Icon size={11} className={tone ? toneCls : undefined} aria-hidden="true" />
        <span className="text-[10px] font-semibold uppercase tracking-wider">{label}</span>
      </div>
      <p className={`text-[13px] font-bold tabular-nums ${toneCls}`}>{value}</p>
    </div>
  );
}

function SubscriptionEditor({ store, onSave, onCancel }: {
  store: PlatformStore;
  onSave: (s: PlatformStore, plan: PlanKey, paidUntil: string | null) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [plan, setPlan] = useState<PlanKey>((store.plan as PlanKey) || 'prueba');
  const [until, setUntil] = useState(store.paid_until ? store.paid_until.slice(0, 10) : '');
  return (
    <div className="mt-3 rounded-xl border border-accent/25 bg-accent/5 p-3 flex flex-wrap items-end gap-3">
      <div>
        <label htmlFor={`plan-${store.store_id}`} className="block text-[10px] font-semibold text-muted-foreground mb-1">Plan</label>
        <select
          id={`plan-${store.store_id}`}
          value={plan}
          onChange={(e) => setPlan(e.target.value as PlanKey)}
          className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
        >
          {PLANS.map((p) => <option key={p} value={p}>{PLAN_LABEL[p]}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor={`until-${store.store_id}`} className="block text-[10px] font-semibold text-muted-foreground mb-1">Pagó hasta</label>
        <input
          id={`until-${store.store_id}`}
          type="date"
          value={until}
          onChange={(e) => setUntil(e.target.value)}
          className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
        />
      </div>
      <button
        type="button"
        onClick={() => void onSave(store, plan, until || null)}
        className="rounded-lg bg-accent px-3 py-1.5 text-xs font-bold text-accent-foreground hover:bg-accent/90 transition-colors cursor-pointer"
      >
        Guardar
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
      >
        Cancelar
      </button>
      <p className="w-full text-[10px] text-muted-foreground">
        Dejá la fecha vacía para una tienda sin vencimiento (cortesía). El dueño ve un aviso cuando faltan 7 días o menos.
      </p>
    </div>
  );
}

import { useState, useEffect, useCallback } from 'react';
import { Fingerprint, Package, CheckCircle2, RotateCcw, TrendingUp, ShieldAlert, ShieldCheck, Shield, Sparkles, RefreshCw } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useStore } from '@/contexts/StoreContext';


interface FpData {
  risk: string;
  color: string;
  orders: number;
  delivered: number;
  returned: number;
  buyerType: string;
}

/**
 * Estado explícito de la huella. Antes cualquier fallo/`found:false` era
 * `null` → `return null` = la tarjeta desaparecía en silencio y la asesora no
 * distinguía "cliente nuevo" de "algo se rompió" (bug reportado 2026-07-10:
 * "la huella no sale"). Ahora los 3 casos son VISIBLES:
 *  - history → tarjeta completa con datos.
 *  - new     → "Cliente nuevo — sin historial" (señal útil).
 *  - error   → "Huella no disponible" + reintentar (y NO se cachea).
 */
type FpState =
  | { kind: 'history'; data: FpData }
  | { kind: 'new' }
  | { kind: 'error' };

/**
 * In-memory cache con TTL de 10 min — evita re-fetch del mismo teléfono
 * dentro de una misma navegación, pero permite refrescar la huella si el
 * cliente compra/devuelve algo durante la sesión (operadora trabajando 8h
 * sin recargar la página). Solo se cachean resultados REALES (history/new);
 * los errores NO se cachean — antes un fallo transitorio escondía la huella
 * 10 minutos.
 */
const FP_CACHE_TTL_MS = 10 * 60 * 1000;
type FpCacheEntry = { value: FpState; expires: number };
const fpCache = new Map<string, FpCacheEntry>();

function getCachedFp(cacheKey: string): FpState | undefined {
  const entry = fpCache.get(cacheKey);
  if (!entry) return undefined;
  if (Date.now() > entry.expires) {
    fpCache.delete(cacheKey);
    return undefined;
  }
  return entry.value;
}

function setCachedFp(cacheKey: string, value: FpState): void {
  fpCache.set(cacheKey, { value, expires: Date.now() + FP_CACHE_TTL_MS });
}

/**
 * Unified risk config — uses only 3 tones (success / warning / danger) aligned
 * with the rest of the CRM palette. No custom color floating around.
 */
const RISK_CONFIG: Record<string, {
  border: string;
  stripe: string;
  chipBg: string;
  chipBorder: string;
  chipText: string;
  icon: typeof ShieldCheck;
  label: string;
}> = {
  green: {
    border: 'border-success/30',
    stripe: 'bg-success',
    chipBg: 'bg-success/15',
    chipBorder: 'border-success/40',
    chipText: 'text-success',
    icon: ShieldCheck,
    label: 'Seguro',
  },
  yellow: {
    border: 'border-warning/30',
    stripe: 'bg-warning',
    chipBg: 'bg-warning/15',
    chipBorder: 'border-warning/40',
    chipText: 'text-warning',
    icon: Shield,
    label: 'Probable',
  },
  red: {
    border: 'border-danger/30',
    stripe: 'bg-danger',
    chipBg: 'bg-danger/15',
    chipBorder: 'border-danger/40',
    chipText: 'text-danger',
    icon: ShieldAlert,
    label: 'Riesgoso',
  },
};

function deliveryColor(): { text: string; fill: string } {
  // Entregas siempre en verde — es la métrica positiva, el color fija la
  // categoría (como ingresos vs gastos en un dashboard financiero).
  return { text: 'text-success', fill: 'bg-success' };
}

function devolutionColor(): { text: string; fill: string } {
  // Devoluciones siempre en rojo — señal clara de riesgo / categoría negativa.
  return { text: 'text-danger', fill: 'bg-danger' };
}

export default function FingerprintBadge({ phone }: { phone: string }) {
  const { activeStoreId } = useStore();
  const cacheKey = `${activeStoreId ?? 'none'}|${phone}`;
  const [state, setState] = useState<FpState | undefined>(
    () => getCachedFp(cacheKey),
  );
  const [loading, setLoading] = useState(false);
  // Bump para "Reintentar" tras un error (fuerza re-correr el effect).
  const [retryTick, setRetryTick] = useState(0);
  const retry = useCallback(() => {
    fpCache.delete(cacheKey);
    setState(undefined);
    setRetryTick((t) => t + 1);
  }, [cacheKey]);

  useEffect(() => {
    if (!phone || !activeStoreId) return;
    const cached = getCachedFp(cacheKey);
    if (cached !== undefined) {
      setState(cached);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        // Multi-tienda + EC-aware: usa la edge function (lee store_dropi_config,
        // normaliza prefijo CO/EC, valida membresía). El viejo RPC público
        // dropi_fingerprint hardcodeaba app_settings.dropi_session_token +
        // country=CO + ^57 → roto en EC y en cualquier tienda multi-tenant.
        const { data: raw, error } = await supabase.functions.invoke('dropi-fingerprint', {
          body: { phone, storeId: activeStoreId },
        });
        const d = raw as Record<string, unknown> | null;
        const phoneTag = phone ? `***${phone.slice(-4)}` : '<empty>';
        if (error) {
          console.error('[FingerprintBadge] edge error', { phoneTag, error });
        } else if (d && (d as { ok?: boolean }).ok === false) {
          console.error('[FingerprintBadge] edge ok=false', { phoneTag, payload: d });
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dd = d as any;
        if (cancelled) return;
        if (!error && dd?.ok && dd.fingerprint?.found) {
          const gp = dd.fingerprint.global_profile;
          const next: FpState = {
            kind: 'history',
            data: {
              risk: gp.risk_label,
              color: gp.risk_color,
              orders: gp.lifetime_totals.orders,
              delivered: gp.lifetime_totals.delivered,
              returned: gp.lifetime_totals.returned,
              buyerType: gp.buyer_type,
            },
          };
          setCachedFp(cacheKey, next);
          setState(next);
        } else if (!error && dd?.ok && dd.fingerprint && dd.fingerprint.found === false) {
          // Cliente sin historial en Dropi (edge nueva mapea el 404 acá).
          const next: FpState = { kind: 'new' };
          setCachedFp(cacheKey, next);
          setState(next);
        } else {
          // Error real (red / edge vieja / Dropi caído): visible + NO cachear.
          setState({ kind: 'error' });
        }
      } catch (e) {
        console.error('[FingerprintBadge] threw', e);
        if (!cancelled) setState({ kind: 'error' });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [phone, activeStoreId, cacheKey, retryTick]);


  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border/60">
          <Fingerprint size={14} className="text-accent animate-pulse" />
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Huella Dropi
          </span>
        </div>
        <div className="p-4 space-y-3">
          <div className="h-4 rounded bg-muted/60 skeleton-shimmer" />
          <div className="grid grid-cols-3 gap-2">
            <div className="h-14 rounded-lg bg-muted/60 skeleton-shimmer" />
            <div className="h-14 rounded-lg bg-muted/60 skeleton-shimmer" />
            <div className="h-14 rounded-lg bg-muted/60 skeleton-shimmer" />
          </div>
          <div className="h-2.5 rounded-full bg-muted/60 skeleton-shimmer" />
          <div className="h-2.5 rounded-full bg-muted/60 skeleton-shimmer" />
        </div>
      </div>
    );
  }
  if (!state) return null;

  // Cliente NUEVO — sin historial en Dropi. Señal útil (primera compra), no ausencia.
  if (state.kind === 'new') {
    return (
      <div className="rounded-xl border border-border bg-card px-4 py-2.5 flex items-center gap-2">
        <Fingerprint size={14} className="text-accent" aria-hidden="true" />
        <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted-foreground">
          Huella Dropi
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-0.5">
          <Sparkles size={12} className="text-accent" aria-hidden="true" />
          <span className="text-[11px] font-semibold text-foreground">Cliente nuevo — sin historial</span>
        </span>
      </div>
    );
  }

  // Error real (red / Dropi caído / edge vieja) — visible, con reintento manual.
  if (state.kind === 'error') {
    return (
      <div className="rounded-xl border border-border bg-card px-4 py-2.5 flex items-center gap-2">
        <Fingerprint size={14} className="text-muted-foreground" aria-hidden="true" />
        <span className="text-[11px] text-muted-foreground">Huella no disponible</span>
        <button
          type="button"
          onClick={retry}
          className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:border-border-strong transition-colors"
        >
          <RefreshCw size={11} aria-hidden="true" /> Reintentar
        </button>
      </div>
    );
  }

  const data = state.data;
  const cfg = RISK_CONFIG[data.color] || RISK_CONFIG.yellow;
  const RiskIcon = cfg.icon;
  const pctEntrega = data.orders > 0 ? Math.round((data.delivered / data.orders) * 100) : 0;
  const pctDevol = data.orders > 0 ? Math.round((data.returned / data.orders) * 100) : 0;
  const entregaStyle = deliveryColor();
  const devolStyle = devolutionColor();

  return (
    <div className={`relative rounded-xl border ${cfg.border} bg-card overflow-hidden shadow-sm`}>
      {/* Left status stripe — the only splash of color outside the chip */}
      <span className={`absolute left-0 top-0 bottom-0 w-[3px] ${cfg.stripe}`} aria-hidden="true" />

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/60 bg-surface/40">
        <div className="flex items-center gap-2">
          <Fingerprint size={14} className="text-accent" aria-hidden="true" />
          <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted-foreground">
            Huella Dropi
          </span>
        </div>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 ${cfg.chipBg} ${cfg.chipBorder}`}
          aria-label={`Riesgo: ${data.risk}`}
        >
          <RiskIcon size={12} className={cfg.chipText} aria-hidden="true" />
          <span className={`text-[11px] font-bold ${cfg.chipText}`}>{data.risk}</span>
        </span>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-3 border-b border-border/60">
        <div className="px-3 py-3 text-center border-r border-border/60">
          <div className="flex items-center justify-center gap-1 mb-1 text-muted-foreground">
            <Package size={11} aria-hidden="true" />
            <span className="text-[10px] font-semibold uppercase tracking-wider">Pedidos</span>
          </div>
          <div className="text-xl font-bold text-foreground tabular-nums leading-none">{data.orders}</div>
        </div>
        <div className="px-3 py-3 text-center border-r border-border/60">
          <div className="flex items-center justify-center gap-1 mb-1 text-success">
            <CheckCircle2 size={11} aria-hidden="true" />
            <span className="text-[10px] font-semibold uppercase tracking-wider">Entregados</span>
          </div>
          <div className="text-xl font-bold text-success tabular-nums leading-none">{data.delivered}</div>
        </div>
        <div className="px-3 py-3 text-center">
          <div className="flex items-center justify-center gap-1 mb-1 text-danger">
            <RotateCcw size={11} aria-hidden="true" />
            <span className="text-[10px] font-semibold uppercase tracking-wider">Devueltos</span>
          </div>
          <div className="text-xl font-bold text-danger tabular-nums leading-none">{data.returned}</div>
        </div>
      </div>

      {/* Progress bars — visible track + saturated fill, semantic tokens */}
      <div className="px-4 py-3.5 space-y-3">
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-semibold text-foreground">Tasa de entrega</span>
            <span className={`text-[12px] font-bold tabular-nums ${entregaStyle.text}`}>
              {pctEntrega}%
            </span>
          </div>
          <div
            className="h-2.5 rounded-full bg-muted border border-border overflow-hidden"
            role="progressbar"
            aria-valuenow={pctEntrega}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Tasa de entrega ${pctEntrega}%`}
          >
            <div
              className={`h-full rounded-full transition-[width] duration-500 ${entregaStyle.fill}`}
              style={{ width: `${pctEntrega}%`, minWidth: pctEntrega > 0 ? '8px' : '0' }}
            />
          </div>
        </div>
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-semibold text-foreground">Tasa de devolución</span>
            <span className={`text-[12px] font-bold tabular-nums ${devolStyle.text}`}>
              {pctDevol}%
            </span>
          </div>
          <div
            className="h-2.5 rounded-full bg-muted border border-border overflow-hidden"
            role="progressbar"
            aria-valuenow={pctDevol}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Tasa de devolución ${pctDevol}%`}
          >
            <div
              className={`h-full rounded-full transition-[width] duration-500 ${devolStyle.fill}`}
              style={{ width: `${pctDevol}%`, minWidth: pctDevol > 0 ? '8px' : '0' }}
            />
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between gap-2 px-4 py-2 border-t border-border/60 bg-surface/40">
        <div className="flex items-center gap-1.5 min-w-0">
          <TrendingUp size={11} className="text-muted-foreground flex-shrink-0" aria-hidden="true" />
          <span className="text-[10px] text-muted-foreground">Tipo:</span>
          <span className="text-[10px] font-semibold text-foreground truncate">{data.buyerType}</span>
        </div>
        <span className="text-[9px] text-muted-foreground/70 uppercase tracking-wider whitespace-nowrap">
          Datos globales Dropi
        </span>
      </div>
    </div>
  );
}

import { useState, useEffect } from 'react';
import { Fingerprint, Package, CheckCircle2, RotateCcw, TrendingUp, ShieldAlert, ShieldCheck, Shield } from 'lucide-react';
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
 * In-memory cache con TTL de 10 min — evita re-fetch del mismo teléfono
 * dentro de una misma navegación, pero permite refrescar la huella si el
 * cliente compra/devuelve algo durante la sesión (operadora trabajando 8h
 * sin recargar la página).
 */
const FP_CACHE_TTL_MS = 10 * 60 * 1000;
type FpCacheEntry = { value: FpData | null; expires: number };
const fpCache = new Map<string, FpCacheEntry>();

function getCachedFp(phone: string): FpData | null | undefined {
  const entry = fpCache.get(phone);
  if (!entry) return undefined;
  if (Date.now() > entry.expires) {
    fpCache.delete(phone);
    return undefined;
  }
  return entry.value;
}

function setCachedFp(phone: string, value: FpData | null): void {
  fpCache.set(phone, { value, expires: Date.now() + FP_CACHE_TTL_MS });
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
  const [data, setData] = useState<FpData | null | undefined>(
    () => getCachedFp(phone),
  );
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!phone) return;
    const cached = getCachedFp(phone);
    if (cached !== undefined) {
      setData(cached);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const { data: raw, error } = await supabase.rpc('dropi_fingerprint', {
          p_phone: phone,
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d = raw as Record<string, any> | null;
        // OLD-2: NO loguear el phone completo. Si mañana enchufamos
        // Sentry/LogFlare, los teléfonos vuelan al SaaS sin redacción.
        // Mostramos solo los últimos 4 dígitos como tag de debug.
        const phoneTag = phone ? `***${phone.slice(-4)}` : '<empty>';
        if (error) {
          console.error('[FingerprintBadge] RPC error', { phoneTag, error });
        } else if (d && d.ok === false) {
          console.error('[FingerprintBadge] RPC returned ok=false', { phoneTag, payload: d });
        } else if (d?.ok && !d.fingerprint?.found) {
          console.warn('[FingerprintBadge] No fingerprint found for phone', { phoneTag });
        }
        if (!cancelled && !error && d?.ok && d.fingerprint?.found) {
          const gp = d.fingerprint.global_profile;
          const result: FpData = {
            risk: gp.risk_label,
            color: gp.risk_color,
            orders: gp.lifetime_totals.orders,
            delivered: gp.lifetime_totals.delivered,
            returned: gp.lifetime_totals.returned,
            buyerType: gp.buyer_type,
          };
          setCachedFp(phone, result);
          setData(result);
        } else {
          setCachedFp(phone, null);
          setData(null);
        }
      } catch {
        fpCache.set(phone, null);
        setData(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [phone]);

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
  if (!data) return null;

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

import { useState, useEffect } from 'react';
import { Fingerprint, Package, CheckCircle2, RotateCcw, TrendingUp, ShieldAlert, ShieldCheck, Shield } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

interface FpData {
  risk: string;
  color: string;
  orders: number;
  delivered: number;
  returned: number;
  buyerType: string;
}

/** In-memory cache — avoids re-fetching the same phone across navigations. */
const fpCache = new Map<string, FpData | null>();

const RISK_CONFIG: Record<string, {
  bg: string; border: string; text: string; bar: string;
  icon: typeof ShieldCheck; label: string;
}> = {
  green: {
    bg: 'bg-green-500/8', border: 'border-green-500/25', text: 'text-green-500',
    bar: 'bg-green-500', icon: ShieldCheck, label: 'Seguro',
  },
  yellow: {
    bg: 'bg-yellow-500/8', border: 'border-yellow-500/25', text: 'text-yellow-500',
    bar: 'bg-yellow-500', icon: Shield, label: 'Probable',
  },
  red: {
    bg: 'bg-red-500/8', border: 'border-red-500/25', text: 'text-red-500',
    bar: 'bg-red-500', icon: ShieldAlert, label: 'Riesgoso',
  },
};

export default function FingerprintBadge({ phone }: { phone: string }) {
  const [data, setData] = useState<FpData | null | undefined>(
    fpCache.has(phone) ? fpCache.get(phone) : undefined,
  );
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!phone) return;
    if (fpCache.has(phone)) {
      setData(fpCache.get(phone) ?? null);
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
          fpCache.set(phone, result);
          setData(result);
        } else {
          fpCache.set(phone, null);
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
      <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-3 animate-pulse">
        <div className="flex items-center gap-2 text-xs text-cyan-500">
          <Fingerprint size={14} className="animate-spin" />
          <span className="font-medium">Consultando huella Dropi...</span>
        </div>
      </div>
    );
  }
  if (!data) return null;

  const cfg = RISK_CONFIG[data.color] || RISK_CONFIG.yellow;
  const RiskIcon = cfg.icon;
  const pctEntrega = data.orders > 0 ? Math.round((data.delivered / data.orders) * 100) : 0;
  const pctDevol = data.orders > 0 ? Math.round((data.returned / data.orders) * 100) : 0;

  return (
    <div className={`rounded-xl border ${cfg.border} ${cfg.bg} overflow-hidden`}>
      {/* Header */}
      <div className={`flex items-center justify-between px-3.5 py-2 border-b ${cfg.border}`}>
        <div className="flex items-center gap-2">
          <Fingerprint size={14} className={cfg.text} />
          <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            Huella Dropi
          </span>
        </div>
        <div className={`flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border ${cfg.border} ${cfg.bg}`}>
          <RiskIcon size={12} className={cfg.text} />
          <span className={`text-[11px] font-bold ${cfg.text}`}>{data.risk}</span>
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-3 divide-x divide-border/50">
        <div className="px-3 py-2.5 text-center">
          <div className="flex items-center justify-center gap-1 mb-0.5">
            <Package size={11} className="text-muted-foreground" />
            <span className="text-[10px] text-muted-foreground font-medium">Pedidos</span>
          </div>
          <span className="text-lg font-bold text-foreground">{data.orders}</span>
        </div>
        <div className="px-3 py-2.5 text-center">
          <div className="flex items-center justify-center gap-1 mb-0.5">
            <CheckCircle2 size={11} className="text-green-500" />
            <span className="text-[10px] text-muted-foreground font-medium">Entregados</span>
          </div>
          <span className="text-lg font-bold text-green-500">{data.delivered}</span>
        </div>
        <div className="px-3 py-2.5 text-center">
          <div className="flex items-center justify-center gap-1 mb-0.5">
            <RotateCcw size={11} className="text-red-500" />
            <span className="text-[10px] text-muted-foreground font-medium">Devueltos</span>
          </div>
          <span className="text-lg font-bold text-red-500">{data.returned}</span>
        </div>
      </div>

      {/* Progress bars */}
      <div className="px-3.5 py-3 space-y-2.5 border-t border-border/30">
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-medium text-foreground/80">Tasa de entrega</span>
            <span className={`text-[11px] font-bold tabular-nums ${pctEntrega >= 60 ? 'text-green-500' : pctEntrega >= 40 ? 'text-yellow-500' : 'text-red-500'}`}>
              {pctEntrega}%
            </span>
          </div>
          <div
            className="h-2 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden ring-1 ring-inset ring-border/50"
            role="progressbar"
            aria-valuenow={pctEntrega}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Tasa de entrega ${pctEntrega}%`}
          >
            <div
              className={`h-full rounded-full transition-[width] duration-500 ${pctEntrega >= 60 ? 'bg-green-500' : pctEntrega >= 40 ? 'bg-yellow-500' : 'bg-red-500'}`}
              style={{ width: `${Math.max(pctEntrega, pctEntrega > 0 ? 4 : 0)}%` }}
            />
          </div>
        </div>
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-medium text-foreground/80">Tasa de devolución</span>
            <span className={`text-[11px] font-bold tabular-nums ${pctDevol <= 20 ? 'text-green-500' : pctDevol <= 40 ? 'text-yellow-500' : 'text-red-500'}`}>
              {pctDevol}%
            </span>
          </div>
          <div
            className="h-2 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden ring-1 ring-inset ring-border/50"
            role="progressbar"
            aria-valuenow={pctDevol}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Tasa de devolución ${pctDevol}%`}
          >
            <div
              className={`h-full rounded-full transition-[width] duration-500 ${pctDevol <= 20 ? 'bg-green-500' : pctDevol <= 40 ? 'bg-yellow-500' : 'bg-red-500'}`}
              style={{ width: `${Math.max(pctDevol, pctDevol > 0 ? 4 : 0)}%` }}
            />
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className={`flex items-center justify-between px-3.5 py-2 border-t ${cfg.border} bg-muted/20`}>
        <div className="flex items-center gap-1.5">
          <TrendingUp size={11} className="text-muted-foreground" />
          <span className="text-[10px] text-muted-foreground">Tipo:</span>
          <span className="text-[10px] font-semibold text-foreground">{data.buyerType}</span>
        </div>
        <span className="text-[9px] text-muted-foreground/60">Datos de todas las tiendas Dropi</span>
      </div>
    </div>
  );
}

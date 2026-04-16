import { useState, useEffect } from 'react';
import { Fingerprint } from 'lucide-react';
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

const RISK_STYLES: Record<string, string> = {
  green: 'bg-green-500/15 text-green-500 border-green-500/30',
  yellow: 'bg-yellow-500/15 text-yellow-500 border-yellow-500/30',
  red: 'bg-red-500/15 text-red-500 border-red-500/30',
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
      <span className="inline-flex items-center gap-1 text-[10px] text-cyan-500 animate-pulse">
        <Fingerprint size={11} /> Consultando...
      </span>
    );
  }
  if (!data) return null;

  const cls = RISK_STYLES[data.color] || RISK_STYLES.yellow;
  const pct = data.orders > 0 ? Math.round((data.delivered / data.orders) * 100) : 0;

  return (
    <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-semibold ${cls}`}>
      <Fingerprint size={12} />
      <span>{data.risk}</span>
      <span className="opacity-50">·</span>
      <span>{data.orders} ped</span>
      <span className="opacity-50">·</span>
      <span>{pct}% entrega</span>
    </div>
  );
}

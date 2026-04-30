// src/hooks/useGoogleQuota.ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

interface QuotaSnapshot {
  budget_usd: number;
  used_usd: number;
  used_today_date: string;
  pct: number;
  exceeded: boolean;
}

async function fetchQuota(): Promise<QuotaSnapshot> {
  const { data } = await supabase
    .from('app_settings')
    .select('key, value')
    .in('key', ['google_api_daily_budget_usd', 'google_api_used_today_usd', 'google_api_used_today_date']);

  const map = Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
  const budget = parseFloat(map.google_api_daily_budget_usd ?? '2.50');
  const used = parseFloat(map.google_api_used_today_usd ?? '0.00');
  const used_today_date = map.google_api_used_today_date ?? '';

  return {
    budget_usd: budget,
    used_usd: used,
    used_today_date,
    pct: budget > 0 ? Math.min(1, used / budget) : 0,
    exceeded: used >= budget,
  };
}

export function useGoogleQuota() {
  return useQuery({
    queryKey: ['google_quota'],
    queryFn: fetchQuota,
    refetchInterval: 60_000,
    staleTime: 50_000,
  });
}

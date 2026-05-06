import { useMemo } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

// Hooks del bloque "Pauta del mes" en /cfo. Una fila por (mes,
// plataforma, cuenta). Admin-only via RLS de la tabla.

export type AdPlatform = 'meta' | 'tiktok' | 'other';
export type AdPaymentMethod = 'mastercard_usd' | 'mastercard_cop' | 'amex_cop' | 'wallet' | 'other';

export interface AdSpendRow {
  id: string;
  year_month: string;       // 'YYYY-MM'
  platform: AdPlatform;
  account_name: string;
  amount_cop: number;
  payment_method: AdPaymentMethod;
  notas: string | null;
  created_at: string;
  updated_at: string;
}

const VALID_PLATFORMS: AdPlatform[] = ['meta', 'tiktok', 'other'];
const VALID_METHODS: AdPaymentMethod[] = [
  'mastercard_usd', 'mastercard_cop', 'amex_cop', 'wallet', 'other',
];

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return isFinite(n) ? n : 0;
  }
  return 0;
}

function parseRow(raw: unknown): AdSpendRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const platform = String(o.platform ?? '');
  const method = String(o.payment_method ?? 'mastercard_usd');
  if (!VALID_PLATFORMS.includes(platform as AdPlatform)) return null;
  return {
    id: String(o.id ?? ''),
    year_month: String(o.year_month ?? ''),
    platform: platform as AdPlatform,
    account_name: String(o.account_name ?? ''),
    amount_cop: toNumber(o.amount_cop),
    payment_method: VALID_METHODS.includes(method as AdPaymentMethod)
      ? (method as AdPaymentMethod)
      : 'other',
    notas: typeof o.notas === 'string' ? o.notas : null,
    created_at: String(o.created_at ?? ''),
    updated_at: String(o.updated_at ?? ''),
  };
}

/**
 * Trae todas las filas de pauta. Si se pasa `yearMonth`, filtra por
 * ese mes. Sin él, devuelve todas (útil para vista histórica).
 */
export function useMonthlyAdSpend(yearMonth?: string) {
  return useQuery<AdSpendRow[]>({
    queryKey: ['monthly-ad-spend', yearMonth ?? 'all'],
    queryFn: async () => {
      let q = supabase.from('monthly_ad_spend').select('*');
      if (yearMonth) q = q.eq('year_month', yearMonth);
      const { data, error } = await q.order('year_month', { ascending: false }).order('amount_cop', { ascending: false });
      if (error) throw error;
      const rows = Array.isArray(data) ? data : [];
      return rows.map(parseRow).filter((r): r is AdSpendRow => r !== null);
    },
    staleTime: 60_000,
  });
}

export interface UpsertAdSpendParams {
  year_month: string;
  platform: AdPlatform;
  account_name: string;
  amount_cop: number;
  payment_method: AdPaymentMethod;
  notas: string;
}

export function useUpsertAdSpend() {
  const qc = useQueryClient();
  return useMutation<AdSpendRow, Error, UpsertAdSpendParams>({
    mutationFn: async (params) => {
      const rpc = supabase.rpc as unknown as (
        fn: string, args: Record<string, unknown>
      ) => Promise<{ data: unknown; error: { message?: string } | null }>;
      const { data, error } = await rpc('upsert_monthly_ad_spend', {
        p_year_month: params.year_month,
        p_platform: params.platform,
        p_account_name: params.account_name,
        p_amount_cop: params.amount_cop,
        p_payment_method: params.payment_method,
        p_notas: params.notas,
      });
      if (error) throw new Error(error.message || 'Error guardando pauta');
      const row = parseRow(data);
      if (!row) throw new Error('Respuesta inesperada del servidor');
      return row;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['monthly-ad-spend'] });
    },
  });
}

export function useDeleteAdSpend() {
  const qc = useQueryClient();
  return useMutation<boolean, Error, string>({
    mutationFn: async (id: string) => {
      const rpc = supabase.rpc as unknown as (
        fn: string, args: Record<string, unknown>
      ) => Promise<{ data: unknown; error: { message?: string } | null }>;
      const { data, error } = await rpc('delete_monthly_ad_spend', { p_id: id });
      if (error) throw new Error(error.message || 'Error eliminando pauta');
      return Boolean(data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['monthly-ad-spend'] });
    },
  });
}

// ─────────────────────────────────────────────────────────────────
// Helpers de agregación (puros)
// ─────────────────────────────────────────────────────────────────

export interface AdSpendTotals {
  meta: number;
  tiktok: number;
  other: number;
  total: number;
  byPaymentMethod: Record<AdPaymentMethod, number>;
}

export function aggregateSpend(rows: AdSpendRow[]): AdSpendTotals {
  const out: AdSpendTotals = {
    meta: 0,
    tiktok: 0,
    other: 0,
    total: 0,
    byPaymentMethod: {
      mastercard_usd: 0,
      mastercard_cop: 0,
      amex_cop: 0,
      wallet: 0,
      other: 0,
    },
  };
  for (const r of rows) {
    out[r.platform] += r.amount_cop;
    out.total += r.amount_cop;
    out.byPaymentMethod[r.payment_method] += r.amount_cop;
  }
  return out;
}

/** Lista de meses únicos (descendente) presentes en las filas. */
export function uniqueMonths(rows: AdSpendRow[]): string[] {
  return [...new Set(rows.map((r) => r.year_month))].sort().reverse();
}

/**
 * Hook conveniente: devuelve totales del mes + comparativa con el
 * mes anterior. Útil para el bloque KPI del CFO.
 */
export function useAdSpendCompare(currentYM: string, prevYM: string) {
  const currQ = useMonthlyAdSpend(currentYM);
  const prevQ = useMonthlyAdSpend(prevYM);
  const curr = useMemo(() => aggregateSpend(currQ.data ?? []), [currQ.data]);
  const prev = useMemo(() => aggregateSpend(prevQ.data ?? []), [prevQ.data]);
  return {
    isLoading: currQ.isLoading || prevQ.isLoading,
    isError: currQ.isError || prevQ.isError,
    rows: currQ.data ?? [],
    curr,
    prev,
  };
}

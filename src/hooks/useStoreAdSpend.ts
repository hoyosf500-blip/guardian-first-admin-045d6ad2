import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useActiveStoreId } from '@/contexts/StoreContext';

// Pauta diaria por tienda (Meta/TikTok). Store-scoped, manager-only vía RLS.
// El monto va en la moneda de la tienda (COP en CO, USD en EC).

export type AdPlatform = 'meta' | 'tiktok' | 'other';

export const PLATFORM_LABEL: Record<AdPlatform, string> = {
  meta: 'Meta',
  tiktok: 'TikTok',
  other: 'Otro',
};

export interface StoreAdSpendRow {
  id: string;
  store_id: string;
  spend_date: string;   // 'YYYY-MM-DD'
  platform: AdPlatform;
  amount: number;
  notas: string | null;
  created_at: string;
  updated_at: string;
}

const VALID_PLATFORMS: AdPlatform[] = ['meta', 'tiktok', 'other'];

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { const n = Number(v); return isFinite(n) ? n : 0; }
  return 0;
}

function parseRow(raw: unknown): StoreAdSpendRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const platform = String(o.platform ?? '');
  if (!VALID_PLATFORMS.includes(platform as AdPlatform)) return null;
  return {
    id: String(o.id ?? ''),
    store_id: String(o.store_id ?? ''),
    spend_date: String(o.spend_date ?? ''),
    platform: platform as AdPlatform,
    amount: toNumber(o.amount),
    notas: typeof o.notas === 'string' ? o.notas : null,
    created_at: String(o.created_at ?? ''),
    updated_at: String(o.updated_at ?? ''),
  };
}

export interface AdSpendTotals { meta: number; tiktok: number; other: number; total: number; }

/** Suma pura por canal + total. */
export function sumAdSpend(rows: StoreAdSpendRow[]): AdSpendTotals {
  const out: AdSpendTotals = { meta: 0, tiktok: 0, other: 0, total: 0 };
  for (const r of rows) {
    out[r.platform] += r.amount;
    out.total += r.amount;
  }
  return out;
}

/**
 * Filas de pauta de la tienda activa en un rango de fechas (desc).
 * Degradación: si la tabla no existe todavía (migration sin aplicar), el query
 * TIRA el error y react-query lo expone en `isError` (retry:false). Los consumidores
 * usan `data ?? []` para que "Cómo voy" nunca se rompa; el panel muestra "aún no activo".
 */
export function useStoreAdSpendRange(fromDate: string, toDate: string) {
  const storeId = useActiveStoreId();
  return useQuery<StoreAdSpendRow[]>({
    queryKey: ['store-ad-spend', storeId, fromDate, toDate],
    queryFn: async () => {
      // tabla nueva, aún no en los tipos autogenerados → cast a any para el .from()
      const { data, error } = await (supabase as unknown as {
        from: (t: string) => any;
      }).from('store_ad_spend_daily')
        .select('*')
        .eq('store_id', storeId)
        .gte('spend_date', fromDate)
        .lte('spend_date', toDate)
        .order('spend_date', { ascending: false });
      if (error) throw error;
      const rows = Array.isArray(data) ? data : [];
      return rows.map(parseRow).filter((r): r is StoreAdSpendRow => r !== null);
    },
    staleTime: 60_000,
    retry: false,
    enabled: Boolean(fromDate && toDate && storeId),
  });
}

export interface UpsertStoreAdSpendParams {
  store_id: string;
  spend_date: string;
  platform: AdPlatform;
  amount: number;
  notas: string;
}

export function useUpsertStoreAdSpend() {
  const qc = useQueryClient();
  return useMutation<StoreAdSpendRow, Error, UpsertStoreAdSpendParams>({
    mutationFn: async (params) => {
      // .bind(supabase): preserva el `this` del método (sin bind: "Cannot read properties of undefined (reading 'rest')").
      const rpc = supabase.rpc.bind(supabase) as unknown as (
        fn: string, args: Record<string, unknown>
      ) => Promise<{ data: unknown; error: { message?: string } | null }>;
      const { data, error } = await rpc('upsert_store_ad_spend_daily', {
        p_store_id: params.store_id,
        p_spend_date: params.spend_date,
        p_platform: params.platform,
        p_amount: params.amount,
        p_notas: params.notas,
      });
      if (error) throw new Error(error.message || 'Error guardando pauta');
      const row = parseRow(data);
      if (!row) throw new Error('Respuesta inesperada del servidor');
      return row;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['store-ad-spend'] }); },
  });
}

export function useDeleteStoreAdSpend() {
  const qc = useQueryClient();
  return useMutation<boolean, Error, string>({
    mutationFn: async (id: string) => {
      const rpc = supabase.rpc.bind(supabase) as unknown as (
        fn: string, args: Record<string, unknown>
      ) => Promise<{ data: unknown; error: { message?: string } | null }>;
      const { data, error } = await rpc('delete_store_ad_spend_daily', { p_id: id });
      if (error) throw new Error(error.message || 'Error eliminando pauta');
      return Boolean(data);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['store-ad-spend'] }); },
  });
}

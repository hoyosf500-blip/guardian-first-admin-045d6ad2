import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useActiveStoreId } from '@/contexts/StoreContext';
import { isRpcMissing } from '@/lib/rpcError';
import { toast } from 'sonner';

// Costos mensuales de logística (pauta Meta/TikTok + costos admin) que alimentan
// el "Neto Real" de "Cómo voy". Tabla store-scoped `logistica_monthly_costs` +
// RPC `upsert_logistica_monthly_costs` (ver migration 20260623171500).
//
// EXCLUSIVO de logística — NO usa monthly_ad_spend / monthly_business_inputs del
// CFO (esos son admin-only y aparte).

export interface LogisticaMonthlyCosts {
  pauta_meta: number;
  pauta_tiktok: number;
  costos_admin: number;
}

const ZERO: LogisticaMonthlyCosts = { pauta_meta: 0, pauta_tiktok: 0, costos_admin: 0 };

function num(v: unknown): number {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

// El cliente generado (types.ts) aún no conoce esta tabla/RPC — se regeneran al
// aplicar la migration. Casteamos `as unknown as` igual que el resto del repo
// (ver useMonthlyAdSpend para upsert_monthly_ad_spend).
type LooseFrom = (table: string) => {
  select: (cols: string) => {
    eq: (col: string, val: string) => {
      eq: (col: string, val: string) => {
        maybeSingle: () => Promise<{ data: Record<string, unknown> | null; error: unknown }>;
      };
    };
  };
};

/**
 * Lee los costos del mes para la tienda activa. DEGRADA ELEGANTE: si la tabla aún
 * no está aplicada (migration pendiente), no hay fila, o el usuario no tiene
 * permiso → devuelve CEROS en vez de romper la pantalla (el Neto muestra el
 * operativo sin restar nada y los inputs en 0).
 */
export function useLogisticaMonthlyCosts(yearMonth: string) {
  const storeId = useActiveStoreId();
  return useQuery<LogisticaMonthlyCosts>({
    queryKey: ['logistica-monthly-costs', storeId ?? 'all', yearMonth],
    enabled: Boolean(storeId && yearMonth),
    staleTime: 60_000,
    queryFn: async () => {
      const from = supabase.from as unknown as LooseFrom;
      const { data, error } = await from('logistica_monthly_costs')
        .select('pauta_meta, pauta_tiktok, costos_admin')
        .eq('store_id', storeId as string)
        .eq('year_month', yearMonth)
        .maybeSingle();
      // Tabla no aplicada → ZERO (intencional). Sin fila → ZERO (el dueño aún no
      // cargó costos, válido). PERO un error REAL (permiso/500 transitorio) se
      // re-lanza → React Query reintenta, en vez de mostrar los costos guardados
      // en 0 e inflar el Neto Real sin señal. Ver [[rpcError]].
      if (error && !isRpcMissing(error)) throw error;
      if (error || !data) return ZERO;
      return {
        pauta_meta: num(data.pauta_meta),
        pauta_tiktok: num(data.pauta_tiktok),
        costos_admin: num(data.costos_admin),
      };
    },
  });
}

export interface UpsertLogisticaCostsVars extends LogisticaMonthlyCosts {
  yearMonth: string;
}

export function useUpsertLogisticaMonthlyCosts() {
  const qc = useQueryClient();
  const storeId = useActiveStoreId();
  return useMutation<unknown, Error, UpsertLogisticaCostsVars>({
    mutationFn: async (vars) => {
      if (!storeId) throw new Error('Sin tienda activa');
      // .bind(supabase) preserva el `this` del método (mismo patrón que
      // useMonthlyAdSpend; sin bind explota con "Cannot read properties of undefined").
      const rpc = supabase.rpc.bind(supabase) as unknown as (
        fn: string, args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message?: string } | null }>;
      const { data, error } = await rpc('upsert_logistica_monthly_costs', {
        p_store_id: storeId,
        p_year_month: vars.yearMonth,
        p_pauta_meta: vars.pauta_meta,
        p_pauta_tiktok: vars.pauta_tiktok,
        p_costos_admin: vars.costos_admin,
      });
      if (error) throw new Error(error.message || 'Error guardando costos');
      return data;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['logistica-monthly-costs', storeId ?? 'all', vars.yearMonth] });
      toast.success('Costos del mes guardados.');
    },
    onError: (err) => {
      // Si la migration no está aplicada todavía, el upsert falla — avisamos sin romper.
      toast.error(`No se pudo guardar: ${err.message}. ¿Aplicaste la migration?`);
    },
  });
}

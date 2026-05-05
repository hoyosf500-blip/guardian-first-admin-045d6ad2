import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

// Hooks del panel /cfo "Cómo voy". Lee inputs manuales mensuales
// (gasto pauta, pagos a tarjeta, intereses) y el setting global de
// costos fijos mensuales. Vive en una tabla aparte de orders/wallet
// porque son datos que solo el dueño edita a mano cada mes.

export interface MonthlyBusinessInputs {
  id: string;
  year_month: string;       // 'YYYY-MM'
  ads_meta: number;
  ads_tiktok: number;
  tarjeta_pago: number;
  tarjeta_interes: number;
  notas: string | null;
  created_at: string;
  updated_at: string;
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return isFinite(n) ? n : 0;
  }
  return 0;
}

function parseRow(raw: unknown): MonthlyBusinessInputs | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  return {
    id: String(o.id ?? ''),
    year_month: String(o.year_month ?? ''),
    ads_meta: toNumber(o.ads_meta),
    ads_tiktok: toNumber(o.ads_tiktok),
    tarjeta_pago: toNumber(o.tarjeta_pago),
    tarjeta_interes: toNumber(o.tarjeta_interes),
    notas: typeof o.notas === 'string' ? o.notas : null,
    created_at: String(o.created_at ?? ''),
    updated_at: String(o.updated_at ?? ''),
  };
}

/** Trae el row de monthly_business_inputs para un mes dado (puede ser null). */
export function useMonthlyBusinessInputs(yearMonth: string) {
  return useQuery<MonthlyBusinessInputs | null>({
    queryKey: ['monthly-business-inputs', yearMonth],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('monthly_business_inputs')
        .select('*')
        .eq('year_month', yearMonth)
        .maybeSingle();
      if (error) {
        // PGRST116 = no rows returned. Es válido — significa que el mes
        // todavía no tiene inputs cargados. Devolvemos null.
        if ((error as { code?: string }).code === 'PGRST116') return null;
        throw error;
      }
      return parseRow(data);
    },
    enabled: Boolean(yearMonth),
    staleTime: 60_000,
  });
}

/** Lee app_settings.costos_fijos_mensuales (text, lo parseamos a número). */
export function useCostosFijosMensuales() {
  return useQuery<number>({
    queryKey: ['app-setting', 'costos_fijos_mensuales'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', 'costos_fijos_mensuales')
        .maybeSingle();
      if (error) throw error;
      const raw = (data as { value?: string } | null)?.value;
      return toNumber(raw);
    },
    staleTime: 5 * 60_000,
  });
}

export interface UpsertMonthlyInputsParams {
  year_month: string;
  ads_meta: number;
  ads_tiktok: number;
  tarjeta_pago: number;
  tarjeta_interes: number;
  notas: string;
}

/** Upsert por year_month via RPC (admin-only, validación server-side). */
export function useUpsertMonthlyInputs() {
  const qc = useQueryClient();
  return useMutation<MonthlyBusinessInputs, Error, UpsertMonthlyInputsParams>({
    mutationFn: async (params) => {
      const rpc = supabase.rpc as unknown as (
        fn: string, args: Record<string, unknown>
      ) => Promise<{ data: unknown; error: { message?: string } | null }>;
      const { data, error } = await rpc('upsert_monthly_business_inputs', {
        p_year_month: params.year_month,
        p_ads_meta: params.ads_meta,
        p_ads_tiktok: params.ads_tiktok,
        p_tarjeta_pago: params.tarjeta_pago,
        p_tarjeta_interes: params.tarjeta_interes,
        p_notas: params.notas,
      });
      if (error) throw new Error(error.message || 'Error guardando inputs mensuales');
      const row = parseRow(data);
      if (!row) throw new Error('Respuesta inesperada del servidor');
      return row;
    },
    onSuccess: (row) => {
      qc.setQueryData(['monthly-business-inputs', row.year_month], row);
      qc.invalidateQueries({ queryKey: ['monthly-business-inputs'] });
    },
  });
}

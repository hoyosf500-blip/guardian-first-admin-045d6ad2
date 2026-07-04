import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Horario laboral por tienda (minutos-del-día Bogotá), columnas de `stores`
 * agregadas en la migration 20260703210000. Alimenta las advertencias de
 * inactividad (useInactivityGuard) y el form de Admin.
 */
export interface StoreScheduleMinutes {
  work_start_min: number;
  work_end_min: number;
  lunch_start_min: number;
  lunch_end_min: number;
}

/** Default histórico 9:00–17:00 con almuerzo 12:30–13:30. Es también el DEFAULT
 *  de las columnas nuevas y el fallback si la migration aún no se aplicó. */
export const DEFAULT_SCHEDULE_MINUTES: StoreScheduleMinutes = {
  work_start_min: 540,
  work_end_min: 1020,
  lunch_start_min: 750,
  lunch_end_min: 810,
};

function coerce(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Lee el horario laboral de la tienda. DEFENSIVO: si las columnas no existen
 * todavía (migration no aplicada) o hay cualquier error, devuelve el default
 * 9–17 — nunca rompe el guard de inactividad ni el form de Admin.
 */
export function useStoreSchedule(storeId: string | null) {
  return useQuery<StoreScheduleMinutes>({
    queryKey: ['store_schedule', storeId],
    enabled: !!storeId,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      try {
        const res = await supabase
          .from('stores')
          .select('work_start_min, work_end_min, lunch_start_min, lunch_end_min')
          .eq('id', storeId as string)
          .maybeSingle();
        const data = res.data as Partial<StoreScheduleMinutes> | null;
        if (res.error || !data) return DEFAULT_SCHEDULE_MINUTES;
        return {
          work_start_min: coerce(data.work_start_min, DEFAULT_SCHEDULE_MINUTES.work_start_min),
          work_end_min: coerce(data.work_end_min, DEFAULT_SCHEDULE_MINUTES.work_end_min),
          lunch_start_min: coerce(data.lunch_start_min, DEFAULT_SCHEDULE_MINUTES.lunch_start_min),
          lunch_end_min: coerce(data.lunch_end_min, DEFAULT_SCHEDULE_MINUTES.lunch_end_min),
        };
      } catch {
        return DEFAULT_SCHEDULE_MINUTES;
      }
    },
  });
}

/** Guarda el horario vía RPC update_store_schedule (valida manager server-side). */
export function useUpdateStoreSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { storeId: string } & StoreScheduleMinutes) => {
      const { error } = await (
        supabase.rpc as unknown as (
          fn: 'update_store_schedule',
          args: {
            p_store_id: string;
            p_work_start_min: number;
            p_work_end_min: number;
            p_lunch_start_min: number;
            p_lunch_end_min: number;
          },
        ) => Promise<{ error: { message?: string } | null }>
      )('update_store_schedule', {
        p_store_id: vars.storeId,
        p_work_start_min: vars.work_start_min,
        p_work_end_min: vars.work_end_min,
        p_lunch_start_min: vars.lunch_start_min,
        p_lunch_end_min: vars.lunch_end_min,
      });
      if (error) throw new Error(error.message || 'No se pudo guardar el horario');
    },
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ['store_schedule', vars.storeId] });
    },
  });
}

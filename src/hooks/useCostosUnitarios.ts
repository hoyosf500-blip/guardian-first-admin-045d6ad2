import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useActiveStoreId } from '@/contexts/StoreContext';
import { isRpcMissing } from '@/lib/rpcError';
import type { CostosCrudos } from '@/lib/costosUnitarios';

// Costos unitarios reales del período (migration 20260806180000).
//
// Devuelve `null` cuando el RPC todavía no está desplegado, para que la tarjeta
// pueda decir "falta la migración" en vez de dibujar costos en cero, que se leen
// como "no te cuesta nada". Un error REAL se re-lanza y React Query reintenta.
// Ver [[rpcError]].

function num(v: unknown): number {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

export function useCostosUnitarios(from: string, to: string, ciudad?: string | null) {
  const storeId = useActiveStoreId();
  const ciudadKey = ciudad?.trim() || null;
  return useQuery<CostosCrudos | null>({
    queryKey: ['costos-unitarios', storeId ?? 'none', from, to, ciudadKey],
    enabled: Boolean(storeId && from && to),
    staleTime: 60_000,
    queryFn: async () => {
      // .bind preserva el `this` — ver [[rpc_supabase_binding_pattern]].
      const rpc = supabase.rpc.bind(supabase) as unknown as (
        fn: string, args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;
      const { data, error } = await rpc('costos_unitarios', {
        p_from_date: from, p_to_date: to, p_ciudad: ciudadKey,
      });
      if (error) {
        if (isRpcMissing(error)) return null;
        throw error;
      }
      const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        entregados: num(row.entregados),
        devueltos: num(row.devueltos),
        ingresos_entregados: num(row.ingresos_entregados),
        cogs_entregados: num(row.cogs_entregados),
        flete_entregados: num(row.flete_entregados),
        flete_devueltos: num(row.flete_devueltos),
        cargo_devolucion_total: num(row.cargo_devolucion_total),
        devoluciones_con_cargo: num(row.devoluciones_con_cargo),
        pauta_periodo: num(row.pauta_periodo),
      };
    },
  });
}

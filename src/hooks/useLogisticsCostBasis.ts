import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useActiveStoreId } from '@/contexts/StoreContext';

// Base de costos REAL (COGS + flete + ingresos de los entregados) de la tienda
// activa, para el simulador de unit-economics de "/logistica → Cómo voy".
//
// RPC store-scoped `logistics_cost_basis` (migration 20260623210000, _resolve_scope_store).
// COGS y flete viven hoy en financial_summary/product_profitability (admin-only) —
// este RPC los expone SOLO para el store del usuario. Si no está desplegado aún,
// la query devuelve null → el simulador avisa "aplicá la migration" y degrada a
// inputs editables en cero (NO rompe). Mismo patrón que useOperativoCohorte.

export interface LogisticsCostBasis {
  entregados: number;
  ingresos_entregados: number;
  cogs_entregados: number;
  flete_entregados: number;
}

function num(v: unknown): number {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

export function useLogisticsCostBasis(from: string, to: string, ciudad?: string) {
  const storeId = useActiveStoreId();
  const ciudadKey = ciudad?.trim() || null;
  return useQuery<LogisticsCostBasis | null>({
    queryKey: ['logistics-cost-basis', storeId ?? 'all', from, to, ciudadKey],
    enabled: Boolean(from && to),
    staleTime: 60_000,
    queryFn: async () => {
      // .bind(supabase) preserva el `this` del método (mismo patrón que useOperativoCohorte).
      const rpc = supabase.rpc.bind(supabase) as unknown as (
        fn: string, args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message?: string } | null }>;
      const { data, error } = await rpc('logistics_cost_basis', {
        p_from_date: from,
        p_to_date: to,
        p_ciudad: ciudadKey,
      });
      // RPC no desplegado / sin permiso → null → el simulador degrada.
      if (error) return null;
      // El RPC devuelve TABLE (1 fila) → el cliente lo entrega como array.
      const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        entregados: num(row.entregados),
        ingresos_entregados: num(row.ingresos_entregados),
        cogs_entregados: num(row.cogs_entregados),
        flete_entregados: num(row.flete_entregados),
      };
    },
  });
}

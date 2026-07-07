import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useActiveStoreId } from '@/contexts/StoreContext';

// Hook del bloque "Rentabilidad por producto" en /logistica.
// Llama RPC product_profitability que desglosa cuánta plata gana o
// pierde por producto en un rango de fechas, considerando entregados,
// devueltos, cancelados y en tránsito (con proyección).

export interface ProductProfitabilityRow {
  producto: string;
  total_pedidos: number;
  entregados: number;
  devueltos: number;
  cancelados: number;
  en_transito: number;
  ingresos_entregados: number;
  costo_prod_entregados: number;
  flete_inicial_entregados: number;
  costo_devolucion_total: number;
  utilidad_real: number;
  utilidad_proyectada: number;
  tasa_entrega: number;        // 0..100
  tasa_devolucion: number;     // 0..100
  tasa_cancelacion: number;    // 0..100
  ticket_promedio: number;
  margen_pct: number;          // 0..100
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return isFinite(n) ? n : 0;
  }
  return 0;
}

function parseRow(raw: unknown): ProductProfitabilityRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  return {
    producto: String(o.producto ?? ''),
    total_pedidos: toNumber(o.total_pedidos),
    entregados: toNumber(o.entregados),
    devueltos: toNumber(o.devueltos),
    cancelados: toNumber(o.cancelados),
    en_transito: toNumber(o.en_transito),
    ingresos_entregados: toNumber(o.ingresos_entregados),
    costo_prod_entregados: toNumber(o.costo_prod_entregados),
    flete_inicial_entregados: toNumber(o.flete_inicial_entregados),
    costo_devolucion_total: toNumber(o.costo_devolucion_total),
    utilidad_real: toNumber(o.utilidad_real),
    utilidad_proyectada: toNumber(o.utilidad_proyectada),
    tasa_entrega: toNumber(o.tasa_entrega),
    tasa_devolucion: toNumber(o.tasa_devolucion),
    tasa_cancelacion: toNumber(o.tasa_cancelacion),
    ticket_promedio: toNumber(o.ticket_promedio),
    margen_pct: toNumber(o.margen_pct),
  };
}

interface RpcResult<T> {
  data: T[] | null;
  error: { message?: string } | null;
}

export interface UseProductProfitabilityParams {
  fromDate: string;   // 'YYYY-MM-DD'
  toDate: string;     // 'YYYY-MM-DD'
  limit?: number;
}

export function useProductProfitability(
  params: UseProductProfitabilityParams,
): UseQueryResult<ProductProfitabilityRow[]> {
  const { fromDate, toDate, limit = 100 } = params;
  // storeId en la key: la RPC resuelve la tienda server-side — sin esto el
  // cambio de tienda servía el cache de la anterior (auditoría 2026-07-07).
  const storeId = useActiveStoreId();
  return useQuery<ProductProfitabilityRow[]>({
    queryKey: ['product-profitability', storeId ?? 'none', fromDate, toDate, limit],
    queryFn: async () => {
      // .bind(supabase): preserva `this`. Sin bind, el método se invoca
      // con `this === undefined` y supabase-js explota leyendo `this.rest`.
      const rpc = supabase.rpc.bind(supabase) as unknown as (
        fn: string, args: Record<string, unknown>
      ) => Promise<RpcResult<unknown>>;
      const { data, error } = await rpc('product_profitability', {
        p_from_date: fromDate,
        p_to_date: toDate,
        p_limit: limit,
      });
      if (error) throw new Error(error.message || 'Error cargando rentabilidad por producto');
      const rows = Array.isArray(data) ? data : [];
      return rows.map(parseRow).filter((r): r is ProductProfitabilityRow => r !== null);
    },
    staleTime: 5 * 60 * 1000,
    enabled: Boolean(fromDate && toDate && storeId),
  });
}

// ─────────────────────────────────────────────────────────────────
// Helpers semánticos para la UI
// ─────────────────────────────────────────────────────────────────

export type ProfitTone = 'success' | 'warning' | 'danger' | 'muted';

/** Tono según margen % (verde >25%, amarillo 10-25%, rojo <10%, neutro sin entregas). */
export function marginTone(row: ProductProfitabilityRow): ProfitTone {
  if (row.entregados === 0) return 'muted';
  if (row.utilidad_real < 0) return 'danger';
  if (row.margen_pct >= 25) return 'success';
  if (row.margen_pct >= 10) return 'warning';
  return 'danger';
}

/** Suma totales del array (útil para footer de la tabla). */
export interface ProductTotals {
  total_pedidos: number;
  entregados: number;
  devueltos: number;
  cancelados: number;
  en_transito: number;
  ingresos_entregados: number;
  utilidad_real: number;
  utilidad_proyectada: number;
}

export function aggregateProductTotals(rows: ProductProfitabilityRow[]): ProductTotals {
  return rows.reduce<ProductTotals>(
    (acc, r) => ({
      total_pedidos: acc.total_pedidos + r.total_pedidos,
      entregados: acc.entregados + r.entregados,
      devueltos: acc.devueltos + r.devueltos,
      cancelados: acc.cancelados + r.cancelados,
      en_transito: acc.en_transito + r.en_transito,
      ingresos_entregados: acc.ingresos_entregados + r.ingresos_entregados,
      utilidad_real: acc.utilidad_real + r.utilidad_real,
      utilidad_proyectada: acc.utilidad_proyectada + r.utilidad_proyectada,
    }),
    {
      total_pedidos: 0, entregados: 0, devueltos: 0, cancelados: 0, en_transito: 0,
      ingresos_entregados: 0, utilidad_real: 0, utilidad_proyectada: 0,
    },
  );
}

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Último intento de push Shopify→Dropi por pedido (tabla `shopify_pushed_orders`,
 * UNIQUE(store_id, shopify_order_id) → a lo sumo una fila por pedido).
 *
 * El panel anti-fuga lo usa para que cada fila pendiente muestre SU razón de
 * no-pasar: un intento previo que falló (con el motivo real, ej. "producto sin
 * stock en bodega"), un intento indeterminado (claim 'pending' que quedó a
 * medias), o un 'created' cuyo teléfono no matcheó en el reconcile.
 */
export interface PushAttempt {
  shopify_order_id: string;
  status: string;               // 'created' | 'error' | 'pending' (claim)
  error_message: string | null;
  dropi_order_id: string | null;
  pushed_at: string;
}

const EMPTY: Map<string, PushAttempt> = new Map();

export function useShopifyPushAttempts(storeId: string | null, shopifyOrderIds: string[]) {
  // Clave estable (ordenada) para que el re-orden de la lista no re-fetchee.
  const key = useMemo(() => [...shopifyOrderIds].sort().join(','), [shopifyOrderIds]);

  const query = useQuery<Map<string, PushAttempt>>({
    queryKey: ['shopify_push_attempts', storeId, key],
    enabled: !!storeId && shopifyOrderIds.length > 0,
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      if (!storeId || shopifyOrderIds.length === 0) return EMPTY;
      const { data, error } = await supabase
        .from('shopify_pushed_orders')
        .select('shopify_order_id, status, error_message, dropi_order_id, pushed_at')
        .eq('store_id', storeId)
        .in('shopify_order_id', shopifyOrderIds);
      // Feature informativa: si la lectura falla (RLS, tabla, red) degradamos a
      // vacío — las filas simplemente no muestran el motivo previo, nada se rompe.
      if (error) return EMPTY;
      const map = new Map<string, PushAttempt>();
      for (const r of (data ?? []) as PushAttempt[]) map.set(r.shopify_order_id, r);
      return map;
    },
  });

  return {
    attempts: query.data ?? EMPTY,
    isLoading: query.isLoading,
    refetch: query.refetch,
  };
}

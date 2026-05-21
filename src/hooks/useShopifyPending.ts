import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface ShopifyPendingItem {
  id: string;
  name: string;        // "#1234"
  customer: string;
  phone: string;
  total: number;
  created_at: string;
  city: string;
  sin_telefono?: boolean;
  admin_url: string;
}

export interface ShopifyReconcileResult {
  ok: boolean;
  configured: boolean;
  pendingCount: number;
  shopifyTotal?: number;
  days?: number;
  pending: ShopifyPendingItem[];
  error?: string;
}

/**
 * Cruza los pedidos de Shopify de la tienda activa contra los de Dropi
 * (vía edge function `shopify-reconcile`) y devuelve los pendientes de pasar
 * a Dropi. Solo corre si hay tienda activa. No re-fetchea al volver de
 * pestaña (lo maneja el botón "Actualizar" + un poll suave en el panel).
 */
export function useShopifyPending(storeId: string | null) {
  return useQuery<ShopifyReconcileResult>({
    queryKey: ['shopify_pending', storeId],
    enabled: !!storeId,
    refetchOnWindowFocus: false,
    staleTime: 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('shopify-reconcile', {
        body: { store_id: storeId, days: 3 },
      });
      if (error) {
        // La edge function puede devolver el detalle en context.body.
        const ctx = (error as unknown as { context?: { body?: string } }).context;
        if (ctx?.body) {
          try { return JSON.parse(ctx.body) as ShopifyReconcileResult; } catch { /* noop */ }
        }
        throw error;
      }
      return data as ShopifyReconcileResult;
    },
  });
}

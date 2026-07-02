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

export interface ShopifyDayBreakdown {
  date: string;       // YYYY-MM-DD (TZ America/Bogota)
  shopify: number;
  matched: number;
  pending: number;
}

/** Pedido que YA está en Dropi pero con un valor MAYOR al total de Shopify
 *  (descuento perdido u otra causa). Se reporta para que el operador lo corrija
 *  a mano en Dropi sin tener que revisar pedido por pedido. */
export interface ShopifyValueMismatch {
  shopify_name: string;   // "#1234"
  admin_url: string;      // link al pedido en Shopify
  customer: string;
  phone: string;
  shopify_total: number;  // lo que el cliente aceptó pagar
  dropi_valor: number;    // lo que Dropi va a cobrar (de más)
  overcharge: number;     // dropi_valor - shopify_total
  external_id: string;    // id de la orden en Dropi (para ubicarla)
  estado: string;         // estado en Dropi (saber si ya tiene guía)
  created_at: string;
}

export interface ShopifyReconcileResult {
  ok: boolean;
  configured: boolean;
  days?: number;
  shopifyTotal?: number;     // válidos del período (sin cancelados)
  cancelledCount?: number;
  matchedCount?: number;     // ya están en Dropi
  pendingCount: number;      // faltan pasar a Dropi
  today?: string;            // YYYY-MM-DD
  todayShopify?: number;
  todayMatched?: number;
  todayPending?: number;
  byDay?: ShopifyDayBreakdown[];
  pending: ShopifyPendingItem[];
  valueMismatchCount?: number;
  valueMismatches?: ShopifyValueMismatch[];
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
        body: { store_id: storeId, days: 7 },
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

/**
 * Pedidos que YA están en Dropi con valor distinto (cobro de más) al de Shopify.
 * Usa la MISMA edge function `shopify-reconcile` pero con una ventana más amplia
 * (30 días) para cubrir el backlog, y solo lee `valueMismatches`. Aparte del hook
 * de pendientes (ventana 7d) para no inflar la cola ni el poll frecuente.
 */
export function useShopifyValueMismatches(storeId: string | null) {
  return useQuery<ShopifyReconcileResult>({
    queryKey: ['shopify_value_mismatches', storeId],
    enabled: !!storeId,
    refetchOnWindowFocus: false,
    staleTime: 10 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('shopify-reconcile', {
        body: { store_id: storeId, days: 30 },
      });
      if (error) {
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

import { useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface PushClient {
  name: string; surname: string; phone: string;
  dir: string; city: string; state: string; email: string; notes: string;
}
export interface PushProduct {
  title: string; sku: string; product_id: number; variant_id: number;
  quantity: number; price: number; dropiId: number | null; variationId: number | null;
}
export interface PushUnmapped { title: string; sku: string; product_id: number; reason?: string }

export interface PushPreview {
  ok: boolean;
  mode?: 'preview';
  shopify_order_id?: string;
  shopify_name?: string;
  client?: PushClient;
  products?: PushProduct[];
  total?: number;
  unmapped?: PushUnmapped[];
  diagnostic?: string | null;   // causa raíz cuando hay productos sin vínculo (ej. falta read_products)
  alreadyPushed?: boolean;
  dropi_order_id?: string | null;
  error?: string;
}

export interface PushResult {
  ok: boolean;
  dropi_order_id?: string | null;
  shopify_name?: string;
  error?: string;
  unmapped?: PushUnmapped[];
  diagnostic?: string | null;
}

export interface PushOverrides {
  client?: Partial<PushClient>;
  lines?: Record<string, { price?: number; quantity?: number }>;
}

/** Lee la respuesta de la edge function aunque venga como error HTTP (4xx/5xx
 *  con cuerpo JSON en context.body). */
function parseInvoke<T>(data: unknown, error: unknown): T {
  if (error) {
    const ctx = (error as { context?: { body?: string } }).context;
    if (ctx?.body) { try { return JSON.parse(ctx.body) as T; } catch { /* noop */ } }
    return { ok: false, error: (error as { message?: string }).message || 'error' } as T;
  }
  return data as T;
}

/**
 * Sube un pedido de Shopify a Dropi (estilo Dropify) vía edge function
 * `shopify-push-dropi`. `preview` arma cliente+productos sin crear; `confirm`
 * crea la orden en Dropi (idempotente por shopify_order_id).
 */
export function usePushToDropi(storeId: string | null) {
  const preview = useCallback(async (shopifyOrderId: string): Promise<PushPreview> => {
    if (!storeId) return { ok: false, error: 'Sin tienda activa' };
    const { data, error } = await supabase.functions.invoke('shopify-push-dropi', {
      body: { store_id: storeId, shopify_order_id: shopifyOrderId, mode: 'preview' },
    });
    return parseInvoke<PushPreview>(data, error);
  }, [storeId]);

  const confirm = useCallback(async (shopifyOrderId: string, overrides?: PushOverrides): Promise<PushResult> => {
    if (!storeId) return { ok: false, error: 'Sin tienda activa' };
    const { data, error } = await supabase.functions.invoke('shopify-push-dropi', {
      body: { store_id: storeId, shopify_order_id: shopifyOrderId, mode: 'confirm', overrides: overrides ?? {} },
    });
    return parseInvoke<PushResult>(data, error);
  }, [storeId]);

  /** Vincula un producto de Shopify con su id de Dropi (mapeo manual por tienda,
   *  estilo Dropify). Se usa cuando el producto NO se importó con la app de Dropi
   *  y por eso no tiene el metafield (caso típico: catálogo cargado a mano). */
  const linkProduct = useCallback(async (
    shopifyProductId: number, dropiProductId: number, dropiVariationId?: number | null,
  ): Promise<{ ok: boolean; error?: string }> => {
    if (!storeId) return { ok: false, error: 'Sin tienda activa' };
    const args: { p_store_id: string; p_shopify_product_id: number; p_dropi_product_id: number; p_dropi_variation_id?: number } = {
      p_store_id: storeId, p_shopify_product_id: shopifyProductId, p_dropi_product_id: dropiProductId,
    };
    if (dropiVariationId != null) args.p_dropi_variation_id = dropiVariationId;
    const { error } = await supabase.rpc('upsert_shopify_product_dropi_map', args);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }, [storeId]);

  return { preview, confirm, linkProduct };
}

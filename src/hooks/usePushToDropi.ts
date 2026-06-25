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

export interface DropiVariationHit { id: number; name: string; sku?: string }
export interface DropiProductHit { id: number; name: string; type: string; sku?: string; price?: number; variations?: DropiVariationHit[]; image?: string; description?: string }
export interface ShopifyProductLite { id: number; title: string; image: string | null; status?: string | null }

export interface PushPreview {
  ok: boolean;
  mode?: 'preview';
  shopify_order_id?: string;
  shopify_name?: string;
  client?: PushClient;
  products?: PushProduct[];
  total?: number;
  shipping?: number;            // envío prioritario (sin id de Dropi) — se suma al total COD
  unmapped?: PushUnmapped[];
  diagnostic?: string | null;   // causa raíz cuando hay productos sin vínculo (ej. falta read_products)
  alreadyPushed?: boolean;
  dropi_order_id?: string | null;
  shopify_total?: number;   // total real de Shopify (lo que el cliente aceptó)
  cod_mismatch?: boolean;   // true si el COD calculado supera el total de Shopify
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

/** Lee la respuesta de la edge function aunque venga como error HTTP (4xx/5xx).
 *  En supabase-js v2, cuando la función responde un status no-2xx, `error.context`
 *  es un objeto `Response` (su `.body` es un stream, NO un string). Hay que leer
 *  el cuerpo con `await ctx.text()` para sacar el motivo real (ej. el rechazo de
 *  Dropi); antes se intentaba `JSON.parse(ctx.body)` y siempre fallaba, dejando
 *  el mensaje genérico "Edge Function returned a non-2xx status code". */
async function parseInvoke<T>(data: unknown, error: unknown): Promise<T> {
  if (error) {
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.text === 'function') {
      try {
        const body = await ctx.text();
        if (body) {
          try { return JSON.parse(body) as T; }
          catch { return { ok: false, error: body.slice(0, 500) } as T; }
        }
      } catch { /* no se pudo leer el cuerpo */ }
    }
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
    return await parseInvoke<PushPreview>(data, error);
  }, [storeId]);

  const confirm = useCallback(async (shopifyOrderId: string, overrides?: PushOverrides): Promise<PushResult> => {
    if (!storeId) return { ok: false, error: 'Sin tienda activa' };
    const { data, error } = await supabase.functions.invoke('shopify-push-dropi', {
      body: { store_id: storeId, shopify_order_id: shopifyOrderId, mode: 'confirm', overrides: overrides ?? {} },
    });
    return await parseInvoke<PushResult>(data, error);
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

  /** Busca productos en el catálogo de Dropi (estilo Dropify) por nombre, para
   *  que el operador elija el producto real (id correcto) sin pegar un id a ciegas. */
  const searchDropiProducts = useCallback(async (query: string): Promise<DropiProductHit[]> => {
    if (!storeId || query.trim().length < 2) return [];
    const { data, error } = await supabase.functions.invoke('shopify-push-dropi', {
      body: { store_id: storeId, mode: 'search_products', query: query.trim() },
    });
    const r = await parseInvoke<{ ok: boolean; products?: DropiProductHit[]; error?: string }>(data, error);
    if (!r.ok) throw new Error(r.error || 'No se pudo buscar en Dropi');
    return r.products ?? [];
  }, [storeId]);

  /** Trae UN producto de Dropi por su id (atajo "pegá el ID" en /admin →
   *  Productos del bot). Devuelve el producto (nombre + foto + descripción) o
   *  null si Dropi no lo encontró — el caller decide si vincula igual a ciegas. */
  const getDropiProduct = useCallback(async (dropiProductId: number): Promise<DropiProductHit | null> => {
    if (!storeId || !Number.isFinite(dropiProductId) || dropiProductId <= 0) return null;
    const { data, error } = await supabase.functions.invoke('shopify-push-dropi', {
      body: { store_id: storeId, mode: 'get_product', dropi_product_id: dropiProductId },
    });
    const r = await parseInvoke<{ ok: boolean; product?: DropiProductHit; error?: string }>(data, error);
    if (!r.ok) {
      // 404 (no encontrado) NO es excepción: devolvemos null para vincular a ciegas.
      if (/no se encontró|verificá el id/i.test(r.error || '')) return null;
      throw new Error(r.error || 'No se pudo traer el producto de Dropi');
    }
    return r.product ?? null;
  }, [storeId]);

  /** Lista el catálogo de Shopify de la tienda (para el panel de vínculos en
   *  /admin: marcar qué productos ya están vinculados a Dropi). */
  const listShopifyProducts = useCallback(async (): Promise<ShopifyProductLite[]> => {
    if (!storeId) return [];
    const { data, error } = await supabase.functions.invoke('shopify-push-dropi', {
      body: { store_id: storeId, mode: 'list_shopify_products' },
    });
    const r = await parseInvoke<{ ok: boolean; products?: ShopifyProductLite[]; error?: string }>(data, error);
    if (!r.ok) throw new Error(r.error || 'No se pudieron leer los productos de Shopify');
    return r.products ?? [];
  }, [storeId]);

  return { preview, confirm, linkProduct, searchDropiProducts, getDropiProduct, listShopifyProducts };
}

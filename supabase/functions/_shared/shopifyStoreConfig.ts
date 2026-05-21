// Helper store-aware para leer credenciales de Shopify de una tienda.
// Espejo de _shared/dropiStoreConfig.ts:loadStoreConfig pero para Shopify.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface ShopifyConfig {
  shopDomain: string; // xxxx.myshopify.com (sin protocolo)
  adminToken: string; // shpat_...
}

/** Lee store_shopify_config para una tienda. Devuelve null si no está
 *  configurada (la tienda no conectó Shopify todavía). */
export async function loadShopifyConfig(
  sbAdmin: SupabaseClient,
  storeId: string,
): Promise<ShopifyConfig | null> {
  const { data, error } = await sbAdmin
    .from("store_shopify_config")
    .select("shop_domain, admin_token, active")
    .eq("store_id", storeId)
    .maybeSingle();

  if (error) throw new Error(`No se pudo leer store_shopify_config: ${error.message}`);
  if (!data || !data.active) return null;

  const shopDomain = String(data.shop_domain || "").trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  const adminToken = String(data.admin_token || "").trim();
  if (!shopDomain || !adminToken) return null;

  return { shopDomain, adminToken };
}

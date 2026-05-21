// Helper store-aware para leer credenciales de Shopify de una tienda.
// Espejo de _shared/dropiStoreConfig.ts:loadStoreConfig pero para Shopify.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface ShopifyConfig {
  shopDomain: string;          // xxxx.myshopify.com (sin protocolo)
  adminToken?: string;         // shpat_… estático (apps personalizadas viejas)
  clientId?: string;           // Dev Dashboard: Client ID
  clientSecret?: string;       // Dev Dashboard: Client Secret (shpss_…)
}

/** Lee store_shopify_config para una tienda. Devuelve null si no está
 *  configurada (la tienda no conectó Shopify todavía). Acepta dos modos:
 *  - client_id + client_secret (Dev Dashboard, recomendado) → token vía grant.
 *  - admin_token estático (app personalizada vieja) → token directo. */
export async function loadShopifyConfig(
  sbAdmin: SupabaseClient,
  storeId: string,
): Promise<ShopifyConfig | null> {
  const { data, error } = await sbAdmin
    .from("store_shopify_config")
    .select("shop_domain, admin_token, client_id, client_secret, active")
    .eq("store_id", storeId)
    .maybeSingle();

  if (error) throw new Error(`No se pudo leer store_shopify_config: ${error.message}`);
  if (!data || !data.active) return null;

  const shopDomain = String(data.shop_domain || "").trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  const adminToken = String(data.admin_token || "").trim();
  const clientId = String(data.client_id || "").trim();
  const clientSecret = String(data.client_secret || "").trim();
  if (!shopDomain) return null;
  // Necesita AL MENOS un modo de auth.
  if (!adminToken && !(clientId && clientSecret)) return null;

  return {
    shopDomain,
    adminToken: adminToken || undefined,
    clientId: clientId || undefined,
    clientSecret: clientSecret || undefined,
  };
}

// Cache de tokens en module-scope (sobrevive invocaciones "calientes" del mismo
// worker). Los tokens del client credentials grant viven 24h; cacheamos hasta
// ~1 min antes de vencer para no pegarle al endpoint en cada llamada.
const tokenCache = new Map<string, { token: string; exp: number }>();

/** Devuelve un token de Admin API usable en X-Shopify-Access-Token.
 *  - Si hay client_id + client_secret: client credentials grant (token 24h, cacheado).
 *  - Si solo hay admin_token estático: lo devuelve tal cual.
 *  Lanza si Shopify rechaza el grant (ej. secret equivocado → 401). */
export async function getShopifyAccessToken(cfg: ShopifyConfig): Promise<string> {
  if (cfg.clientId && cfg.clientSecret) {
    const key = `${cfg.shopDomain}:${cfg.clientId}`;
    const cached = tokenCache.get(key);
    if (cached && cached.exp > Date.now() + 60_000) return cached.token;

    const res = await fetch(`https://${cfg.shopDomain}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(
        `Shopify token grant [${res.status}]: ${txt.slice(0, 200)} ` +
          `(revisá Client ID/Secret en /admin → Shopify; el Secret es el shpss_… del Dev Dashboard)`,
      );
    }
    const data = await res.json() as { access_token: string; expires_in?: number };
    const exp = Date.now() + ((data.expires_in ?? 86399) * 1000);
    tokenCache.set(key, { token: data.access_token, exp });
    return data.access_token;
  }

  if (cfg.adminToken) return cfg.adminToken;
  throw new Error("Shopify sin credenciales válidas (ni client_id/secret ni admin_token)");
}

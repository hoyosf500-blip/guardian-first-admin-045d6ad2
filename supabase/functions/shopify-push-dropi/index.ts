// shopify-push-dropi — sube un pedido de Shopify a Dropi (estilo Dropify).
//
// Cuando la automatización Shopify→Dropi falla y deja un pedido sin despachar,
// el operador lo sube con un clic desde el panel anti-fuga. Resolvemos el
// producto de Dropi leyendo el metafield `dropi/_dropi_product` que Dropify deja
// en cada producto de Shopify (trae el id de Dropi) — sin mapeo manual.
//
// Body: { store_id, shopify_order_id, mode: "preview" | "confirm", overrides? }
//   - preview: arma cliente + productos + total y los DEVUELVE (no crea nada).
//   - confirm: crea la orden en Dropi (POST /integrations/orders/myorders),
//              registra en shopify_pushed_orders (idempotente) y devuelve el id.
//   - overrides: { client?: {...}, lines?: { [index]: { price?, quantity? } } }
//
// Auth: Authorization: Bearer <user_jwt> (debe ser miembro de la tienda).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { loadStoreConfig, isStoreMember } from "../_shared/dropiStoreConfig.ts";
import { loadShopifyConfig, getShopifyAccessToken } from "../_shared/shopifyStoreConfig.ts";

const SHOPIFY_API_VERSION = "2024-10";

interface ShopifyLineItem {
  product_id: number;
  variant_id: number;
  title: string;
  name?: string;
  sku?: string;
  quantity: number;
  price: string;
  total_discount?: string;
  variant_title?: string | null;
}
interface ShopifyAddr {
  first_name?: string; last_name?: string; name?: string;
  address1?: string; address2?: string; city?: string; province?: string;
  phone?: string;
}
interface ShopifyOrderFull {
  id: number; name: string; phone?: string | null; email?: string | null; note?: string | null;
  line_items: ShopifyLineItem[];
  shipping_address?: ShopifyAddr | null;
  billing_address?: ShopifyAddr | null;
  customer?: { first_name?: string; last_name?: string; phone?: string } | null;
}

interface ClientFields {
  name: string; surname: string; phone: string;
  dir: string; city: string; state: string; email: string; notes: string;
}
interface ResolvedLine {
  title: string; sku: string; product_id: number; variant_id: number;
  quantity: number; price: number; dropiId: number | null; variationId: number | null;
}
interface Overrides {
  client?: Partial<ClientFields>;
  lines?: Record<string, { price?: number; quantity?: number }>;
}

/** Teléfono usable para Dropi: dígitos, sin código de país. CO=10 díg (3XXXXXXXXX). */
function dropiPhone(raw: string, country: string): string {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (country === "CO" && d.length === 12 && d.startsWith("57")) d = d.slice(2);
  else if (country === "EC" && d.startsWith("593")) d = d.slice(3);
  return d;
}

function json(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...cors, "Content-Type": "application/json" },
  });
}

async function shopifyGet<T>(domain: string, token: string, path: string): Promise<T> {
  const res = await fetch(`https://${domain}/admin/api/${SHOPIFY_API_VERSION}/${path}`, {
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Shopify [${res.status}] ${path}: ${txt.slice(0, 200)}`);
  }
  return await res.json() as T;
}

interface DropiProductMeta { id: number; type?: string; sku?: string; name?: string; variations?: Array<Record<string, unknown>> }

/** Lee el producto de Dropi desde el metafield dropi/_dropi_product (cache por product_id). */
async function resolveDropiProduct(
  domain: string, token: string, productId: number, cache: Map<number, DropiProductMeta | null>,
): Promise<DropiProductMeta | null> {
  if (cache.has(productId)) return cache.get(productId)!;
  let result: DropiProductMeta | null = null;
  try {
    const data = await shopifyGet<{ metafields: Array<{ namespace: string; key: string; value: string }> }>(
      domain, token, `products/${productId}/metafields.json?namespace=dropi`,
    );
    const mf = (data.metafields || []).find((m) => m.key === "_dropi_product");
    if (mf?.value) {
      const parsed = JSON.parse(mf.value) as DropiProductMeta;
      if (parsed && typeof parsed.id === "number") result = parsed;
    }
  } catch (_e) { result = null; }
  cache.set(productId, result);
  return result;
}

Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceKey);

    // Auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ ok: false, error: "No autorizado" }, 401, cors);
    const anonClient = createClient(supabaseUrl, anonKey);
    const { data: { user }, error: authError } = await anonClient.auth.getUser(authHeader.replace("Bearer ", ""));
    if (authError || !user) return json({ ok: false, error: "Token inválido" }, 401, cors);

    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { /* noop */ }
    const storeId = typeof body.store_id === "string" ? body.store_id.trim() : "";
    const shopifyOrderId = String(body.shopify_order_id ?? "").trim();
    const mode = body.mode === "confirm" ? "confirm" : "preview";
    const overrides = (body.overrides ?? {}) as Overrides;
    if (!storeId) return json({ ok: false, error: "Falta store_id" }, 400, cors);
    if (!shopifyOrderId) return json({ ok: false, error: "Falta shopify_order_id" }, 400, cors);

    if (!(await isStoreMember(sb, user.id, storeId))) {
      return json({ ok: false, error: "No sos miembro de esta tienda" }, 403, cors);
    }

    // Config Shopify (token client-credentials) + Dropi (apiKey)
    const shopCfg = await loadShopifyConfig(sb, storeId);
    if (!shopCfg) return json({ ok: false, error: "Shopify no configurado para esta tienda" }, 400, cors);
    const shopToken = await getShopifyAccessToken(shopCfg);
    const dropiCfg = await loadStoreConfig(sb, storeId);
    if (!dropiCfg.apiKey) return json({ ok: false, error: "La tienda no tiene Clave API de Dropi" }, 400, cors);

    // ¿Ya fue subido? (idempotencia / aviso en preview)
    const { data: prior } = await sb
      .from("shopify_pushed_orders")
      .select("dropi_order_id, status")
      .eq("store_id", storeId).eq("shopify_order_id", shopifyOrderId)
      .maybeSingle();
    const alreadyPushed = Boolean(prior && prior.status === "created");

    // Traer la orden completa de Shopify
    const fields = "id,name,line_items,shipping_address,billing_address,customer,phone,note,email";
    const ord = (await shopifyGet<{ order: ShopifyOrderFull }>(
      shopCfg.shopDomain, shopToken,
      `orders/${encodeURIComponent(shopifyOrderId)}.json?fields=${fields}`,
    )).order;
    if (!ord) return json({ ok: false, error: `Pedido ${shopifyOrderId} no existe en Shopify` }, 404, cors);

    const addr = ord.shipping_address || ord.billing_address || {};
    // Cliente base (luego se aplican overrides)
    const base: ClientFields = {
      name: (ord.customer?.first_name || addr.first_name || (addr.name || "").split(" ")[0] || "").trim(),
      surname: (ord.customer?.last_name || addr.last_name || (addr.name || "").split(" ").slice(1).join(" ") || "").trim(),
      phone: dropiPhone(ord.phone || ord.customer?.phone || addr.phone || "", dropiCfg.countryCode),
      dir: [addr.address1, addr.address2].filter(Boolean).join(", ").trim(),
      city: (addr.city || "").trim(),
      state: (addr.province || "").trim(),
      email: (ord.email || "").trim(),
      notes: (ord.note || "").trim(),
    };
    const client: ClientFields = { ...base, ...(overrides.client || {}) };

    // Resolver productos vía metafield dropi/_dropi_product
    const cache = new Map<number, DropiProductMeta | null>();
    const resolved: ResolvedLine[] = [];
    const unmapped: Array<{ title: string; sku: string; product_id: number }> = [];
    for (let i = 0; i < (ord.line_items || []).length; i++) {
      const li = ord.line_items[i];
      const qty = Number(li.quantity) || 1;
      const gross = (Number(li.price) || 0) * qty;
      const disc = Number(li.total_discount || "0") || 0;
      let price = Math.round((gross - disc) / qty);
      const ov = overrides.lines?.[String(i)];
      const finalQty = ov?.quantity != null ? Number(ov.quantity) : qty;
      if (ov?.price != null) price = Number(ov.price);

      const meta = await resolveDropiProduct(shopCfg.shopDomain, shopToken, li.product_id, cache);
      // Variaciones: esta operación es SIMPLE en CO; si hubiera variations,
      // intentar matchear por sku, sino dejar variationId null.
      let variationId: number | null = null;
      if (meta?.variations && meta.variations.length > 0) {
        const match = meta.variations.find((v) => String((v as { sku?: string }).sku || "") === String(li.sku || ""));
        variationId = match ? Number((match as { id?: number }).id) || null : null;
      }
      const line: ResolvedLine = {
        title: li.title || li.name || "", sku: li.sku || "",
        product_id: li.product_id, variant_id: li.variant_id,
        quantity: finalQty, price, dropiId: meta ? Number(meta.id) : null, variationId,
      };
      resolved.push(line);
      if (!meta) unmapped.push({ title: line.title, sku: line.sku, product_id: li.product_id });
    }

    const total = resolved.reduce((s, l) => s + l.price * l.quantity, 0);

    if (mode === "preview") {
      return json({
        ok: true, mode: "preview", shopify_order_id: shopifyOrderId, shopify_name: ord.name,
        client, products: resolved, total, unmapped, alreadyPushed,
        dropi_order_id: prior?.dropi_order_id ?? null,
      }, 200, cors);
    }

    // ----- mode confirm -----
    if (alreadyPushed) {
      return json({ ok: false, error: "Este pedido ya fue subido a Dropi", dropi_order_id: prior?.dropi_order_id ?? null }, 409, cors);
    }
    if (unmapped.length > 0) {
      return json({ ok: false, error: "Hay productos sin vínculo a Dropi (no importados por Dropify)", unmapped }, 422, cors);
    }
    if (!client.name || !client.dir || !client.city || !client.state || !client.phone) {
      return json({ ok: false, error: "Faltan datos del cliente (nombre, dirección, ciudad, departamento o teléfono)" }, 422, cors);
    }

    const dropiPayload: Record<string, unknown> = {
      name: client.name,
      surname: client.surname || "",
      dir: client.dir,
      city: client.city,
      state: client.state,
      phone: client.phone,
      payment_method_id: 1, // contraentrega
      client_email: client.email || "",
      notes: client.notes || "",
      products: resolved.map((l) => {
        const p: Record<string, unknown> = { id: l.dropiId, price: l.price, quantity: l.quantity };
        if (l.variationId) p.variation_id = l.variationId;
        return p;
      }),
    };

    const dropiRes = await fetch(`${dropiCfg.base}/integrations/orders/myorders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "dropi-integration-key": dropiCfg.apiKey,
        "Origin": dropiCfg.storeUrl,
      },
      body: JSON.stringify(dropiPayload),
    });
    const rawText = await dropiRes.text();
    let dBody: Record<string, unknown> = {};
    try { dBody = rawText ? JSON.parse(rawText) : {}; } catch { dBody = { raw: rawText }; }
    const dropiOk = dropiRes.ok && dBody.isSuccess !== false;

    // Intentar extraer el id de la orden creada de varias formas conocidas.
    const dropiOrderId =
      (dBody.id as string | number | undefined) ??
      ((dBody.objects as { id?: string | number })?.id) ??
      ((dBody.data as { id?: string | number })?.id) ??
      ((dBody.order as { id?: string | number })?.id) ??
      null;

    if (!dropiOk || dropiOrderId == null) {
      const detail = String(dBody.message || dBody.error || rawText || "error").slice(0, 500);
      await sb.from("shopify_pushed_orders").insert({
        store_id: storeId, shopify_order_id: shopifyOrderId, status: "error",
        payload: dropiPayload, error_message: `Dropi [${dropiRes.status}]: ${detail}`, pushed_by: user.id,
      });
      return json({ ok: false, error: `Dropi rechazó el pedido [${dropiRes.status}]: ${detail}`, dropiBody: dBody }, 502, cors);
    }

    await sb.from("shopify_pushed_orders").insert({
      store_id: storeId, shopify_order_id: shopifyOrderId, status: "created",
      dropi_order_id: String(dropiOrderId), payload: dropiPayload, pushed_by: user.id,
    });

    return json({ ok: true, mode: "confirm", dropi_order_id: String(dropiOrderId), shopify_name: ord.name }, 200, cors);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("shopify-push-dropi error:", msg);
    return json({ ok: false, error: msg }, 500, cors);
  }
});

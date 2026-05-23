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
  shipping_lines?: Array<{ price?: string | null }> | null;
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

/** Razón por la que NO se pudo resolver el producto de Dropi (diagnóstico). */
type ResolveReason =
  | "sin_permiso_productos"   // 401/403: la app de Shopify no tiene read_products
  | "sin_metafields"          // el producto no tiene metafields
  | "sin_metafield_dropi"     // tiene metafields pero ninguno es de Dropi
  | "http_error"              // Shopify respondió un error distinto
  | "error";                  // excepción inesperada
interface DropiResolveResult { meta: DropiProductMeta | null; reason?: ResolveReason; status?: number; seenKeys?: string[] }
type RawMetafield = { namespace: string; key: string; value: string };

/** Parsea el value de un metafield al shape de un producto Dropi (id numérico). */
function tryParseDropi(value: string): DropiProductMeta | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as DropiProductMeta;
    if (parsed && typeof parsed.id === "number") return parsed;
  } catch { /* no es JSON */ }
  return null;
}

/** Busca el producto Dropi entre los metafields. Dropify deja dropi/_dropi_product;
 *  como red de seguridad aceptamos cualquier namespace que contenga "dropi". */
function extractDropiMeta(mfs: RawMetafield[]): DropiProductMeta | null {
  const exact = mfs.find((m) => m.namespace === "dropi" && m.key === "_dropi_product");
  if (exact) { const p = tryParseDropi(exact.value); if (p) return p; }
  for (const m of mfs.filter((m) => /dropi/i.test(m.namespace))) {
    const p = tryParseDropi(m.value);
    if (p) return p;
  }
  return null;
}

/** Lee el producto de Dropi desde los metafields del producto de Shopify
 *  (cache por product_id). Dropify (la app de Dropi) deja el id de Dropi en el
 *  metafield dropi/_dropi_product. Devuelve también una RAZÓN cuando falla, para
 *  que el modal muestre la causa real en vez de un genérico "sin vínculo". El
 *  caso más común en tiendas nuevas: el token no tiene read_products → Shopify
 *  responde 401/403 al leer metafields y antes lo tragábamos en silencio. */
async function resolveDropiProduct(
  domain: string, token: string, productId: number, cache: Map<number, DropiResolveResult>,
): Promise<DropiResolveResult> {
  if (cache.has(productId)) return cache.get(productId)!;
  let out: DropiResolveResult = { meta: null };
  try {
    const url = (qs: string) =>
      `https://${domain}/admin/api/${SHOPIFY_API_VERSION}/products/${productId}/metafields.json${qs}`;
    const headers = { "X-Shopify-Access-Token": token, "Content-Type": "application/json" };

    const res = await fetch(url("?namespace=dropi"), { headers });
    if (!res.ok) {
      const reason: ResolveReason = (res.status === 401 || res.status === 403)
        ? "sin_permiso_productos" : "http_error";
      out = { meta: null, reason, status: res.status };
    } else {
      let mfs = ((await res.json()) as { metafields?: RawMetafield[] }).metafields || [];
      // Si el namespace dropi vino vacío, traigo TODOS y busco por si la app de
      // Dropi de otro país (Ecuador) usó un namespace levemente distinto.
      if (mfs.length === 0) {
        const all = await fetch(url(""), { headers });
        if (all.ok) mfs = ((await all.json()) as { metafields?: RawMetafield[] }).metafields || [];
      }
      const meta = extractDropiMeta(mfs);
      out = meta
        ? { meta }
        : { meta: null, reason: mfs.length === 0 ? "sin_metafields" : "sin_metafield_dropi", seenKeys: mfs.map((m) => `${m.namespace}.${m.key}`) };
    }
  } catch (_e) {
    out = { meta: null, reason: "error" };
  }
  cache.set(productId, out);
  return out;
}

/** Mensaje humano (es) para la razón de fallo, usado en el modal. */
function reasonMessage(reason: ResolveReason | undefined, status?: number): string {
  switch (reason) {
    case "sin_permiso_productos":
      return `La app de Shopify de esta tienda no tiene permiso para leer productos (read_products) — Shopify respondió ${status ?? 403}. Agregá el scope read_products a la app en Shopify y reintentá.`;
    case "sin_metafields":
      return "El producto no tiene metafields en Shopify (no se importó con la app de Dropi).";
    case "sin_metafield_dropi":
      return "El producto tiene metafields pero ninguno con el id de Dropi. Verificá que se haya importado con la app de Dropi.";
    case "http_error":
      return `Shopify devolvió un error al leer los productos (${status ?? "?"}).`;
    default:
      return "No se pudo leer el vínculo de Dropi del producto.";
  }
}

interface DropiVariationHit { id: number; name: string; sku?: string }
interface DropiProductHit { id: number; name: string; type: string; sku?: string; price?: number; variations: DropiVariationHit[] }

/** Busca productos en el catálogo de Dropi (estilo Dropify) vía la API de
 *  integraciones: GET {base}/integrations/products/myproducts. Manda ambos sets
 *  de params conocidos (pageSize/startData/keywords y result_number/start/
 *  textToSearch) por compat — Dropi ignora los que no usa. Envelope esperado:
 *  { isSuccess, objects: [...] } (igual que dropi-sync). */
async function searchDropiProducts(
  cfg: { base: string; apiKey: string; storeUrl: string }, query: string,
): Promise<DropiProductHit[]> {
  const params = new URLSearchParams({
    keywords: query, pageSize: "20", startData: "0",
    textToSearch: query, result_number: "20", start: "0",
  });
  const url = `${cfg.base}/integrations/products/myproducts?${params.toString()}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "dropi-integration-key": cfg.apiKey,
  };
  if (cfg.storeUrl) {
    headers["Origin"] = cfg.storeUrl;
    headers["Referer"] = cfg.storeUrl.endsWith("/") ? cfg.storeUrl : `${cfg.storeUrl}/`;
  }
  const res = await fetch(url, { headers });
  const txt = await res.text();
  console.log("[shopify-push-dropi] search_products", { url, status: res.status, preview: txt.slice(0, 200) });
  let body: Record<string, unknown> = {};
  try { body = txt ? JSON.parse(txt) : {}; } catch { body = {}; }
  if (!res.ok || (body as { isSuccess?: boolean }).isSuccess === false) {
    throw new Error(String((body as { message?: string }).message || `Dropi respondió ${res.status}`));
  }
  const raw = body as Record<string, unknown>;
  const objects = raw.objects as unknown;
  const data = raw.data as unknown;
  const arr: unknown[] =
    Array.isArray(objects) ? objects :
    Array.isArray((objects as { data?: unknown[] })?.data) ? (objects as { data: unknown[] }).data :
    Array.isArray(data) ? data :
    Array.isArray((data as { data?: unknown[] })?.data) ? (data as { data: unknown[] }).data :
    Array.isArray(raw) ? (raw as unknown[]) : [];
  return arr.map((p) => {
    const pr = p as Record<string, unknown>;
    const variations: DropiVariationHit[] = Array.isArray(pr.variations)
      ? (pr.variations as Record<string, unknown>[]).map((v) => ({
        id: Number(v.id),
        name: String(
          (Array.isArray(v.attribute_values)
            ? (v.attribute_values as Record<string, unknown>[]).map((a) => a.value).filter(Boolean).join(" / ")
            : "") || v.name || v.sku || `var ${v.id}`,
        ),
        sku: v.sku ? String(v.sku) : undefined,
      })).filter((v) => Number.isFinite(v.id) && v.id > 0)
      : [];
    return {
      id: Number(pr.id),
      name: String(pr.name || pr.title || `Producto ${pr.id}`),
      type: String(pr.type || "SIMPLE"),
      sku: pr.sku ? String(pr.sku) : undefined,
      price: Number(pr.sale_price) || undefined,
      variations,
    };
  }).filter((p) => Number.isFinite(p.id) && p.id > 0);
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
    const mode = body.mode === "confirm" ? "confirm"
      : body.mode === "search_products" ? "search_products"
      : body.mode === "list_shopify_products" ? "list_shopify_products"
      : "preview";
    const overrides = (body.overrides ?? {}) as Overrides;
    if (!storeId) return json({ ok: false, error: "Falta store_id" }, 400, cors);

    if (!(await isStoreMember(sb, user.id, storeId))) {
      return json({ ok: false, error: "No sos miembro de esta tienda" }, 403, cors);
    }

    // Modo búsqueda de productos en Dropi (estilo Dropify): NO necesita pedido
    // Shopify. Devuelve el catálogo del proveedor para que el operador elija el
    // producto real (id correcto) en vez de pegar un id a ciegas.
    if (mode === "search_products") {
      const query = String(body.query ?? "").trim();
      if (query.length < 2) return json({ ok: true, products: [] }, 200, cors);
      const dropiCfgS = await loadStoreConfig(sb, storeId);
      if (!dropiCfgS.apiKey) return json({ ok: false, error: "La tienda no tiene Clave API de Dropi" }, 400, cors);
      try {
        const products = await searchDropiProducts(dropiCfgS, query);
        return json({ ok: true, products }, 200, cors);
      } catch (e) {
        return json({ ok: false, error: e instanceof Error ? e.message : "No se pudo buscar en Dropi" }, 502, cors);
      }
    }

    // Modo listar productos de Shopify (panel de vínculos en /admin): devuelve
    // el catálogo de la tienda para marcar cuáles ya están vinculados a Dropi.
    if (mode === "list_shopify_products") {
      const shopCfgL = await loadShopifyConfig(sb, storeId);
      if (!shopCfgL) return json({ ok: false, error: "Shopify no configurado para esta tienda" }, 400, cors);
      const tokenL = await getShopifyAccessToken(shopCfgL);
      try {
        const data = await shopifyGet<{ products: Array<{ id: number; title: string; status?: string; image?: { src?: string } | null }> }>(
          shopCfgL.shopDomain, tokenL, `products.json?limit=250&fields=id,title,image,status`,
        );
        const products = (data.products || []).map((p) => ({
          id: Number(p.id),
          title: String(p.title || `Producto ${p.id}`),
          image: p.image?.src || null,
          status: p.status || null,
        }));
        return json({ ok: true, products }, 200, cors);
      } catch (e) {
        return json({ ok: false, error: e instanceof Error ? e.message : "No se pudieron leer los productos de Shopify" }, 502, cors);
      }
    }

    const shopifyOrderId = String(body.shopify_order_id ?? "").trim();
    if (!shopifyOrderId) return json({ ok: false, error: "Falta shopify_order_id" }, 400, cors);

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
    const fields = "id,name,line_items,shipping_lines,shipping_address,billing_address,customer,phone,note,email";
    const ord = (await shopifyGet<{ order: ShopifyOrderFull }>(
      shopCfg.shopDomain, shopToken,
      `orders/${encodeURIComponent(shopifyOrderId)}.json?fields=${fields}`,
    )).order;
    if (!ord) return json({ ok: false, error: `Pedido ${shopifyOrderId} no existe en Shopify` }, 404, cors);

    // Envío prioritario / cargos sin producto: Shopify los manda como shipping_line
    // o como line item con product_id null (ej. "DESPACHO PRIORITARIO"). No tienen
    // id de Dropi → NO se mandan como producto: su valor se SUMA al COD que cobra
    // Dropi (ej. $40 producto + $2 envío = $42). `shipping` final se arma tras el
    // loop sumando shipping_lines + las líneas sin product_id (extrasTotal).
    const shippingLinesTotal = Math.round(
      (ord.shipping_lines || []).reduce((s, l) => s + (Number(l?.price) || 0), 0),
    );

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
    const cache = new Map<number, DropiResolveResult>();
    const resolved: ResolvedLine[] = [];
    const unmapped: Array<{ title: string; sku: string; product_id: number; reason: string }> = [];
    let permissionIssue = false;
    let firstSeenKeys: string[] | undefined;
    let extrasTotal = 0;
    for (let i = 0; i < (ord.line_items || []).length; i++) {
      const li = ord.line_items[i];
      const qty = Number(li.quantity) || 1;
      const gross = (Number(li.price) || 0) * qty;
      const disc = Number(li.total_discount || "0") || 0;
      const price = Math.round((gross - disc) / qty);

      // Línea SIN product_id = cargo extra (envío prioritario / upsell, ej.
      // "DESPACHO PRIORITARIO"). No tiene id de Dropi → no es un producto: su
      // valor se suma al COD y NO pide vínculo. (Antes salía "sin vínculo" en
      // cada pedido, bloqueaba el confirm y ensuciaba el lookup del mapeo.)
      if (!li.product_id) { extrasTotal += price * qty; continue; }

      const { meta, reason, status, seenKeys } = await resolveDropiProduct(shopCfg.shopDomain, shopToken, li.product_id, cache);
      if (reason === "sin_permiso_productos") permissionIssue = true;
      if (!meta && !firstSeenKeys && seenKeys && seenKeys.length > 0) firstSeenKeys = seenKeys;
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
        quantity: qty, price, dropiId: meta ? Number(meta.id) : null, variationId,
      };
      resolved.push(line);
      if (!meta) {
        unmapped.push({ title: line.title, sku: line.sku, product_id: li.product_id, reason: reasonMessage(reason, status) });
      }
    }

    // Overrides del operador (precio/cantidad) por índice del array `resolved`,
    // que coincide con el orden que ve el modal (products del preview). Se aplica
    // acá —no en el loop— para que el índice del modal == índice de resolved aun
    // cuando se omiten líneas sin product_id.
    for (let j = 0; j < resolved.length; j++) {
      const ov = overrides.lines?.[String(j)];
      if (ov?.price != null) resolved[j].price = Number(ov.price);
      if (ov?.quantity != null) resolved[j].quantity = Number(ov.quantity);
    }

    // Envío/extras a cobrar (no son productos Dropi): shipping_lines + líneas sin id.
    const shipping = shippingLinesTotal + extrasTotal;

    // Fallback DB: tiendas que NO importaron sus productos con la app de Dropi
    // (ej. Rushmira Ecuador, productos cargados a mano en Shopify) no tienen
    // el metafield dropi/_dropi_product. Para esos casos guardamos un mapeo
    // manual por tienda en shopify_product_dropi_map. Si lo encontramos acá,
    // resolvemos el dropiId y sacamos esa línea de unmapped.
    let usedManualMap = false;
    const ids = unmapped.length > 0
      ? Array.from(new Set(unmapped.map((u) => u.product_id).filter((x): x is number => typeof x === "number" && x > 0)))
      : [];
    if (ids.length > 0) {
      const { data: maps } = await sb
        .from("shopify_product_dropi_map")
        .select("shopify_product_id, dropi_product_id, dropi_variation_id")
        .eq("store_id", storeId)
        .in("shopify_product_id", ids);
      const byId = new Map<number, { d: number; v: number | null }>();
      (maps || []).forEach((m: { shopify_product_id: number; dropi_product_id: number; dropi_variation_id: number | null }) => {
        byId.set(Number(m.shopify_product_id), {
          d: Number(m.dropi_product_id),
          v: m.dropi_variation_id != null ? Number(m.dropi_variation_id) : null,
        });
      });
      if (byId.size > 0) {
        for (const line of resolved) {
          if (line.dropiId == null) {
            const hit = byId.get(line.product_id);
            if (hit) {
              line.dropiId = hit.d;
              if (hit.v != null) line.variationId = hit.v;
              usedManualMap = true;
            }
          }
        }
        for (let i = unmapped.length - 1; i >= 0; i--) {
          if (byId.has(unmapped[i].product_id)) unmapped.splice(i, 1);
        }
      }
    }

    // Diagnóstico de alto nivel. Cuando hay productos sin vínculo, consultamos los
    // scopes REALES del token (no los configurados en el Dashboard): Shopify a
    // veces no toma scopes nuevos hasta re-instalar/re-publicar la app, así que
    // "configurado" ≠ "el token lo tiene".
    let diagnostic: string | null = permissionIssue
      ? reasonMessage("sin_permiso_productos")
      : (unmapped[0]?.reason ?? null);
    if (unmapped.length > 0) {
      try {
        const sc = await fetch(`https://${shopCfg.shopDomain}/admin/oauth/access_scopes.json`, {
          headers: { "X-Shopify-Access-Token": shopToken },
        });
        if (sc.ok) {
          const handles = (((await sc.json()) as { access_scopes?: Array<{ handle: string }> }).access_scopes || [])
            .map((s) => s.handle);
          const hasReadProducts = handles.includes("read_products") || handles.includes("write_products");
          const idsLeft = unmapped.map((u) => `${u.title || "(sin título)"} (Shopify product_id ${u.product_id})`).join(" · ");
          if (!hasReadProducts) {
            diagnostic = "El token de Shopify NO tiene read_products en este momento (aunque lo hayas configurado). " +
              "Re-instalá/re-publicá la app personalizada en Shopify para que el token tome el permiso, y reintentá.";
          } else if (firstSeenKeys && firstSeenKeys.length > 0) {
            diagnostic = "El token SÍ tiene read_products, pero este producto no expone el vínculo de Dropi. " +
              `Metafields visibles: ${firstSeenKeys.join(", ")}. ` +
              "Cargá el id de Dropi manualmente para esta tienda (RPC upsert_shopify_product_dropi_map). " +
              `Pendientes: ${idsLeft}.`;
          } else {
            diagnostic = "El token SÍ tiene read_products, pero este producto NO tiene NINGÚN metafield en Shopify " +
              "(no se importó con la app de Dropi — típico cuando los productos se cargan a mano en Shopify, como Rushmira Ecuador). " +
              "Solución: registrar el vínculo manualmente con el RPC upsert_shopify_product_dropi_map(store_id, shopify_product_id, dropi_product_id, dropi_variation_id?). " +
              `Pendientes: ${idsLeft}.`;
          }
        }
      } catch { /* dejamos el diagnostic base */ }
    }
    if (usedManualMap && unmapped.length === 0) diagnostic = null;

    const total = resolved.reduce((s, l) => s + l.price * l.quantity, 0);

    if (mode === "preview") {
      return json({
        ok: true, mode: "preview", shopify_order_id: shopifyOrderId, shopify_name: ord.name,
        client, products: resolved, total, shipping, unmapped, diagnostic, alreadyPushed,
        dropi_order_id: prior?.dropi_order_id ?? null,
      }, 200, cors);
    }

    // ----- mode confirm -----
    if (alreadyPushed) {
      return json({ ok: false, error: "Este pedido ya fue subido a Dropi", dropi_order_id: prior?.dropi_order_id ?? null }, 409, cors);
    }
    if (unmapped.length > 0) {
      return json({
        ok: false,
        error: diagnostic || "Hay productos sin vínculo a Dropi (no importados por Dropify)",
        unmapped, diagnostic,
      }, 422, cors);
    }
    if (!client.name || !client.dir || !client.city || !client.state || !client.phone) {
      return json({ ok: false, error: "Faltan datos del cliente (nombre, dirección, ciudad, departamento o teléfono)" }, 422, cors);
    }

    // Sumar el envío prioritario al COD: Dropi cobra el total por los productos,
    // así que folmos el envío en el precio de la primera línea (el envío no es un
    // producto y no tiene id). Para qty>1 se reparte por unidad.
    if (shipping > 0 && resolved.length > 0) {
      const first = resolved[0];
      first.price += Math.round(shipping / Math.max(1, first.quantity));
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

    // ----- Estrategia escalonada -----
    // 1) PRIMARIO: /integrations/orders/myorders con dropi-integration-key.
    //    Funciona para productos públicos (CO típicamente) — NO se toca.
    // 2) FALLBACK: si Dropi devuelve "$type / Undefined property / not found"
    //    (producto privado que el catálogo de integraciones NO expone),
    //    armamos un payload "saveOrderV2" estilo web y vamos a
    //    /api/orders/myorders. La misma integration-key sirve para /api/*
    //    (ya se usa en dropi-resolve-incidence).
    let dropiUserId: number | null = null;
    try {
      const p = JSON.parse(atob((dropiCfg.apiKey.split(".")[1] || "").replace(/-/g, "+").replace(/_/g, "/")));
      if (p && typeof p.sub !== "undefined") dropiUserId = Number(p.sub) || null;
    } catch { /* token no-JWT */ }

    const baseHeaders = (): Record<string, string> => ({
      "Content-Type": "application/json",
      "Accept": "application/json",
      "dropi-integration-key": dropiCfg.apiKey,
      "Origin": dropiCfg.storeUrl || "",
      "Referer": dropiCfg.storeUrl?.endsWith("/") ? dropiCfg.storeUrl : `${dropiCfg.storeUrl || ""}/`,
    });
    const sessionHeaders = (): Record<string, string> => ({
      ...baseHeaders(),
      "X-Authorization": `Bearer ${dropiCfg.sessionToken || dropiCfg.apiKey}`,
    });

    const logSnip = (s: string) => (s || "").replace(/\s+/g, " ").slice(0, 600);
    async function callDropi(label: string, url: string, init: RequestInit): Promise<{ status: number; text: string; body: Record<string, unknown> }> {
      const reqBodyPreview = typeof init.body === "string" ? logSnip(init.body) : "";
      console.log(`[push-web] →${label} url=${url} body=${reqBodyPreview}`);
      const res = await fetch(url, init);
      const text = await res.text();
      let body: Record<string, unknown> = {};
      try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
      console.log(`[push-web] ←${label} status=${res.status} body=${logSnip(text)}`);
      return { status: res.status, text, body };
    }
    // Reintenta con X-Authorization si el primer intento dio 401/403.
    async function callWithAuthRetry(label: string, url: string, init: RequestInit): Promise<{ status: number; text: string; body: Record<string, unknown> }> {
      const first = await callDropi(label, url, { ...init, headers: baseHeaders() });
      if (first.status === 401 || first.status === 403) {
        console.log(`[push-web] ${label} got ${first.status} with integration-key → retrying with X-Authorization`);
        const second = await callDropi(`${label}#bearer`, url, { ...init, headers: sessionHeaders() });
        return second;
      }
      return first;
    }

    // --- INTENTO 1: /integrations/orders/myorders ---
    const r1 = await callDropi("integrations/myorders", `${dropiCfg.base}/integrations/orders/myorders`, {
      method: "POST", headers: baseHeaders(), body: JSON.stringify(dropiPayload),
    });
    const r1Detail = String(r1.body.message || r1.body.error || r1.text || "");
    const r1Ok = r1.status >= 200 && r1.status < 300 && r1.body.isSuccess !== false;
    const productNotFound = /\$type|Undefined property|no encontr|not found|invalid product/i.test(r1Detail);

    let finalRes: { status: number; text: string; body: Record<string, unknown> } = r1;
    const attemptedLabels: string[] = ["integrations/myorders"];

    if (!r1Ok && (productNotFound || r1.status === 404)) {
      // --- FALLBACK WEB reversado de app.dropi.ec ---
      const primary = resolved.find((l) => l.dropiId != null);
      if (!primary || primary.dropiId == null) {
        return json({ ok: false, error: "Sin producto Dropi válido para fallback", dropiBody: r1.body, attempts: attemptedLabels }, 502, cors);
      }

      const norm = (s: string) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim();
      const DROPI_COUNTRY = dropiCfg.countryCode === "EC" ? "ECUADOR" : "COLOMBIA";

      try {
        // PASO 1 — producto
        const rShow = await callWithAuthRetry(
          "product/show",
          `${dropiCfg.base}/api/products/productlist/v1/show/?id=${primary.dropiId}`,
          { method: "GET" },
        );
        attemptedLabels.push("product/show");
        const showObj = (rShow.body.objects || rShow.body.data || rShow.body) as Record<string, unknown>;
        let supplierId =
          Number((showObj as { user_id?: unknown }).user_id) ||
          Number(((showObj as { user?: { id?: unknown } }).user || {}).id) || null;
        const productType = String((showObj as { type?: unknown }).type || "SIMPLE");

        // PASO 2 — catálogo de ciudades (por país)
        const rLoc = await callWithAuthRetry(
          "locations",
          `${dropiCfg.base}/api/locations`,
          { method: "POST", body: JSON.stringify({ country: countryName }) },
        );
        attemptedLabels.push("locations");
        const locData = ((rLoc.body.data || rLoc.body.objects || rLoc.body) as unknown);
        const states = Array.isArray(locData) ? locData as Array<Record<string, unknown>>
          : (Array.isArray((locData as { data?: unknown[] })?.data) ? (locData as { data: Array<Record<string, unknown>> }).data : []);
        const wantState = norm(client.state);
        const wantCity = norm(client.city);
        let stateHit = states.find((s) => norm(String(s.label || s.name || "")) === wantState)
          || states.find((s) => norm(String(s.label || s.name || "")).includes(wantState));
        if (!stateHit) {
          // fallback: buscar la ciudad en cualquier estado
          for (const s of states) {
            const items = (s.items || s.cities || []) as Array<Record<string, unknown>>;
            if (Array.isArray(items) && items.some((c) => norm(String(c.label || c.name || "")) === wantCity)) {
              stateHit = s; break;
            }
          }
        }
        if (!stateHit) {
          return json({ ok: false, error: `Departamento no encontrado en catálogo Dropi: ${client.state}`, attempts: attemptedLabels }, 502, cors);
        }
        const stateName = String(stateHit.label || stateHit.name || "");
        const stateId = Number((stateHit as { id_state?: unknown }).id_state ?? (stateHit as { id?: unknown }).id ?? 0) || null;
        const items = ((stateHit.items || stateHit.cities || []) as Array<Record<string, unknown>>) || [];
        const cityHit = items.find((c) => norm(String(c.label || c.name || "")) === wantCity)
          || items.find((c) => norm(String(c.label || c.name || "")).includes(wantCity));
        if (!cityHit) {
          return json({ ok: false, error: `Ciudad no encontrada en catálogo Dropi: ${client.city}/${client.state}`, attempts: attemptedLabels }, 502, cors);
        }
        const cityId = Number((cityHit as { id_city?: unknown }).id_city ?? (cityHit as { id?: unknown }).id) || null;
        const cityName = String(cityHit.label || cityHit.name || client.city);

        // PASO 3 — origen / warehouse
        const rOrigin = await callWithAuthRetry(
          "getOriginCity",
          `${dropiCfg.base}/api/orders/getOriginCityForCalculateShipping`,
          { method: "POST", body: JSON.stringify({ id: primary.dropiId, destination: cityId, type: productType }) },
        );
        attemptedLabels.push("getOriginCity");
        const oData = (rOrigin.body.data || rOrigin.body) as Record<string, unknown>;
        const cityDropi = (oData as { city_dropi?: unknown }).city_dropi as Record<string, unknown> | null | undefined;
        const warehouse = (oData as { warehouse?: unknown }).warehouse as Record<string, unknown> | null | undefined;
        if (!cityDropi) {
          return json({ ok: false, error: "Producto sin stock en bodega (city_dropi null)", attempts: attemptedLabels }, 502, cors);
        }
        const warehouseId = warehouse ? Number(warehouse.id) || null : null;
        if (!supplierId && warehouse && (warehouse as { user_id?: unknown }).user_id) {
          supplierId = Number((warehouse as { user_id?: unknown }).user_id) || null;
        }

        // PASO 4 — cotización
        const totalOrder = resolved.reduce((s, l) => s + l.price * l.quantity, 0);
        const cotizaPayload = {
          peso: 1, largo: 1, ancho: 1, alto: 1,
          ciudad_remitente: cityDropi,
          ciudad_destino: { id: cityId, name: cityName, department_id: stateId },
          EnvioConCobro: true,
          ValorDeclarado: totalOrder,
          insurance: false,
          products: resolved.map((l) => ({
            id: l.dropiId, uid: l.dropiId, quantity: l.quantity, price: l.price, type: productType,
          })),
          warehouse,
          warehouse_id: warehouseId,
          zip_code: "",
          colonia: "",
        };
        const rCotiza = await callWithAuthRetry(
          "cotizaEnvio",
          `${dropiCfg.base}/api/orders/cotizaEnvioTransportadoraV2`,
          { method: "POST", body: JSON.stringify(cotizaPayload) },
        );
        attemptedLabels.push("cotizaEnvio");
        const cotRaw = (rCotiza.body.objects || rCotiza.body.data || rCotiza.body) as unknown;
        const cotList = Array.isArray(cotRaw) ? cotRaw as Array<Record<string, unknown>>
          : (Array.isArray((cotRaw as { data?: unknown[] })?.data) ? (cotRaw as { data: Array<Record<string, unknown>> }).data : []);
        const valid = cotList.filter((c) => {
          if (c.error) return false;
          const dc = c.distributionCompany as { name?: string } | undefined;
          if (dc && /VELOCES/i.test(String(dc.name || ""))) return false;
          const inner = (c.objects || {}) as { precioEnvio?: unknown };
          return inner.precioEnvio != null;
        });
        if (valid.length === 0) {
          return json({ ok: false, error: "No hay transportadoras disponibles para esta ruta", attempts: attemptedLabels, cotiza: cotList.slice(0, 3) }, 502, cors);
        }
        valid.sort((a, b) => {
          const ap = Number(((a.objects || {}) as { precioEnvio?: unknown }).precioEnvio) || 0;
          const bp = Number(((b.objects || {}) as { precioEnvio?: unknown }).precioEnvio) || 0;
          return ap - bp;
        });
        const carrier = valid[0];
        const dc = carrier.distributionCompany as { id?: unknown; name?: unknown };
        const distributionCompany = { id: Number(dc.id), name: String(dc.name || "") };
        const typeService = String((carrier as { transportadora_service?: unknown }).transportadora_service || "normal");
        const shippingAmount = Number(((carrier.objects || {}) as { precioEnvio?: unknown }).precioEnvio) || 0;

        // PASO 5 — crear orden
        const webPayload: Record<string, unknown> = {
          total_order: totalOrder,
          notes: client.notes || "",
          name: client.name,
          surname: client.surname || "",
          dir: client.dir,
          country: countryName,
          state: stateName,
          city: cityName,
          phone: client.phone,
          client_email: client.email || "",
          payment_method_id: 1,
          user_id: dropiUserId,
          supplier_id: supplierId,
          type: "FINAL_ORDER",
          rate_type: "CON RECAUDO",
          products: resolved.map((l) => ({
            id: l.dropiId, uid: l.dropiId, quantity: l.quantity, price: l.price, type: productType,
          })),
          distributionCompany,
          type_service: typeService,
          zip_code: null,
          colonia: "",
          shop_id: null,
          dni: "",
          dni_type: null,
          insurance: false,
          shalom_data: null,
          warehouses_selected_id: warehouseId,
          shipping_amount: shippingAmount,
        };

        const missing: string[] = [];
        if (!webPayload.name) missing.push("name");
        if (!webPayload.dir) missing.push("dir");
        if (!webPayload.phone) missing.push("phone");
        if (!webPayload.user_id) missing.push("user_id");
        if (!webPayload.supplier_id) missing.push("supplier_id");
        if (!distributionCompany.id) missing.push("distributionCompany.id");
        if (!warehouseId) missing.push("warehouses_selected_id");
        if (missing.length > 0) {
          console.log(`[push-web] webPayload missing required: ${missing.join(",")}`);
          return json({
            ok: false,
            error: `No se pudo armar el pedido WEB para producto privado (faltan: ${missing.join(", ")}). Revisá los logs [push-web] para ajustar el mapeo.`,
            attempts: attemptedLabels,
          }, 502, cors);
        }

        const r2 = await callWithAuthRetry(
          "api/myorders",
          `${dropiCfg.base}/api/orders/myorders`,
          { method: "POST", body: JSON.stringify(webPayload) },
        );
        attemptedLabels.push("api/myorders");
        finalRes = r2;
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        console.error(`[push-web] fallback error: ${m}`);
        return json({ ok: false, error: `Fallback web falló: ${m}`, attempts: attemptedLabels }, 502, cors);
      }
    }

    const dropiOk = finalRes.status >= 200 && finalRes.status < 300 && finalRes.body.isSuccess !== false;
    const dBody = finalRes.body;
    const rawText = finalRes.text;
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
        payload: { tried: attemptedLabels, last: dropiPayload },
        error_message: `Dropi [${finalRes.status}] (${attemptedLabels.join("→")}): ${detail}`, pushed_by: user.id,
      });
      const friendly = /\$type|Undefined property|no encontr|not found/i.test(detail)
        ? `Dropi no encontró el producto en ninguna ruta (${attemptedLabels.join(" → ")}). Revisá los logs de la edge function para ver el detalle del fallback web.`
        : `Dropi rechazó el pedido [${finalRes.status}] (${attemptedLabels.join(" → ")}): ${detail}`;
      return json({ ok: false, error: friendly, dropiBody: dBody, attempts: attemptedLabels }, 502, cors);
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

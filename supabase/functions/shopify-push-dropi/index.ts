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
import { WebFallbackError, normUp, decodeJwtSub, dropiWebFetch, quoteCarriers } from "../_shared/dropiWebQuote.ts";
import { allocateOrderDiscount, isCodOvercharge } from "./discount.ts";

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
  // Descuentos de ORDEN que Shopify SÍ reparte a la línea. total_discount a veces
  // queda en 0 y el monto vive acá (ej. algunos descuentos automáticos).
  discount_allocations?: Array<{ amount?: string }>;
  variant_title?: string | null;
}
interface ShopifyAddr {
  first_name?: string; last_name?: string; name?: string;
  address1?: string; address2?: string; city?: string; province?: string;
  phone?: string;
}
interface ShopifyOrderFull {
  id: number; name: string; phone?: string | null; email?: string | null; note?: string | null;
  // Descuento a NIVEL DE ORDEN (ej. "QUANTITY DISCOUNT" de Releasit COD Form).
  // total_discounts = suma de TODOS los descuentos; total_line_items_price = subtotal
  // de productos ANTES de descuentos. La resta de ambos = lo que el cliente paga por
  // los productos (el COD correcto que debe cobrar Dropi).
  total_discounts?: string;
  total_line_items_price?: string;
  current_subtotal_price?: string;
  subtotal_price?: string;
  // Total que el cliente VIO y aceptó pagar (subtotal con descuento + envío, IVA
  // incluido en EC/CO). Es el ancla del guardrail: el COD a Dropi nunca debe superarlo.
  current_total_price?: string;
  total_price?: string;
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
interface DropiProductHit { id: number; name: string; type: string; sku?: string; price?: number; variations: DropiVariationHit[]; image?: string; description?: string }

// Foto del producto: Dropi expone la galería bajo nombres variables según el
// endpoint. Probamos defensivamente (gallery/images como array de strings u
// objetos {url|urlS3|src}, o campos sueltos) y tomamos la primera URL http válida.
function pickDropiImage(pr: Record<string, unknown>): string | undefined {
  const fromArr = (g: unknown): string | undefined => {
    if (!Array.isArray(g) || g.length === 0) return undefined;
    const first = g[0];
    if (typeof first === "string") return /^https?:\/\//.test(first) ? first : undefined;
    if (first && typeof first === "object") {
      const o = first as Record<string, unknown>;
      for (const k of ["urlS3", "url", "src", "image", "s3_url"]) {
        const v = o[k] ? String(o[k]) : "";
        if (/^https?:\/\//.test(v)) return v;
      }
    }
    return undefined;
  };
  const arrHit = fromArr(pr.gallery) || fromArr(pr.images);
  if (arrHit) return arrHit;
  for (const k of ["main_image", "image", "url_image", "photo", "thumbnail", "picture"]) {
    const v = pr[k] ? String(pr[k]) : "";
    if (/^https?:\/\//.test(v)) return v;
  }
  return undefined;
}

// Descripción del producto: limpia HTML y recorta (sirve para pre-cargar el
// "qué es" en la ficha del bot; el dueño la edita).
function pickDropiDescription(pr: Record<string, unknown>): string | undefined {
  const raw = [pr.description, pr.short_description, pr.details]
    .map((x) => (x ? String(x) : "")).find(Boolean);
  if (!raw) return undefined;
  const text = raw.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 1500) : undefined;
}

// Mapea un producto crudo de Dropi (cualquier endpoint) a DropiProductHit.
// Devuelve null si la fila no tiene un id válido. Compartido por la búsqueda por
// nombre (search_products) y la traída por ID (get_product).
function mapDropiRaw(p: unknown): DropiProductHit | null {
  const pr = p as Record<string, unknown>;
  const id = Number(pr.id);
  if (!Number.isFinite(id) || id <= 0) return null;
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
    id,
    name: String(pr.name || pr.title || `Producto ${id}`),
    type: String(pr.type || "SIMPLE"),
    sku: pr.sku ? String(pr.sku) : undefined,
    price: Number(pr.sale_price) || undefined,
    variations,
    image: pickDropiImage(pr),
    description: pickDropiDescription(pr),
  };
}

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
  return arr.map(mapDropiRaw).filter((p): p is DropiProductHit => p != null);
}

/** fetch con timeout (AbortController) — para no colgar la función si un endpoint
 *  de Dropi no responde mientras probamos varias rutas en get_product. */
async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Extrae el array de productos de cualquier envelope de Dropi
 *  (objects / objects.data / data / data.data / array crudo / objeto suelto). */
function extractProductArray(txt: string): unknown[] {
  let body: Record<string, unknown> = {};
  try { body = txt ? JSON.parse(txt) : {}; } catch { return []; }
  const objects = body.objects as unknown;
  const data = body.data as unknown;
  return (
    Array.isArray(objects) ? objects :
    Array.isArray((objects as { data?: unknown[] })?.data) ? (objects as { data: unknown[] }).data :
    Array.isArray(data) ? data :
    Array.isArray((data as { data?: unknown[] })?.data) ? (data as { data: unknown[] }).data :
    Array.isArray(body) ? (body as unknown[]) :
    (objects && typeof objects === "object") ? [objects] :
    (data && typeof data === "object") ? [data] :
    (body.id != null) ? [body] : []
  );
}

/** Motivo de un MISS — guía el mensaje accionable que ve el dueño. */
type GetProductReason = "ok" | "not_found" | "sess_expired" | "sess_missing" | "int_denied" | "no_creds";

/** Trae UN producto del catálogo de Dropi por su id (para el atajo "pegá el ID"
 *  en /admin → Productos del bot).
 *
 *  ⚠️ HALLAZGO (probado en vivo 2026-06-24, Rushmira CO): la integration-key
 *  PERMANENTE sirve para ORDERS pero Dropi le NIEGA productos
 *  (`/integrations/products/myproducts` → "No tiene permisos para ver este
 *  producto"). El ÚNICO endpoint que devuelve detalle de producto es el WEB
 *  (`/api/products/productlist/v1/show/?id=`) con el session token (aud:DROPI),
 *  que vence ~12h. Por eso probamos:
 *   1) WEB (session token) PRIMERO — el único que lee productos en esta cuenta.
 *   2) Integraciones (key permanente) como best-effort — funciona en stores cuya
 *      key SÍ tiene productos habilitados; acá cae en "int_denied".
 *
 *  Devuelve { product, diag, reason }. `reason` permite un toast accionable
 *  ("tu sesión Dropi venció → refrescá el token") en vez de un MISS genérico. */
async function fetchDropiProductById(
  cfg: { base: string; apiKey: string; sessionToken: string; storeUrl: string },
  id: number,
): Promise<{ product: DropiProductHit | null; diag: string[]; reason: GetProductReason }> {
  const diag: string[] = [];
  const PAGE = 200;
  const MAX_PAGES = 8; // hasta 1600 productos del catálogo propio
  let webExpired = false;   // session token vencido
  let intDenied = false;    // Dropi negó productos a la integration-key
  let sawCatalog = false;   // alguna ruta devolvió lista real (id simplemente no está)

  // ── 1) Panel web (session token) — único camino que lee productos acá ───────
  if (cfg.sessionToken) {
    const webHeaders: Record<string, string> = {
      "X-Authorization": "Bearer " + cfg.sessionToken,
      "Accept": "application/json",
      "Content-Type": "application/json",
    };
    if (cfg.storeUrl) webHeaders["Origin"] = cfg.storeUrl;
    const r = await fetchWithTimeout(`${cfg.base}/api/products/productlist/v1/show/?id=${id}`, { headers: webHeaders }, 9000);
    if (!r) {
      diag.push("web:net");
    } else {
      const txt = await r.text();
      let body: Record<string, unknown> = {};
      try { body = txt ? JSON.parse(txt) : {}; } catch { /* noop */ }
      diag.push(`web:${r.status}`);
      const msg = String((body as { message?: string }).message || (body as { error?: string }).error || "");
      if (r.status >= 200 && r.status < 300 && (body as { isSuccess?: boolean }).isSuccess !== false) {
        // Consultamos por id explícito → el objeto devuelto ES ese producto.
        const obj = (body.objects ?? body.data ?? null) as Record<string, unknown> | null;
        if (obj && typeof obj === "object") {
          const hit = mapDropiRaw(obj);
          if (hit) return { product: hit, diag, reason: "ok" };
        }
        sawCatalog = true; // respondió OK pero sin producto usable → el id no existe/visible
      } else if (/expir|vencid|token is expired/i.test(msg)) {
        webExpired = true;
        diag.push("web:expired");
      }
    }
  } else {
    diag.push("nosess");
  }

  // ── 2) Integraciones (key permanente) — best-effort (acá: denegado) ─────────
  if (cfg.apiKey) {
    const intHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "dropi-integration-key": cfg.apiKey,
    };
    if (cfg.storeUrl) {
      intHeaders["Origin"] = cfg.storeUrl;
      intHeaders["Referer"] = cfg.storeUrl.endsWith("/") ? cfg.storeUrl : `${cfg.storeUrl}/`;
    }
    const getPage = async (params: URLSearchParams) =>
      await fetchWithTimeout(`${cfg.base}/integrations/products/myproducts?${params.toString()}`, { headers: intHeaders }, 9000);
    const denied = (txt: string) => {
      let b: Record<string, unknown> = {};
      try { b = txt ? JSON.parse(txt) : {}; } catch { return false; }
      const m = String((b as { message?: string }).message || "");
      return (b as { isSuccess?: boolean }).isSuccess === false && /permiso|denied|access/i.test(m);
    };

    // 2a) tiro directo por keyword=id (por si el buscador matchea id/sku).
    {
      const params = new URLSearchParams({
        keywords: String(id), textToSearch: String(id),
        pageSize: String(PAGE), startData: "0", result_number: String(PAGE), start: "0",
      });
      const res = await getPage(params);
      if (res) {
        const txt = await res.text();
        const arr = extractProductArray(txt);
        diag.push(`kw:${res.status}/${arr.length}`);
        if (denied(txt)) { intDenied = true; diag.push("int:denied"); }
        if (arr.length > 0) sawCatalog = true;
        const hit = arr.map(mapDropiRaw).find((p): p is DropiProductHit => p != null && p.id === id);
        if (hit) return { product: hit, diag, reason: "ok" };
      } else {
        diag.push("kw:net");
      }
    }

    // 2b) barrido paginado SIN keyword (lista completa del catálogo propio).
    if (!intDenied) {
      for (let page = 0; page < MAX_PAGES; page++) {
        const start = String(page * PAGE);
        const params = new URLSearchParams({
          pageSize: String(PAGE), startData: start, result_number: String(PAGE), start,
        });
        const res = await getPage(params);
        if (!res) { diag.push(`sweep${page}:net`); break; }
        if (!res.ok) { diag.push(`sweep${page}:${res.status}`); break; }
        const txt = await res.text();
        if (denied(txt)) { intDenied = true; diag.push("int:denied"); break; }
        const arr = extractProductArray(txt);
        if (arr.length > 0) sawCatalog = true;
        const hit = arr.map(mapDropiRaw).find((p): p is DropiProductHit => p != null && p.id === id);
        if (hit) { diag.push(`sweep:hit@p${page}`); return { product: hit, diag, reason: "ok" }; }
        if (arr.length < PAGE) { diag.push(`sweep:miss/${page * PAGE + arr.length}`); break; }
      }
    }
  } else {
    diag.push("nokey");
  }

  // ── Reason: lo más accionable para el dueño ────────────────────────────────
  let reason: GetProductReason = "not_found";
  if (!cfg.apiKey && !cfg.sessionToken) reason = "no_creds";
  else if (sawCatalog) reason = "not_found";          // vimos catálogo, el id no está/visible
  else if (webExpired) reason = "sess_expired";       // hay que refrescar el token web
  else if (!cfg.sessionToken && intDenied) reason = "sess_missing"; // integración negada y sin token web
  else if (!cfg.sessionToken) reason = "sess_missing";
  else reason = "not_found";

  console.log("[shopify-push-dropi] get_product MISS", { id, diag, reason });
  return { product: null, diag, reason };
}

// ===========================================================================
// FALLBACK WEB (panel app.dropi.*) — para productos PRIVADOS que el endpoint de
// integraciones (POST /integrations/orders/myorders, dropi-integration-key) NO
// puede crear (falla con "Undefined property: stdClass::$type"). La web de Dropi
// SÍ los crea, vía endpoints WEB /api/* que exigen un token de SESIÓN
// (aud:"DROPI", = cfg.sessionToken). La integration-key NO sirve para /api/*.
//
// Secuencia verificada en vivo (tienda Rushmira Ecuador, FrescoMax id 115864):
//   A) GET  /api/products/productlist/v1/show/?id={dropiId}      → supplier_id, type
//   B) POST /api/locations { country }                           → cityId, stateName
//   C) POST /api/orders/getOriginCityForCalculateShipping        → ciudad_remitente, warehouse
//   D) POST /api/orders/cotizaEnvioTransportadoraV2              → distributionCompany, shipping_amount
//   E) POST /api/orders/myorders                                 → crea la orden
// ===========================================================================

/** Orquestador del fallback web. Devuelve el id de la orden creada o tira
 *  WebFallbackError (que el caller convierte en status "error"). La secuencia
 *  A–D (cotización) vive en ../_shared/dropiWebQuote.ts y la reusa dropi-change-carrier. */
async function createOrderViaWeb(
  cfg: { base: string; sessionToken: string; storeUrl: string },
  args: {
    country: string;
    client: ClientFields;
    resolved: ResolvedLine[];
    total: number;
  },
): Promise<string> {
  const lines = args.resolved.filter((l) => l.dropiId != null);
  if (lines.length === 0) {
    throw new WebFallbackError("No hay productos con id de Dropi para crear la orden por el panel web.", 422);
  }

  // PASOS A–D — info de productos + ciudad destino + origen/bodega + cotización.
  const ctx = await quoteCarriers(cfg, {
    country: args.country,
    city: args.client.city,
    state: args.client.state,
    lines: lines.map((l) => ({ dropiId: Number(l.dropiId), quantity: l.quantity, price: l.price })),
    total: args.total,
  });
  const { dest, origin, products, supplierId } = ctx;

  // Política al crear: la más barata ≠ VELOCES (options viene ordenado asc por precio).
  const candidate = ctx.options.find((o) => normUp(o.name) !== "VELOCES");
  if (!candidate) {
    throw new WebFallbackError("Ninguna transportadora cotizó este envío (todas con error o solo VELOCES disponible).", 422);
  }
  const quote = {
    distributionCompany: { id: candidate.id, name: candidate.name },
    typeService: candidate.typeService,
    shippingAmount: candidate.shippingAmount,
  };

  // PASO E — crear la orden.
  const userId = decodeJwtSub(cfg.sessionToken);
  const orderBody = {
    total_order: args.total,
    notes: args.client.notes || "",
    name: args.client.name,
    surname: args.client.surname || "",
    dir: args.client.dir,
    country: args.country,
    state: dest.stateName,
    city: dest.cityName,
    phone: args.client.phone,
    client_email: args.client.email || "",
    payment_method_id: 1,
    user_id: userId,
    supplier_id: supplierId,
    type: "FINAL_ORDER",
    rate_type: "CON RECAUDO",
    products: products.map((p) => ({
      id: p.dropiId, uid: p.dropiId, quantity: p.quantity, price: p.price, type: p.productType,
    })),
    distributionCompany: quote.distributionCompany,
    type_service: quote.typeService,
    zip_code: null,
    colonia: "",
    shop_id: null,
    dni: "",
    dni_type: null,
    insurance: false,
    shalom_data: null,
    warehouses_selected_id: origin.warehouseId,
    shipping_amount: quote.shippingAmount,
  };

  const { status, body, text } = await dropiWebFetch(cfg, `/api/orders/myorders`, { method: "POST", body: orderBody });
  const ok = status >= 200 && status < 300 && body?.isSuccess !== false;
  const orderId =
    (body?.id as string | number | undefined) ??
    (body?.objects?.id as string | number | undefined) ??
    (body?.data?.id as string | number | undefined) ??
    (body?.order?.id as string | number | undefined) ??
    null;
  if (!ok || orderId == null) {
    const detail = String(body?.message || body?.error || text || "error").slice(0, 500);
    throw new WebFallbackError(`Dropi (panel web) rechazó el pedido [${status}]: ${detail}`, 502);
  }
  return String(orderId);
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
      : body.mode === "get_product" ? "get_product"
      : body.mode === "list_shopify_products" ? "list_shopify_products"
      : body.mode === "audit" ? "audit"
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

    // Modo traer UN producto por id (atajo "pegá el ID" en /admin → Productos del
    // bot): devuelve nombre + foto + descripción para autocompletar la ficha. Si no
    // se encuentra, responde 404 y el front vincula el id "a ciegas" (no bloquea).
    if (mode === "get_product") {
      const pid = Number(body.dropi_product_id ?? body.id);
      if (!Number.isFinite(pid) || pid <= 0) {
        return json({ ok: false, error: "ID de Dropi inválido" }, 400, cors);
      }
      const dropiCfgG = await loadStoreConfig(sb, storeId);
      if (!dropiCfgG.apiKey && !dropiCfgG.sessionToken) {
        return json({ ok: false, error: "La tienda no tiene credenciales de Dropi" }, 400, cors);
      }
      try {
        const { product, diag, reason } = await fetchDropiProductById(dropiCfgG, pid);
        if (!product) {
          // Mensaje accionable según el motivo (token de sesión vencido/ausente
          // vs producto inexistente). 422 = "arreglá la credencial"; 404 = "no está".
          const tokenMsg = "Tu token de sesión de Dropi venció o falta. Refrescalo en Admin → Credenciales Dropi (vence ~12 h), o cargá el producto a mano.";
          const map: Record<string, { status: number; error: string }> = {
            sess_expired: { status: 422, error: tokenMsg },
            sess_missing: { status: 422, error: tokenMsg },
            no_creds: { status: 400, error: "La tienda no tiene credenciales de Dropi." },
            int_denied: { status: 422, error: tokenMsg },
            not_found: { status: 404, error: "No se encontró ese producto en tu Dropi (verificá el ID)." },
          };
          const m = map[reason] ?? map.not_found;
          return json({ ok: false, error: m.error, reason, diag }, m.status, cors);
        }
        return json({ ok: true, product, diag, reason }, 200, cors);
      } catch (e) {
        return json({ ok: false, error: e instanceof Error ? e.message : "No se pudo traer el producto de Dropi" }, 502, cors);
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

    // Modo auditoría: revisa los pedidos YA subidos a Dropi y detecta los que se
    // cobraron de más porque el descuento de orden de Shopify no se aplicó (bug
    // previo a este fix). NO escribe nada — solo devuelve la lista para corregir a
    // mano en Dropi. Body: { store_id, days?=60, limit?=100 }.
    if (mode === "audit") {
      const shopCfgA = await loadShopifyConfig(sb, storeId);
      if (!shopCfgA) return json({ ok: false, error: "Shopify no configurado para esta tienda" }, 400, cors);
      const tokenA = await getShopifyAccessToken(shopCfgA);
      const days = Number(body.days) > 0 ? Math.min(Number(body.days), 365) : 60;
      const limit = Number(body.limit) > 0 ? Math.min(Number(body.limit), 500) : 100;
      const cutoff = new Date(Date.now() - days * 86400000).toISOString();
      const { data: pushed, error: pErr } = await sb
        .from("shopify_pushed_orders")
        .select("shopify_order_id, dropi_order_id, payload, pushed_at")
        .eq("store_id", storeId).eq("status", "created")
        .gte("pushed_at", cutoff)
        .order("pushed_at", { ascending: false })
        .limit(limit);
      if (pErr) return json({ ok: false, error: pErr.message }, 500, cors);

      const flagged: Array<Record<string, unknown>> = [];
      let checked = 0;
      let errors = 0;
      for (const row of (pushed || [])) {
        const products = ((row.payload as { products?: Array<{ price?: number; quantity?: number }> })?.products) || [];
        const pushedTotal = products.reduce((s, p) => s + (Number(p.price) || 0) * (Number(p.quantity) || 0), 0);
        let aud: ShopifyOrderFull | null = null;
        try {
          aud = (await shopifyGet<{ order: ShopifyOrderFull }>(
            shopCfgA.shopDomain, tokenA,
            `orders/${encodeURIComponent(String(row.shopify_order_id))}.json?fields=id,name,total_discounts,total_line_items_price,current_subtotal_price`,
          )).order;
        } catch { errors++; continue; }
        checked++;
        if (!aud) continue;
        const totalDiscounts = Number(aud.total_discounts || "0") || 0;
        const totalLineItems = Number(aud.total_line_items_price || "0") || 0;
        // Flag: hay descuento de orden y el total subido NO lo restó (≈ subtotal sin rebaja).
        if (totalDiscounts > 0 && pushedTotal >= totalLineItems - 1) {
          flagged.push({
            shopify_name: aud.name,
            shopify_order_id: row.shopify_order_id,
            dropi_order_id: row.dropi_order_id,
            pushed_total: pushedTotal,
            total_line_items: totalLineItems,
            total_discounts: totalDiscounts,
            should_be: Math.max(0, totalLineItems - totalDiscounts),
            overcharge: Math.round(pushedTotal - (totalLineItems - totalDiscounts)),
            pushed_at: row.pushed_at,
          });
        }
      }
      return json({
        ok: true, mode: "audit", days,
        total_pushed: (pushed || []).length, checked, errors,
        flagged_count: flagged.length, flagged,
      }, 200, cors);
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

    // Traer la orden completa de Shopify. Pedimos los campos de descuento a NIVEL
    // DE ORDEN (total_discounts/total_line_items_price): Releasit COD Form registra
    // su "QUANTITY DISCOUNT" como descuento de orden, NO en line_items[].total_discount,
    // así que sin esto el descuento se perdía y Dropi cobraba el subtotal sin rebaja.
    const fields = "id,name,line_items,shipping_lines,shipping_address,billing_address,customer,phone,note,email,total_discounts,total_line_items_price,current_subtotal_price,subtotal_price,current_total_price,total_price";
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
    // Por cada línea de PRODUCTO guardamos su bruto y el descuento ya aplicado, para
    // luego repartir el descuento de ORDEN (ver allocateOrderDiscount más abajo).
    const productDiscountInfo: { resolvedIdx: number; gross: number; lineDiscount: number; qty: number }[] = [];
    const unmapped: Array<{ title: string; sku: string; product_id: number; reason: string }> = [];
    let permissionIssue = false;
    let firstSeenKeys: string[] | undefined;
    let extrasTotal = 0;
    for (let i = 0; i < (ord.line_items || []).length; i++) {
      const li = ord.line_items[i];
      const qty = Number(li.quantity) || 1;
      const gross = (Number(li.price) || 0) * qty;
      // Descuento de la línea: total_discount O la suma de discount_allocations
      // (lo mayor) — Shopify a veces deja total_discount en 0 y el monto en allocations.
      const allocSum = (li.discount_allocations || []).reduce((s, a) => s + (Number(a?.amount) || 0), 0);
      const disc = Math.max(Number(li.total_discount || "0") || 0, allocSum);
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
      productDiscountInfo.push({ resolvedIdx: resolved.length - 1, gross, lineDiscount: disc, qty });
      if (!meta) {
        unmapped.push({ title: line.title, sku: line.sku, product_id: li.product_id, reason: reasonMessage(reason, status) });
      }
    }

    // Repartir el descuento a NIVEL DE ORDEN (ej. "QUANTITY DISCOUNT" de Releasit)
    // sobre las líneas de producto. Se hace ANTES de los overrides del operador,
    // para que un precio puesto a mano gane (igual que con el descuento de línea).
    const orderDiscount = Number(ord.total_discounts || "0") || 0;
    if (orderDiscount > 0 && productDiscountInfo.length > 0) {
      const extras = allocateOrderDiscount(
        productDiscountInfo.map((p) => ({ gross: p.gross, lineDiscount: p.lineDiscount })),
        orderDiscount,
      );
      productDiscountInfo.forEach((p, k) => {
        if (extras[k] > 0) {
          const newLineTotal = Math.max(0, p.gross - p.lineDiscount - extras[k]);
          resolved[p.resolvedIdx].price = Math.round(newLineTotal / p.qty);
        }
      });
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
      // Total real de Shopify para que el modal muestre "Shopify: $X · A cobrar: $Y"
      // y avise si no coinciden (mismo criterio que el bloqueo del confirm).
      const shopifyTotal = Number(ord.current_total_price || ord.total_price || "0") || 0;
      return json({
        ok: true, mode: "preview", shopify_order_id: shopifyOrderId, shopify_name: ord.name,
        client, products: resolved, total, shipping, unmapped, diagnostic, alreadyPushed,
        shopify_total: shopifyTotal, cod_mismatch: isCodOvercharge(total + shipping, shopifyTotal),
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

    // RED DE SEGURIDAD (definitiva): el COD a cobrar NUNCA debe superar el total real
    // de Shopify (lo que el cliente aceptó). Si lo supera, casi seguro se perdió un
    // descuento que el reparto no vio → BLOQUEAMOS antes de crear la orden (cubre el
    // camino de integraciones Y el fallback web, que vienen después). Escape: si el
    // operador puso un precio a mano, manda su decisión y no bloqueamos.
    const pushedGrandTotal = resolved.reduce((s, l) => s + l.price * l.quantity, 0);
    const shopifyTotal = Number(ord.current_total_price || ord.total_price || "0") || 0;
    const hasManualPrice = Object.values(overrides.lines || {}).some((o) => o?.price != null);
    if (!hasManualPrice && isCodOvercharge(pushedGrandTotal, shopifyTotal)) {
      return json({
        ok: false,
        error: `El total a cobrar ($${pushedGrandTotal}) supera el total de Shopify ($${shopifyTotal}). ` +
          `Probablemente un descuento no se aplicó — revisá el pedido en Shopify antes de subirlo a Dropi.`,
        pushed_total: pushedGrandTotal, shopify_total: shopifyTotal, blocked: "cod_mismatch",
      }, 422, cors);
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

      // El error "Undefined property: stdClass::$type" (o "not found" / 404)
      // típicamente significa que el producto es PRIVADO: el endpoint de
      // integraciones no puede crearlo, pero el panel web SÍ. Disparamos el
      // FALLBACK WEB (/api/* con session token). Productos públicos / Colombia
      // que fallan por otra razón NO entran acá (mensaje claro de id inválido).
      const isPrivateProductSignal =
        dropiRes.status === 404 || /\$type|Undefined property|no encontr|not found/i.test(detail);

      if (isPrivateProductSignal) {
        const DROPI_COUNTRY = dropiCfg.countryCode === "EC" ? "ECUADOR" : "COLOMBIA";
        // `total` (línea ~848) se calculó ANTES de foldear el envío en
        // resolved[0].price (línea ~876). Para el panel web los precios por línea
        // y total_order/ValorDeclarado deben ser coherentes, así que recalculamos
        // desde los precios YA con envío incluido.
        const webTotal = resolved.reduce((s, l) => s + l.price * l.quantity, 0);
        try {
          const webOrderId = await createOrderViaWeb(dropiCfg, {
            country: DROPI_COUNTRY,
            client,
            resolved,
            total: webTotal,
          });
          await sb.from("shopify_pushed_orders").insert({
            store_id: storeId, shopify_order_id: shopifyOrderId, status: "created",
            dropi_order_id: webOrderId, payload: dropiPayload, pushed_by: user.id,
          });
          return json({ ok: true, mode: "confirm", dropi_order_id: webOrderId, shopify_name: ord.name, via: "web" }, 200, cors);
        } catch (webErr) {
          const webMsg = webErr instanceof Error ? webErr.message : String(webErr);
          const webStatus = webErr instanceof WebFallbackError ? webErr.status : 502;
          await sb.from("shopify_pushed_orders").insert({
            store_id: storeId, shopify_order_id: shopifyOrderId, status: "error",
            payload: dropiPayload, error_message: `Fallback web [${webStatus}]: ${webMsg}`, pushed_by: user.id,
          });
          return json({ ok: false, error: webMsg, dropiBody: dBody }, webStatus, cors);
        }
      }

      // Falla NO atribuible a producto privado → registrar error y devolver el motivo.
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

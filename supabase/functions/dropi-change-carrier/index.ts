// Edge Function: dropi-change-carrier
//
// Permite a la operadora cambiar la transportadora de un pedido PENDIENTE desde
// Confirmar. Modos:
//   - mode "quote": cotiza en vivo (panel web Dropi) las transportadoras que
//     pueden despachar ese pedido + su precio. Devuelve también la actual.
//   - mode "apply": reasigna la transportadora elegida en Dropi y sincroniza
//     orders.transportadora + orders.external_id local + deja auditoría.
//   - mode "cancel" (FASE 3): cancela DE VERDAD el pedido y mata el fantasma.
//     (a) Orden VIVA en Dropi → PUT /api/orders/myorders/{id} {status:"CANCELADO",
//         reasonComment} (mismo request del "Cancelar orden" del panel) + marca
//         orders.estado='CANCELADO' local. Devuelve canceled:true.
//     (b) FANTASMA (el PUT falla y un GET de integración confirma que la orden YA NO
//         existe en Dropi — 404 "Orden no encontrada"): se cancela SOLO local. Estos
//         son pedidos borrados/reemplazados en Dropi que quedaron atascados PENDIENTE
//         en Guardian (que solo upsertea, nunca borra) y reaparecían al caducar el
//         overlay local a los 7 días. Devuelve canceled:true + dropiMissing:true.
//     (c) Orden viva pero Dropi rechaza → ok:false (el cliente reintenta, no esconde).
//     Antes (v1) el fantasma no moría: el PUT devolvía "Error SQL" porque la orden no
//     existía, y sin el check (b) el pedido quedaba atascado. Root cause hallado en la
//     verificación e2e 2026-07-08 (Manuel Macías 5524000 y dup 6004033 = 404 en Dropi).
//
// Auth: Authorization: Bearer <user_jwt> (debe ser miembro de la tienda).
//
// MECÁNICA REAL DEL CAMBIO (capturada del panel app.dropi.ec con clicks reales,
// 2026-07-01 y 2026-07-06): Dropi NO edita in-place — su propio panel avisa
// "La actualización generará un nuevo ID de la orden" y dispara DOS requests:
//   1) POST /api/orders/myorders (token de SESIÓN web) con:
//        is_edit_order: true
//        id_old_order: <external_id viejo>
//        distributionCompany: { id, name }   // la transportadora ELEGIDA
//      Success → { isSuccess:true, objects:{ id:<NUEVO external_id>, ... } }.
//   2) PUT /api/orders/myorders/<external_id viejo> con:
//        { status: "REEMPLAZADA", reasonComment: "Cancelación por edición de orden", replaced: true }
//      → la vieja queda REEMPLAZADA + deleted_at (soft-delete) y desaparece de
//      los listados. SIN ESTE PUT la vieja sigue PENDIENTE en Dropi y el cron la
//      re-importa a los 5 min → duplicado en Dropi Y en el CRM (bug del 2026-07-06).
//
// Por eso cada recreate hace POST + markOldOrderReplaced() y, al éxito, ACTUALIZA
// la fila local (external_id → nuevo id, transportadora → nuevo nombre) y audita
// el reemplazo. smartMerge dedup por dbId (UUID estable), así que la MISMA fila
// física refleja el cambio en la UI.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { loadStoreConfig, isStoreMember } from "../_shared/dropiStoreConfig.ts";
import { ensureFreshSessionToken } from "../_shared/dropiSessionLogin.ts";
import {
  quoteCarriers,
  dropiWebFetch,
  decodeJwtSub,
  normUp,
  WebFallbackError,
  type QuoteLine,
  type DestCity,
} from "../_shared/dropiWebQuote.ts";

/** Resuelve la ciudad destino contra `dropi_city_catalog` (reemplaza /api/locations,
 *  que Dropi bloquea con 403 desde la IP del datacenter de Supabase). Busca por
 *  (country_code, city_norm, dept_norm); si el dept no matchea, reintenta solo por
 *  city_norm. Devuelve null si la ciudad no está en el catálogo. */
// deno-lint-ignore no-explicit-any
async function resolveDestCity(
  sbAdmin: any,
  countryCode: string,
  city: string,
  state: string,
): Promise<DestCity | null> {
  const country = countryCode === "EC" ? "EC" : "CO";
  const cityNorm = normUp(city);
  const deptNorm = normUp(state);
  if (!cityNorm) return null;

  const withDept = await sbAdmin
    .from("dropi_city_catalog")
    .select("city_id, name, department_id, cod_dane")
    .eq("country_code", country)
    .eq("city_norm", cityNorm)
    .eq("dept_norm", deptNorm)
    .limit(1)
    .maybeSingle();
  // deno-lint-ignore no-explicit-any
  let row: any = withDept?.data ?? null;

  if (!row) {
    const cityOnly = await sbAdmin
      .from("dropi_city_catalog")
      .select("city_id, name, department_id, cod_dane")
      .eq("country_code", country)
      .eq("city_norm", cityNorm)
      .order("id", { ascending: true })
      .limit(1)
      .maybeSingle();
    row = cityOnly?.data ?? null;
  }

  if (!row) return null;
  return {
    cityId: Number(row.city_id),
    name: String(row.name),
    departmentId: row.department_id != null ? Number(row.department_id) : null,
    codDane: String(row.cod_dane),
  };
}

interface ChangeCarrierBody {
  externalId?: string;
  mode?: "quote" | "apply" | "apply_value" | "apply_edit" | "cancel" | "debug";
  /** mode "cancel": motivo de la cancelación (va en reasonComment del PUT a Dropi). */
  reason?: string;
  distributionCompanyId?: number | string;
  name?: string;
  /** modes "apply_value" / "apply_edit": nuevo valor a cobrar (COD) del pedido. */
  newValor?: number | string;
  /** mode "quote": override de líneas para re-cotizar con cantidades/precios editados. */
  lines?: Array<{ dropiId?: number | string; quantity?: number | string; price?: number | string }>;
  /** mode "apply_edit": líneas editadas (mismo set de dropiIds, sin agregar/quitar). */
  newLines?: Array<{ dropiId?: number | string; quantity?: number | string; price?: number | string }>;
}

/** QuoteLine + nombre del producto (para el editor unificado del CRM).
 *  Tipo LOCAL — no tocamos QuoteLine en _shared/dropiWebQuote.ts. */
interface LineDetail extends QuoteLine {
  name?: string;
}

/** Valida un override de líneas del cliente contra las líneas reales del pedido:
 *  mismo SET de dropiIds (sin agregar/quitar), cantidad entera 1-1000, precio ≥0.
 *  Inválido → null (el caller decide el fallback). Conserva el name original. */
function sanitizeLinesOverride(
  raw: ChangeCarrierBody["lines"],
  existing: LineDetail[],
): LineDetail[] | null {
  if (!Array.isArray(raw) || raw.length !== existing.length) return null;
  const byId = new Map(existing.map((l) => [l.dropiId, l]));
  const out: LineDetail[] = [];
  const seen = new Set<number>();
  for (const r of raw) {
    const id = Number(r?.dropiId);
    const orig = byId.get(id);
    if (!orig || seen.has(id)) return null;
    seen.add(id);
    const quantity = Number(r?.quantity);
    const price = Number(r?.price);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) return null;
    if (!Number.isFinite(price) || price < 0) return null;
    out.push({ ...orig, quantity, price });
  }
  return out;
}

interface DropiResult {
  ok: boolean;
  httpStatus: number;
  body: Record<string, unknown>;
  rawText: string;
}

/** Datos de cliente/pedido para reconstruir el body de creación (v2 o fallback DB). */
interface OrderClientFields {
  name: string;
  surname: string;
  dir: string;
  phone: string;
  state: string;
  city: string;
  email: string;
  notes: string;
  rateType: string;
  /** "Orden ID" interno de Dropi (data.shop_order_id) — distinto del external_id. */
  shopOrderId: string;
  /** shop_id del cliente (data.client.shop_id) si viene. */
  shopId: number | null;
}

/** GET de UN pedido por su id externo (integration-key) → para leer orderdetails. */
async function dropiGetOrder(
  base: string,
  apiKey: string,
  storeUrl: string,
  externalId: string,
): Promise<DropiResult> {
  const res = await fetch(
    `${base}/integrations/orders/myorders/${encodeURIComponent(externalId)}`,
    {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "dropi-integration-key": apiKey,
        "Origin": storeUrl,
      },
    },
  );
  const rawText = await res.text();
  let body: Record<string, unknown> = {};
  try { body = rawText ? JSON.parse(rawText) : {}; } catch { body = { raw: rawText }; }
  const ok = res.ok && body.isSuccess !== false;
  return { ok, httpStatus: res.status, body, rawText };
}

/** PUT del total del pedido vía integration-key. OJO: el PUT de Dropi IGNORA EN
 *  SILENCIO los campos que no soporta (devuelve 200 sin cambiar nada — verificado
 *  con distribution_company_id), así que NUNCA confiar en el 200: verificar con
 *  un GET posterior (parseOrderTotal). */
async function dropiPutTotal(
  base: string,
  apiKey: string,
  storeUrl: string,
  externalId: string,
  newTotal: number,
): Promise<DropiResult> {
  const res = await fetch(
    `${base}/integrations/orders/myorders/${encodeURIComponent(externalId)}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "dropi-integration-key": apiKey,
        "Origin": storeUrl,
      },
      body: JSON.stringify({ total_order: newTotal }),
    },
  );
  const rawText = await res.text();
  let body: Record<string, unknown> = {};
  try { body = rawText ? JSON.parse(rawText) : {}; } catch { body = { raw: rawText }; }
  const ok = res.ok && body.isSuccess !== false;
  return { ok, httpStatus: res.status, body, rawText };
}

/** Extrae total_order del cuerpo de un pedido Dropi (integration GET). */
function parseOrderTotal(body: Record<string, unknown>): number | null {
  const order = (body.objects ?? body.data ?? body.order ?? body) as Record<string, unknown>;
  const t = parseFloat(String(order?.total_order ?? ""));
  return Number.isFinite(t) ? t : null;
}

/** Redondeo por país: EC usa centavos (USD), CO pesos enteros. */
function roundMoney(n: number, countryCode: string): number {
  const f = countryCode === "EC" ? 100 : 1;
  return Math.round(n * f) / f;
}

/** Escala los precios de línea para que acompañen el valor nuevo del pedido.
 *  `total_order` es la verdad del recaudo (puede diferir por centavos de la
 *  suma de líneas — el create ya lo permitía), esto solo mantiene coherencia
 *  visual/contable en el panel de Dropi. */
function scaleLinePrices(lines: QuoteLine[], newTotal: number, countryCode: string): QuoteLine[] {
  const oldSum = lines.reduce((s, l) => s + l.price * l.quantity, 0);
  if (oldSum > 0) {
    const factor = newTotal / oldSum;
    return lines.map((l) => ({ ...l, price: roundMoney(l.price * factor, countryCode) }));
  }
  // Sin precios previos: repartir el total entre las unidades.
  const units = lines.reduce((s, l) => s + (l.quantity || 1), 0) || 1;
  const perUnit = roundMoney(newTotal / units, countryCode);
  return lines.map((l) => ({ ...l, price: perUnit }));
}

/** Paridad con el panel Dropi (request capturado en vivo 2026-07-06): tras el
 *  POST create-with-edit, el panel manda este PUT que deja la orden VIEJA con
 *  status=REEMPLAZADA + deleted_at (soft-delete) → desaparece de los listados y
 *  el cron ya no puede re-importarla como duplicado. NUNCA tira: si falla, la
 *  orden nueva ya existe y el caller degrada a warning (la vieja queda activa). */
async function markOldOrderReplaced(
  cfg: Parameters<typeof dropiWebFetch>[0],
  oldId: string,
): Promise<{ ok: boolean; status: number; detail: string }> {
  try {
    const { status, body } = await dropiWebFetch(
      cfg,
      `/api/orders/myorders/${encodeURIComponent(oldId)}`,
      {
        method: "PUT",
        body: { status: "REEMPLAZADA", reasonComment: "Cancelación por edición de orden", replaced: true },
      },
    );
    const ok = status >= 200 && status < 300 && body?.isSuccess !== false;
    return { ok, status, detail: ok ? "" : String(body?.message || body?.error || "").slice(0, 300) };
  } catch (e) {
    return { ok: false, status: 0, detail: e instanceof Error ? e.message.slice(0, 300) : "error" };
  }
}

/** Busca la transportadora elegida DENTRO de las opciones cotizadas (por id o
 *  nombre normalizado). Devuelve la opción completa (con typeService y
 *  shippingAmount) o null si no cotiza esta ruta. Evita POSTear un create con
 *  una carrier sin cobertura — Dropi lo rechaza (a veces con mensaje claro tipo
 *  "La ciudad no tiene habilitado el método de envío", a veces con el genérico
 *  "Error al crear la orden"). Caso real: ECHEANDIA-BOLIVAR-LAARCOURIER 2026-07-09. */
function findQuotedOption(
  options: Array<{ id: number | string; name: string; typeService: string; shippingAmount: number }>,
  dcIdRaw: number | string | undefined,
  dcName: string,
): { id: number | string; name: string; typeService: string; shippingAmount: number } | null {
  const idNum = Number(dcIdRaw);
  const nameNorm = normUp(dcName);
  return (
    options.find((op) => Number(op.id) === idNum && Number.isFinite(idNum)) ??
    options.find((op) => normUp(op.name) === nameNorm && nameNorm !== "") ??
    null
  );
}

/** POST del create-with-edit con reintento defensivo para pedidos "de bot"
 *  (LucidBot/FINAL_ORDER de otra shop): si el primer POST falla y el body
 *  llevaba shop_order_id/shop_id (heredados del pedido viejo vía detalle v2),
 *  reintenta UNA vez sin ellos — el create web que SÍ funciona (shopify-push)
 *  nunca los manda, y Dropi rechaza con el genérico "Error al crear la orden"
 *  cuando el shop_order_id pertenece a otra integración (caso #6053027,
 *  LUCIDBOT-4783411). Loguea cada intento en sync_logs con el body de Dropi. */
async function postCreateWithEdit(
  cfg: Parameters<typeof dropiWebFetch>[0],
  // deno-lint-ignore no-explicit-any
  sbAdmin: any,
  opts: { orderBody: Record<string, unknown>; userId: string; storeId: string; label: string },
): Promise<
  | { ok: true; newId: string; status: number; retriedSinShop: boolean }
  | { ok: false; status: number; detail: string; respBody: Record<string, unknown> | null }
> {
  const attempt = async (body: Record<string, unknown>) => {
    const { status, body: respBody, text } = await dropiWebFetch(
      cfg, `/api/orders/myorders`, { method: "POST", body },
    );
    const ok = status >= 200 && status < 300 && respBody?.isSuccess !== false;
    const rawId =
      (respBody?.objects?.id as string | number | undefined) ??
      (respBody?.id as string | number | undefined) ??
      (respBody?.data?.id as string | number | undefined) ??
      (respBody?.order?.id as string | number | undefined) ??
      null;
    const detail = String(respBody?.message || respBody?.error || text || "error").slice(0, 500);
    return { ok: ok && rawId != null, rawId, status, respBody: respBody ?? null, detail };
  };
  const logFail = async (status: number, detail: string, respBody: unknown, extra: string) => {
    await sbAdmin.from("sync_logs").insert({
      source: "dropi-change-carrier",
      status: "error", synced_count: 0, duplicates_count: 0, total_count: 1,
      triggered_by: opts.userId,
      // Incluir el body crudo de Dropi: el `message` genérico ("Error al crear
      // la orden") no alcanza para diagnosticar; el JSON completo sí.
      error_message: `${opts.label} [${status}]${extra}: ${detail} :: dropiBody=${JSON.stringify(respBody ?? {}).slice(0, 700)}`,
      store_id: opts.storeId,
    });
  };

  const first = await attempt(opts.orderBody);
  if (first.ok) return { ok: true, newId: String(first.rawId), status: first.status, retriedSinShop: false };

  const hadShopFields =
    Boolean(String(opts.orderBody.shop_order_id ?? "").trim()) || opts.orderBody.shop_id != null;
  await logFail(first.status, first.detail, first.respBody, hadShopFields ? " (intento 1, con shop_order_id/shop_id)" : "");

  if (!hadShopFields) {
    return { ok: false, status: first.status, detail: first.detail, respBody: first.respBody };
  }
  // Reintento sin los campos de shop del pedido viejo (paridad con el create que funciona).
  const retryBody = { ...opts.orderBody, shop_order_id: "", shop_id: null };
  const second = await attempt(retryBody);
  if (second.ok) {
    console.log(`[${opts.label}] retry sin shop_order_id/shop_id FUNCIONÓ (pedido de bot/otra shop).`);
    return { ok: true, newId: String(second.rawId), status: second.status, retriedSinShop: true };
  }
  await logFail(second.status, second.detail, second.respBody, " (intento 2, sin shop_order_id/shop_id)");
  return { ok: false, status: second.status, detail: second.detail, respBody: second.respBody };
}

/** Deriva el host api-v2 (detalle web del pedido) desde el host de integraciones.
 *  cfg.base = "https://api.dropi.ec" → "https://api-v2.dropi.ec". */
function apiV2HostFrom(base: string): string {
  // Reemplaza el primer "//api." por "//api-v2." (respeta el TLD del país).
  if (/\/\/api-v2\./.test(base)) return base.replace(/\/+$/, "");
  const v2 = base.replace(/\/\/api\./, "//api-v2.");
  return v2.replace(/\/+$/, "");
}

/** GET https://api-v2.dropi.ec/orders/orders/{externalId} con token de sesión web.
 *  Devuelve el detalle rico (client{...}, rate_type, notes, shop_order_id, products).
 *  Usa session token primero (el que sirve para /api/*), api_key de respaldo. */
async function dropiGetOrderV2(
  cfg: { base: string; sessionToken: string; apiKey: string; storeUrl: string },
  externalId: string,
): Promise<DropiResult> {
  const host = apiV2HostFrom(cfg.base);
  const url = `${host}/orders/orders/${encodeURIComponent(externalId)}`;
  const token = cfg.sessionToken || cfg.apiKey;
  const headers: Record<string, string> = {
    "X-Authorization": "Bearer " + token,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
  if (cfg.storeUrl) headers["Origin"] = cfg.storeUrl;
  const res = await fetch(url, { method: "GET", headers });
  const rawText = await res.text();
  console.log("[dropi-change-carrier] v2 detail", { url, status: res.status, body: rawText.slice(0, 300) });
  let body: Record<string, unknown> = {};
  try { body = rawText ? JSON.parse(rawText) : {}; } catch { body = { raw: rawText }; }
  const ok = res.ok && body.isSuccess !== false;
  return { ok, httpStatus: res.status, body, rawText };
}

/** Extrae los campos de cliente desde el detalle v2 (data.client{...} + data.*). */
function parseV2Client(body: Record<string, unknown>): OrderClientFields | null {
  const data = (body.data ?? body.objects ?? body) as Record<string, unknown>;
  const client = (data?.client ?? {}) as Record<string, unknown>;
  const name = String(client.name ?? data?.name ?? "").trim();
  const phone = String(client.phone ?? data?.phone ?? "").trim();
  const dir = String(client.dir ?? data?.dir ?? "").trim();
  // Sin nombre/teléfono/dirección no podemos crear la orden con confianza.
  if (!name || !phone || !dir) return null;
  return {
    name,
    surname: String(client.surname ?? data?.surname ?? "").trim(),
    dir,
    phone,
    state: String(client.state ?? data?.state ?? "").trim(),
    city: String(client.city ?? data?.city ?? "").trim(),
    email: String(client.client_email ?? client.email ?? data?.client_email ?? "").trim(),
    notes: String(data?.notes ?? "").trim(),
    rateType: String(data?.rate_type ?? "CON RECAUDO").trim() || "CON RECAUDO",
    shopOrderId: data?.shop_order_id != null ? String(data.shop_order_id) : "",
    shopId: client.shop_id != null ? Number(client.shop_id) : (data?.shop_id != null ? Number(data.shop_id) : null),
  };
}

/** Extrae líneas {dropiId, quantity, price, name?} desde el cuerpo de un pedido
 *  Dropi (integration GET) — usado como fallback cuando el detalle v2 no está. */
function parseOrderLines(body: Record<string, unknown>): LineDetail[] {
  // El pedido puede venir en body, body.objects, body.data o body.order.
  const order = (body.objects ?? body.data ?? body.order ?? body) as Record<string, unknown>;
  const details = (order?.orderdetails ?? order?.order_details ?? []) as Array<Record<string, unknown>>;
  const lines: LineDetail[] = [];
  for (const d of Array.isArray(details) ? details : []) {
    const product = (d.product ?? {}) as Record<string, unknown>;
    const dropiId = Number(product.id ?? d.product_id ?? d.id);
    if (!Number.isFinite(dropiId) || dropiId <= 0) continue;
    const quantity = Number(d.quantity ?? 1) || 1;
    const price = Number(d.price ?? product.sale_price ?? product.price ?? 0) || 0;
    const name = String(product.name ?? d.name ?? "").trim() || undefined;
    lines.push({ dropiId, quantity, price, ...(name ? { name } : {}) });
  }
  return lines;
}

/** Extrae líneas {dropiId, quantity, price, name?} desde el detalle v2 (data.products[]). */
function parseV2Lines(body: Record<string, unknown>): LineDetail[] {
  const data = (body.data ?? body.objects ?? body) as Record<string, unknown>;
  const products = (data?.products ?? []) as Array<Record<string, unknown>>;
  const lines: LineDetail[] = [];
  for (const p of Array.isArray(products) ? products : []) {
    const dropiId = Number(p.id ?? p.product_id);
    if (!Number.isFinite(dropiId) || dropiId <= 0) continue;
    const quantity = Number(p.quantity ?? 1) || 1;
    const price = Number(p.price ?? p.sale_price ?? 0) || 0;
    const name = String(p.name ?? "").trim() || undefined;
    lines.push({ dropiId, quantity, price, ...(name ? { name } : {}) });
  }
  return lines;
}

/** Fila Guardian mínima para el fallback de cliente. */
interface OrderRowFallback {
  nombre?: string | null;
  phone?: string | null;
  direccion?: string | null;
  ciudad?: string | null;
  departamento?: string | null;
}

type ClientLinesResult =
  | { ok: true; client: OrderClientFields; lines: LineDetail[] }
  | { ok: false; error: string; dropiBody?: Record<string, unknown> };

/** Prep compartida de los modos que recrean la orden (apply / apply_value):
 *  detalle del cliente + líneas. PRIMERO el detalle v2 (rico: client, rate_type,
 *  notes, shop_order_id, products). FALLBACK a la fila Guardian + integration GET.
 *  Extraída 1:1 del apply original — no cambiar sin re-verificar en vivo. */
async function resolveClientAndLines(
  cfg: { base: string; sessionToken: string; apiKey: string; storeUrl: string },
  orderRow: OrderRowFallback,
  externalId: string,
): Promise<ClientLinesResult> {
  let client: OrderClientFields | null = null;
  let lines: LineDetail[] = [];
  try {
    const v2 = await dropiGetOrderV2(cfg, externalId);
    if (v2.ok) {
      client = parseV2Client(v2.body);
      lines = parseV2Lines(v2.body);
    }
  } catch (e) {
    // No abortamos por el v2: caemos al fallback. Logueamos para diagnóstico.
    console.error("[dropi-change-carrier] v2 detail failed:", e);
  }

  // Fallback de líneas: integration GET (parseOrderLines) si v2 no trajo productos.
  let integrationBody: Record<string, unknown> | null = null;
  if (lines.length === 0) {
    const ord = await dropiGetOrder(cfg.base, cfg.apiKey, cfg.storeUrl, externalId);
    integrationBody = ord.body;
    if (ord.ok) lines = parseOrderLines(ord.body);
  }
  if (lines.length === 0) {
    return {
      ok: false,
      error: "No pude leer los productos del pedido para recrearlo (ni v2 ni integración).",
      dropiBody: integrationBody ?? undefined,
    };
  }

  // Fallback de cliente: la fila Guardian (nombre/phone/direccion/ciudad/departamento).
  if (!client) {
    const nombre = String(orderRow.nombre || "").trim();
    const phone = String(orderRow.phone || "").trim();
    const dir = String(orderRow.direccion || "").trim();
    if (!nombre || !phone || !dir) {
      return {
        ok: false,
        error: "No pude leer los datos del cliente (nombre/teléfono/dirección) para recrear la orden.",
      };
    }
    client = {
      name: nombre,
      surname: "",
      dir,
      phone,
      state: String(orderRow.departamento || "").trim(),
      city: String(orderRow.ciudad || "").trim(),
      email: "",
      notes: "",
      rateType: "CON RECAUDO",
      shopOrderId: "",
      shopId: null,
    };
  }
  return { ok: true, client, lines };
}

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const jsonErr = (error: string, status: number) =>
    new Response(JSON.stringify({ ok: false, error }), {
      status, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  const jsonOk = (payload: Record<string, unknown>, status = 200) =>
    new Response(JSON.stringify(payload), {
      status, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonErr("No autorizado", 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;

    const sbAdmin = createClient(supabaseUrl, serviceKey);
    const sbUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: authError } = await sbUser.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (authError || !userData?.user) return jsonErr("Token inválido", 401);
    const user = userData.user;

    let body: ChangeCarrierBody;
    try { body = await req.json() as ChangeCarrierBody; } catch { return jsonErr("Body inválido", 400); }

    const externalId = String(body.externalId || "").trim();
    const mode = body.mode === "apply"
      ? "apply"
      : body.mode === "apply_value"
        ? "apply_value"
        : body.mode === "apply_edit"
          ? "apply_edit"
          : body.mode === "cancel"
            ? "cancel"
            : "quote";
    if (!externalId) return jsonErr("Falta externalId", 400);

    // ---- Resolver pedido + tienda + membresía ----
    const { data: orderRow, error: orderErr } = await sbAdmin
      .from("orders")
      .select("id, store_id, nombre, phone, direccion, ciudad, departamento, valor, guia, transportadora, external_id")
      .eq("external_id", externalId)
      .maybeSingle();
    if (orderErr || !orderRow) return jsonOk({ ok: false, error: `Pedido ${externalId} no encontrado` });

    const storeId = String((orderRow as { store_id: string }).store_id);
    const isMember = await isStoreMember(sbAdmin, user.id, storeId);
    if (!isMember) return jsonOk({ ok: false, error: "No perteneces a esta tienda" });

    // Guía ya generada → la transportadora quedó fija al imprimir. NO aplica a
    // "cancel": una cancelación es válida aunque el pedido tenga guía (el panel
    // Dropi también lo permite) — el fantasma que matamos puede tener guía en EC.
    if (mode !== "cancel" && String(orderRow.guia || "").trim()) {
      return jsonOk({ ok: false, code: "guia_generada", error: "El pedido ya tiene guía generada; la transportadora no se puede cambiar." });
    }

    const cfg = await loadStoreConfig(sbAdmin, storeId);
    if (!cfg.apiKey) return jsonOk({ ok: false, error: "La tienda no tiene Clave API de Dropi configurada" });

    // =========================== MODE: DEBUG ===========================
    // Diagnóstico A/B para CONFIRMAR el root cause del 401 del edge (2026-07-01):
    // el 401 no era WAF (403) ni token (limpio, mismo que el panel #102) — era el
    // header Origin. El edge mandaba Origin=cfg.storeUrl (rushmira.com) y Dropi lo
    // rechazaba; con Origin=app.dropi.ec (como el panel) da 200. Este branch prueba
    // getOriginCity con AMBOS Origins usando el MISMO token limpio → un solo deploy
    // confirma cuál Origin pasa. También reporta el estado del token (comillas/len).
    if (body.mode === "debug") {
      const appOrigin = cfg.base.replace("://api.", "://app.");
      const rawTok = String(cfg.sessionToken || "");
      const cleanTok = rawTok.replace(/^"+|"+$/g, "");
      const ocFetch = async (origin: string) => {
        try {
          const r = await fetch(`${cfg.base}/api/orders/getOriginCityForCalculateShipping`, {
            method: "POST",
            headers: {
              "X-Authorization": "Bearer " + cleanTok,
              "Content-Type": "application/json",
              "Accept": "application/json, text/plain, */*",
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
              "Origin": origin,
              "Referer": `${appOrigin}/`,
              "Sec-Fetch-Dest": "empty",
              "Sec-Fetch-Mode": "cors",
              "Sec-Fetch-Site": "same-site",
            },
            body: JSON.stringify({ id: 155190, destination: "machala, el oro", type: "SIMPLE" }),
          });
          return { origin, status: r.status, body: (await r.text()).slice(0, 160) };
        } catch (e) { return { origin, status: 0, body: "throw: " + String(e) }; }
      };
      const withAppOrigin = await ocFetch(appOrigin);
      const withStoreOrigin = await ocFetch(cfg.storeUrl || appOrigin);
      // La ruta compartida (ya arreglada a Origin=appOrigin) debe coincidir con withAppOrigin.
      let sharedStatus = 0, sharedBody = "";
      try {
        const oc = await dropiWebFetch(cfg, "/api/orders/getOriginCityForCalculateShipping", {
          method: "POST", body: { id: 155190, destination: "machala, el oro", type: "SIMPLE" },
        });
        sharedStatus = oc.status; sharedBody = String(oc.text || "").slice(0, 160);
      } catch (e) { sharedBody = "throw: " + String(e); }
      return jsonOk({
        ok: true, debug: true,
        appOrigin, storeUrl: cfg.storeUrl,
        tokenLen: rawTok.length, tokenHadQuotes: rawTok !== cleanTok,
        tokenTail: cleanTok.slice(-8),
        withAppOrigin, withStoreOrigin,
        sharedPath: { status: sharedStatus, body: sharedBody },
      });
    }

    // Renovar el session token si venció (login automático por tienda —
    // _shared/dropiSessionLogin). quote/apply/cancel dependen 100% del panel web;
    // apply_value lo renueva LAZY (su camino directo PUT+verify no lo necesita).
    if (mode === "quote" || mode === "apply" || mode === "cancel") {
      try {
        cfg.sessionToken = await ensureFreshSessionToken(sbAdmin, cfg);
      } catch (e) {
        if (e instanceof WebFallbackError) return jsonOk({ ok: false, error: e.message });
        throw e;
      }
    }

    // =========================== MODE: CANCEL ===========================
    // Cancela DE VERDAD el pedido en Dropi. Camino = el mismo PUT que el
    // "Cancelar orden" del panel (request capturado en vivo 2026-07-06):
    //   PUT /api/orders/myorders/{externalId} { status:"CANCELADO", reasonComment }
    // Tras el éxito, marca orders.estado='CANCELADO' (durable + inmediato) para
    // que el pedido salga de la cola sin depender del cron y no reaparezca. Si el
    // PUT falla, NO toca el estado local (el pedido sigue vivo en Dropi) y
    // devuelve ok:false → el cliente conserva su overlay local y avisa "reintentar".
    if (mode === "cancel") {
      const reasonComment = String(body.reason || "").trim() ||
        "Cancelado desde el CRM (gestión de confirmación).";
      const orderId = (orderRow as { id: string }).id;
      const markLocalCanceled = async () => {
        const { error: updErr } = await sbAdmin
          .from("orders").update({ estado: "CANCELADO" }).eq("id", orderId);
        if (updErr) console.error("[cancel] UPDATE local CANCELADO falló:", updErr.message);
      };

      // 1) Cancelar la orden VIVA en Dropi (PUT status=CANCELADO, mismo request del
      //    "Cancelar orden" del panel). Éxito → CANCELADO local (durable, inmediato).
      let put: { status: number; body?: Record<string, unknown> } | null = null;
      let putThrew: string | null = null;
      try {
        put = await dropiWebFetch(
          cfg, `/api/orders/myorders/${encodeURIComponent(externalId)}`,
          { method: "PUT", body: { status: "CANCELADO", reasonComment } },
        );
      } catch (e) {
        putThrew = e instanceof Error ? e.message.slice(0, 300) : "error";
        console.error("[cancel] PUT CANCELADO lanzó:", e);
      }
      const putOk = !!put && put.status >= 200 && put.status < 300 && put.body?.isSuccess !== false;
      if (putOk) {
        await markLocalCanceled();
        return jsonOk({ ok: true, canceled: true, externalId, dropiStatus: put!.status });
      }

      // 2) El PUT falló. ¿La orden EXISTE en Dropi? Si NO (FANTASMA: fue borrada o
      //    reemplazada en Dropi pero quedó atascada PENDIENTE en Guardian — Guardian
      //    solo upsertea, nunca borra al sincronizar), cancelarla LOCAL es correcto y
      //    seguro: no hay nada vivo en Dropi que "mantener". Esto mata el fantasma
      //    (caso Manuel Macías) que reaparecía al caducar el overlay local a los 7
      //    días. Dropi devuelve HTTP 200 con {isSuccess:false, status:404,
      //    message:"Orden no encontrada"} para estos → dropiGetOrder da ok:false.
      //
      //    INVESTIGADO 2026-07-10: NO existe una "segunda opinión" barata para
      //    confirmar el fantasma. El detalle v2 devuelve datos hasta para pedidos
      //    BORRADOS (probado: Manuel Macías muerto y Yolanda viva se ven idénticos)
      //    y la lista de integración es carísima en EC (ignora filtros de fecha →
      //    4400 filas + 429). La protección REAL contra un falso positivo (pedido
      //    de bot LucidBot vivo pero 404 en integración) es el PROPIO CRON: si
      //    Dropi todavía lista el pedido, el próximo upsert (≤5 min) pisa el
      //    estado local y el pedido REAPARECE solo en la cola. Verificado: los 7
      //    fantasmas cancelados el 09-jul siguen CANCELADO tras 30h de cron OK.
      // Señal de "no existe": 404 explícito o el mensaje textual de Dropi
      // ("Orden no encontrada"). NO usar status 400 a secas — un bad-request
      // genérico NO es fantasma.
      const notFoundSignal = (httpStatus: number, b: Record<string, unknown>) =>
        httpStatus === 404 ||
        (b.isSuccess === false &&
          (Number(b.status) === 404 ||
            /no encontrada|no existe|not found/i.test(String(b.message || ""))));
      let ghost = false;
      try {
        const check = await dropiGetOrder(cfg.base, cfg.apiKey, cfg.storeUrl, externalId);
        ghost = notFoundSignal(check.httpStatus, (check.body || {}) as Record<string, unknown>);
      } catch (e) {
        console.error("[cancel] check de existencia falló:", e);
      }
      if (ghost) {
        await markLocalCanceled();
        return jsonOk({
          ok: true, canceled: true, dropiMissing: true, externalId,
          note: "La orden no existe para la API de Dropi — se canceló localmente. Si reaparece en unos minutos, es un pedido del panel/bot de Dropi: cancelalo desde el panel.",
        });
      }

      // 3) La orden EXISTE en Dropi pero rechazó la cancelación → fallo real. NO
      //    tocar el estado local (sigue viva) → el cliente conserva su overlay y
      //    avisa "reintentar". Distinguir fantasma de fallo real evita esconder un
      //    pedido vivo Y evita dejar un fantasma atascado para siempre.
      return jsonOk({
        ok: false, code: "dropi_rejected", dropiStatus: put?.status ?? 0,
        error: putThrew || String(put?.body?.message || put?.body?.error || "Dropi rechazó la cancelación").slice(0, 300),
      });
    }

    // =========================== MODE: QUOTE ===========================
    if (mode === "quote") {
      // 1) Leer las líneas del pedido desde Dropi (no guardamos product ids local).
      //    PRIMERO la integración; si da "Orden no encontrada" (pedidos de bot
      //    LucidBot/FINAL_ORDER de otra shop, INVISIBLES para /integrations pero
      //    vivos en el panel — caso #6053027 2026-07-10), caer al detalle v2 (web),
      //    el mismo fallback que ya usa resolveClientAndLines para los recreates.
      const ord = await dropiGetOrder(cfg.base, cfg.apiKey, cfg.storeUrl, externalId);
      let realLines: LineDetail[] = [];
      if (ord.ok) {
        realLines = parseOrderLines(ord.body);
      } else {
        try {
          cfg.sessionToken = await ensureFreshSessionToken(sbAdmin, cfg);
          const v2q = await dropiGetOrderV2(cfg, externalId);
          if (v2q.ok) realLines = parseV2Lines(v2q.body);
        } catch (e) {
          console.error("[quote] fallback v2 falló:", e);
        }
        if (realLines.length === 0) {
          return jsonOk({
            ok: false,
            error: `No pude leer el pedido en Dropi [${ord.httpStatus}].`,
            dropiHttpStatus: ord.httpStatus,
            dropiBody: ord.body,
          });
        }
      }
      if (realLines.length === 0) {
        return jsonOk({
          ok: false,
          error: "No pude leer los productos del pedido desde Dropi (sin orderdetails con id).",
          dropiBody: ord.body,
        });
      }
      // Override de líneas (botón "Recotizar" del editor unificado): permite
      // cotizar con cantidades/precios editados sin aplicar nada todavía.
      // Inválido → se ignora y se cotiza con las líneas reales.
      const overrideLines = sanitizeLinesOverride(body.lines, realLines);
      const lines = overrideLines ?? realLines;

      // 2) Ciudad destino desde el catálogo local (NO /api/locations, bloqueado por IP).
      const country = cfg.countryCode === "EC" ? "ECUADOR" : "COLOMBIA";
      const destCity = await resolveDestCity(
        sbAdmin, cfg.countryCode, String(orderRow.ciudad || ""), String(orderRow.departamento || ""),
      );
      if (!destCity) {
        return jsonOk({
          ok: false,
          error: "No pude resolver la ciudad destino en el catálogo (agregala a dropi_city_catalog).",
          city: String(orderRow.ciudad || ""), state: String(orderRow.departamento || ""),
        });
      }

      // 3) Cotizar en vivo (panel web — session token; destino ya resuelto del catálogo).
      const total = overrideLines
        ? roundMoney(overrideLines.reduce((s, l) => s + l.price * l.quantity, 0), cfg.countryCode)
        : Number(orderRow.valor) || lines.reduce((s, l) => s + l.price * l.quantity, 0);
      try {
        const ctx = await quoteCarriers(cfg, {
          country,
          city: String(orderRow.ciudad || ""),
          state: String(orderRow.departamento || ""),
          destCity,
          lines,
          total,
        });
        return jsonOk({
          ok: true,
          current: String(orderRow.transportadora || ""),
          options: ctx.options,
          // Editor unificado: líneas usadas para cotizar (dropiId/quantity/price/
          // name) + total — el diálogo pinta el editor de producto con la MISMA
          // llamada que ya hacía para cotizar. Clientes viejos las ignoran.
          lines,
          total,
        });
      } catch (e) {
        if (e instanceof WebFallbackError) {
          // Credenciales vencidas / sin opciones: mensaje accionable + body crudo de
          // Dropi (si lo hay) para diagnosticar sin ir a los logs. No rompe la card.
          return jsonOk({ ok: false, error: e.message, dropiBody: (e as WebFallbackError).body });
        }
        throw e;
      }
    }

    // ======================== MODE: APPLY_VALUE =========================
    // Cambia el VALOR a cobrar (COD) del pedido. Dos caminos, en orden:
    //  1) DIRECTO: PUT total_order con la integration-key + VERIFICACIÓN por GET
    //     (el PUT de Dropi ignora en silencio lo que no soporta — nunca creer el 200).
    //     No necesita session token → funciona aunque el login automático no esté.
    //  2) RECREAR como el panel (create-with-edit, misma mecánica verificada del
    //     apply): cancela la vieja + crea una nueva con el total nuevo y la MISMA
    //     transportadora. Necesita session token (se renueva acá, lazy).
    // El cliente detecta funciones viejas deployadas con `valorApplied === true`.
    if (mode === "apply_value") {
      const newValor = Number(body.newValor);
      if (!Number.isFinite(newValor) || newValor <= 0) {
        return jsonOk({ ok: false, error: "Valor nuevo inválido (debe ser un número mayor a 0)." });
      }
      const oldValor = Number(orderRow.valor) || 0;
      if (Math.abs(newValor - oldValor) < 0.01) {
        return jsonOk({ ok: true, valorApplied: true, method: "no_change", externalId, valor: oldValor });
      }

      // ---- Camino 1: PUT directo + verificación ----
      let putDetail = "";
      try {
        const put = await dropiPutTotal(cfg.base, cfg.apiKey, cfg.storeUrl, externalId, newValor);
        putDetail = `PUT ${put.httpStatus}`;
        if (put.ok) {
          const after = await dropiGetOrder(cfg.base, cfg.apiKey, cfg.storeUrl, externalId);
          const t = after.ok ? parseOrderTotal(after.body) : null;
          if (t !== null && Math.abs(t - newValor) < 0.01) {
            const { error: updErr } = await sbAdmin
              .from("orders")
              .update({ valor: newValor })
              .eq("id", orderRow.id);
            if (updErr) console.error("[apply_value] local valor update failed:", updErr);
            const { error: auditErr } = await sbAdmin.from("order_results").insert({
              order_id: orderRow.id,
              phone: String(orderRow.phone || ""),
              operator_id: user.id,
              module: "confirmar",
              result: "cambio_valor",
              reason: JSON.stringify({ antes: { valor: oldValor }, despues: { valor: newValor }, via: "put" }).slice(0, 2000),
              store_id: storeId,
            });
            if (auditErr) console.error("[apply_value] audit insert failed:", auditErr);
            return jsonOk({ ok: true, valorApplied: true, method: "put", externalId, valor: newValor });
          }
          putDetail += t === null ? " (no pude verificar el total)" : ` (Dropi lo ignoró: total sigue en ${t})`;
        }
      } catch (e) {
        console.error("[apply_value] PUT directo falló:", e);
        putDetail = "PUT falló: " + (e instanceof Error ? e.message : String(e));
      }
      console.log("[apply_value] camino directo no aplicó, recreando.", { externalId, putDetail });

      // ---- Camino 2: recrear como el panel (create-with-edit) ----
      try {
        cfg.sessionToken = await ensureFreshSessionToken(sbAdmin, cfg);
      } catch (e) {
        if (e instanceof WebFallbackError) {
          return jsonOk({
            ok: false,
            error: `Dropi no aceptó el cambio directo del valor (${putDetail}) y no pude entrar al panel para recrear el pedido: ${e.message}`,
          });
        }
        throw e;
      }

      const prepV = await resolveClientAndLines(cfg, orderRow, externalId);
      if (!prepV.ok) {
        return jsonOk({ ok: false, error: prepV.error, ...(prepV.dropiBody ? { dropiBody: prepV.dropiBody } : {}) });
      }
      const clientV = prepV.client;
      // Precios de línea escalados al valor nuevo (total_order manda para el recaudo).
      const linesV = scaleLinePrices(prepV.lines, newValor, cfg.countryCode);

      const countryV = cfg.countryCode === "EC" ? "ECUADOR" : "COLOMBIA";
      const destCityV = await resolveDestCity(sbAdmin, cfg.countryCode, clientV.city, clientV.state);
      if (!destCityV) {
        return jsonOk({
          ok: false,
          error: "No pude resolver la ciudad destino en el catálogo (agregala a dropi_city_catalog).",
          city: clientV.city, state: clientV.state,
        });
      }

      let ctxV;
      try {
        ctxV = await quoteCarriers(cfg, {
          country: countryV,
          city: clientV.city,
          state: clientV.state,
          destCity: destCityV,
          lines: linesV,
          total: newValor,
        });
      } catch (e) {
        if (e instanceof WebFallbackError) {
          return jsonOk({ ok: false, error: e.message, dropiBody: (e as WebFallbackError).body });
        }
        throw e;
      }

      // Mantener la transportadora ACTUAL. Si no cotiza esta ruta (o el pedido
      // no tiene una asignada), caer a la más barata ≠ VELOCES (criterio del push).
      const currentCarrierNorm = normUp(orderRow.transportadora || "");
      const chosen =
        (currentCarrierNorm
          ? ctxV.options.find((op) => normUp(op.name) === currentCarrierNorm)
          : undefined) ??
        ctxV.options.find((op) => normUp(op.name) !== "VELOCES") ??
        ctxV.options[0] ??
        null;
      if (!chosen) {
        return jsonOk({ ok: false, error: "Dropi no devolvió transportadoras para recrear el pedido con el valor nuevo." });
      }

      const userIdV = decodeJwtSub(cfg.sessionToken);
      const orderBodyV: Record<string, unknown> = {
        total_order: newValor,
        notes: clientV.notes || "",
        name: clientV.name,
        surname: clientV.surname || "",
        dir: clientV.dir,
        country: countryV,
        state: ctxV.dest.stateName,
        city: ctxV.dest.cityName,
        phone: clientV.phone,
        client_email: clientV.email || "",
        payment_method_id: 1,
        user_id: userIdV,
        supplier_id: ctxV.supplierId,
        type: "FINAL_ORDER",
        rate_type: clientV.rateType || "CON RECAUDO",
        products: ctxV.products.map((p) => ({
          id: p.dropiId, uid: p.dropiId, quantity: p.quantity, price: p.price, type: p.productType,
        })),
        distributionCompany: { id: chosen.id, name: chosen.name },
        // Paridad con el create web QUE FUNCIONA (shopify-push createOrderViaWeb).
        type_service: chosen.typeService || "normal",
        shipping_amount: chosen.shippingAmount,
        zip_code: null,
        colonia: "",
        shop_id: clientV.shopId ?? null,
        dni: "",
        dni_type: null,
        insurance: false,
        shalom_data: null,
        warehouses_selected_id: ctxV.origin.warehouseId,
        // Flags de EDICIÓN (verificados en vivo) — cancelan la vieja + linkean la nueva.
        is_edit_order: true,
        id_old_order: Number(externalId),
        shop_order_id: clientV.shopOrderId || "",
        shop_order_number: "",
        reasonComment: `Esta orden reemplaza a la orden ${externalId}: cambio de valor ${oldValor} → ${newValor}.`,
      };

      let newIdV: string | null = null;
      let dropiStatusV = 0;
      try {
        const postV = await postCreateWithEdit(cfg, sbAdmin, {
          orderBody: orderBodyV, userId: user.id, storeId, label: "Dropi rechazó el cambio de valor",
        });
        dropiStatusV = postV.status;
        // `=== false` (no `!ok`): narrowing robusto también sin strict mode.
        if (postV.ok === false) {
          return jsonOk({
            ok: false,
            error: `Dropi rechazó el cambio de valor [${postV.status}]: ${postV.detail}`,
            dropiHttpStatus: postV.status,
            dropiBody: postV.respBody,
          });
        }
        newIdV = postV.newId;
      } catch (e) {
        if (e instanceof WebFallbackError) {
          return jsonOk({ ok: false, error: e.message, dropiHttpStatus: (e as WebFallbackError).status, dropiBody: (e as WebFallbackError).body });
        }
        throw e;
      }

      // Paridad panel: soft-borrar la orden vieja (REEMPLAZADA) para que no quede
      // duplicada en Dropi ni la re-importe el cron.
      const replacedV = await markOldOrderReplaced(cfg, externalId);
      if (!replacedV.ok) {
        await sbAdmin.from("sync_logs").insert({
          source: "dropi-change-carrier",
          status: "warn", synced_count: 0, duplicates_count: 0, total_count: 1,
          triggered_by: user.id,
          error_message: `No pude marcar REEMPLAZADA la orden vieja ${externalId} tras crear ${newIdV} [${replacedV.status}]: ${replacedV.detail}`,
          store_id: storeId,
        });
      }

      // Sincronizar la fila Guardian EN SU LUGAR (mismo dbId) — mismo patrón y
      // manejo de carrera 23505 que el apply de transportadora.
      let warningV: string | undefined;
      const { error: updErrV } = await sbAdmin
        .from("orders")
        .update({ external_id: newIdV, valor: newValor, transportadora: chosen.name })
        .eq("id", orderRow.id);
      if (updErrV) {
        console.error("[apply_value] local update failed:", updErrV);
        if ((updErrV as { code?: string }).code === "23505") {
          const { error: cancelErrV } = await sbAdmin
            .from("orders")
            .update({ estado: "CANCELADO" })
            .eq("id", orderRow.id);
          warningV = cancelErrV
            ? `El sync ya trajo la orden nueva ${newIdV} y no pude cancelar la fila vieja: ${cancelErrV.message}.`
            : `El sync ya había traído la orden nueva ${newIdV}; la fila vieja quedó CANCELADO.`;
        } else {
          warningV = `El cambio se aplicó en Dropi (nuevo id ${newIdV}) pero no pude actualizar la fila local: ${updErrV.message}. Puede aparecer un duplicado hasta el próximo sync.`;
        }
      }

      if (!replacedV.ok) {
        const extraV = `La orden vieja #${externalId} pudo quedar activa en Dropi (no se pudo marcar REEMPLAZADA) — verificala/cancelala en el panel.`;
        warningV = warningV ? `${warningV} ${extraV}` : extraV;
      }

      const { error: auditErrV } = await sbAdmin.from("order_results").insert({
        order_id: orderRow.id,
        phone: String(orderRow.phone || clientV.phone || ""),
        operator_id: user.id,
        module: "confirmar",
        result: "cambio_valor",
        reason: JSON.stringify({
          antes: { valor: oldValor, external_id: externalId },
          despues: { valor: newValor, external_id: newIdV, transportadora: chosen.name },
          via: "recreate",
        }).slice(0, 2000),
        store_id: storeId,
      });
      if (auditErrV) console.error("[apply_value] audit insert failed:", auditErrV);

      return jsonOk({
        ok: true,
        valorApplied: true,
        method: "recreate",
        oldReplaced: replacedV.ok,
        externalId: newIdV,
        oldExternalId: externalId,
        valor: newValor,
        transportadora: chosen.name,
        dropiHttpStatus: dropiStatusV,
        ...(warningV ? { warning: warningV } : {}),
      });
    }

    // ======================== MODE: APPLY_EDIT =========================
    // Edición combinada estilo panel Dropi en UNA sola recreación: transportadora
    // y/o líneas (cantidad/precio) y/o valor total. Reusa la mecánica verificada
    // de apply/apply_value (create-with-edit: cancela la vieja + crea la nueva +
    // actualiza la MISMA fila local + audita). ADITIVO: no toca apply ni
    // apply_value. Si el server corre una versión vieja, este mode cae a quote
    // (read-only, no muta) y el cliente lo detecta por la ausencia de
    // `editApplied:true` — seguro por construcción.
    if (mode === "apply_edit") {
      const dcIdRaw = body.distributionCompanyId;
      const dcName = String(body.name || "").trim();
      const hasCarrier = dcIdRaw != null && dcIdRaw !== "" && !!dcName;
      const newValorE = body.newValor != null && body.newValor !== ""
        ? Number(body.newValor)
        : null;
      if (newValorE !== null && (!Number.isFinite(newValorE) || newValorE <= 0)) {
        return jsonOk({ ok: false, error: "Valor nuevo inválido (debe ser un número mayor a 0)." });
      }
      const wantsLines = Array.isArray(body.newLines) && body.newLines.length > 0;
      if (!hasCarrier && !wantsLines && newValorE === null) {
        return jsonOk({ ok: false, error: "Sin cambios: mandá transportadora, líneas o valor nuevo." });
      }
      const oldValorE = Number(orderRow.valor) || 0;

      try {
        cfg.sessionToken = await ensureFreshSessionToken(sbAdmin, cfg);
      } catch (e) {
        if (e instanceof WebFallbackError) return jsonOk({ ok: false, error: e.message });
        throw e;
      }

      const prepE = await resolveClientAndLines(cfg, orderRow, externalId);
      if (!prepE.ok) {
        return jsonOk({ ok: false, error: prepE.error, ...(prepE.dropiBody ? { dropiBody: prepE.dropiBody } : {}) });
      }
      const clientE = prepE.client;

      // Líneas finales: editadas (validadas: mismo set de dropiIds, sin agregar/
      // quitar) > escaladas si solo vino valor nuevo > las reales tal cual.
      let linesE: LineDetail[];
      if (wantsLines) {
        const sanitized = sanitizeLinesOverride(body.newLines, prepE.lines);
        if (!sanitized) {
          return jsonOk({
            ok: false,
            error: "Las líneas editadas no coinciden con las del pedido (mismos productos, cantidad entera 1-1000, precio ≥0; no se puede agregar/quitar líneas). Reabrí el editor para recargarlas.",
          });
        }
        linesE = sanitized;
      } else if (newValorE !== null) {
        linesE = scaleLinePrices(prepE.lines, newValorE, cfg.countryCode);
      } else {
        linesE = prepE.lines;
      }
      // Total final: el valor explícito manda; si no, la suma de las líneas.
      const totalE = newValorE !== null
        ? newValorE
        : roundMoney(linesE.reduce((s, l) => s + l.price * l.quantity, 0), cfg.countryCode);

      const countryE = cfg.countryCode === "EC" ? "ECUADOR" : "COLOMBIA";
      const destCityE = await resolveDestCity(sbAdmin, cfg.countryCode, clientE.city, clientE.state);
      if (!destCityE) {
        return jsonOk({
          ok: false,
          error: "No pude resolver la ciudad destino en el catálogo (agregala a dropi_city_catalog).",
          city: clientE.city, state: clientE.state,
        });
      }

      let ctxE;
      try {
        ctxE = await quoteCarriers(cfg, {
          country: countryE,
          city: clientE.city,
          state: clientE.state,
          destCity: destCityE,
          lines: linesE,
          total: totalE,
        });
      } catch (e) {
        if (e instanceof WebFallbackError) {
          return jsonOk({ ok: false, error: e.message, dropiBody: (e as WebFallbackError).body });
        }
        throw e;
      }

      // Transportadora: la elegida por la operadora VALIDADA contra las opciones
      // cotizadas (antes se mandaba id+name directos sin validar → Dropi rechazaba
      // el create con "La ciudad no tiene habilitado el método de envío" o el
      // genérico "Error al crear la orden"; caso ECHEANDIA/LAARCOURIER 2026-07-09).
      // Si no vino carrier, la ACTUAL resuelta contra las options (patrón apply_value).
      let chosenE: { id: number | string; name: string; typeService: string; shippingAmount: number } | null = null;
      if (hasCarrier) {
        chosenE = findQuotedOption(ctxE.options, dcIdRaw as number | string, dcName);
        if (!chosenE) {
          return jsonOk({
            ok: false,
            code: "carrier_sin_cobertura",
            error: `${dcName} no cotiza envíos a ${ctxE.dest.cityName} (${ctxE.dest.stateName}) para este pedido. Transportadoras disponibles: ${ctxE.options.map((o) => o.name).join(", ") || "ninguna"}. Tocá "Recotizar" y elegí una de la lista.`,
          });
        }
      } else {
        const currentNormE = normUp(orderRow.transportadora || "");
        chosenE =
          (currentNormE ? ctxE.options.find((op) => normUp(op.name) === currentNormE) : undefined) ??
          ctxE.options.find((op) => normUp(op.name) !== "VELOCES") ??
          ctxE.options[0] ?? null;
      }
      if (!chosenE) {
        return jsonOk({ ok: false, error: "Dropi no devolvió transportadoras para recrear el pedido." });
      }

      const userIdE = decodeJwtSub(cfg.sessionToken);
      const orderBodyE: Record<string, unknown> = {
        total_order: totalE,
        notes: clientE.notes || "",
        name: clientE.name,
        surname: clientE.surname || "",
        dir: clientE.dir,
        country: countryE,
        state: ctxE.dest.stateName,
        city: ctxE.dest.cityName,
        phone: clientE.phone,
        client_email: clientE.email || "",
        payment_method_id: 1,
        user_id: userIdE,
        supplier_id: ctxE.supplierId,
        type: "FINAL_ORDER",
        rate_type: clientE.rateType || "CON RECAUDO",
        products: ctxE.products.map((p) => ({
          id: p.dropiId, uid: p.dropiId, quantity: p.quantity, price: p.price, type: p.productType,
        })),
        distributionCompany: { id: chosenE.id, name: chosenE.name },
        // Paridad con el create web QUE FUNCIONA (shopify-push createOrderViaWeb):
        // type_service real cotizado (no "normal" hardcodeado), shipping_amount de
        // la opción elegida, y nulls donde el panel manda null (no "").
        type_service: chosenE.typeService || "normal",
        shipping_amount: chosenE.shippingAmount,
        zip_code: null,
        colonia: "",
        shop_id: clientE.shopId ?? null,
        dni: "",
        dni_type: null,
        insurance: false,
        shalom_data: null,
        warehouses_selected_id: ctxE.origin.warehouseId,
        // Flags de EDICIÓN (verificados en vivo) — cancelan la vieja + linkean la nueva.
        is_edit_order: true,
        id_old_order: Number(externalId),
        shop_order_id: clientE.shopOrderId || "",
        shop_order_number: "",
        reasonComment: `Esta orden reemplaza a la orden ${externalId}: edición desde el CRM (transportadora/cantidades/valor).`,
      };

      let newIdE: string | null = null;
      let dropiStatusE = 0;
      try {
        const postE = await postCreateWithEdit(cfg, sbAdmin, {
          orderBody: orderBodyE, userId: user.id, storeId, label: "Dropi rechazó la edición",
        });
        dropiStatusE = postE.status;
        // `=== false` (no `!ok`): narrowing robusto también sin strict mode.
        if (postE.ok === false) {
          return jsonOk({
            ok: false,
            error: `Dropi rechazó la edición del pedido [${postE.status}]: ${postE.detail}`,
            dropiHttpStatus: postE.status,
            dropiBody: postE.respBody,
          });
        }
        newIdE = postE.newId;
      } catch (e) {
        if (e instanceof WebFallbackError) {
          return jsonOk({ ok: false, error: e.message, dropiHttpStatus: (e as WebFallbackError).status, dropiBody: (e as WebFallbackError).body });
        }
        throw e;
      }

      // Paridad panel: soft-borrar la orden vieja (REEMPLAZADA) para que no quede
      // duplicada en Dropi ni la re-importe el cron.
      const replacedE = await markOldOrderReplaced(cfg, externalId);
      if (!replacedE.ok) {
        await sbAdmin.from("sync_logs").insert({
          source: "dropi-change-carrier",
          status: "warn", synced_count: 0, duplicates_count: 0, total_count: 1,
          triggered_by: user.id,
          error_message: `No pude marcar REEMPLAZADA la orden vieja ${externalId} tras crear ${newIdE} [${replacedE.status}]: ${replacedE.detail}`,
          store_id: storeId,
        });
      }

      // Sincronizar la fila Guardian EN SU LUGAR (mismo dbId) — mismo patrón y
      // manejo de carrera 23505 que apply/apply_value.
      let warningE: string | undefined;
      const { error: updErrE } = await sbAdmin
        .from("orders")
        .update({
          external_id: newIdE,
          transportadora: chosenE.name,
          valor: totalE,
          cantidad: linesE.reduce((s, l) => s + (l.quantity || 1), 0),
        })
        .eq("id", orderRow.id);
      if (updErrE) {
        console.error("[apply_edit] local update failed:", updErrE);
        if ((updErrE as { code?: string }).code === "23505") {
          const { error: cancelErrE } = await sbAdmin
            .from("orders")
            .update({ estado: "CANCELADO" })
            .eq("id", orderRow.id);
          warningE = cancelErrE
            ? `El sync ya trajo la orden nueva ${newIdE} y no pude cancelar la fila vieja: ${cancelErrE.message}.`
            : `El sync ya había traído la orden nueva ${newIdE}; la fila vieja quedó CANCELADO.`;
        } else {
          warningE = `El cambio se aplicó en Dropi (nuevo id ${newIdE}) pero no pude actualizar la fila local: ${updErrE.message}. Puede aparecer un duplicado hasta el próximo sync.`;
        }
      }

      if (!replacedE.ok) {
        const extraE = `La orden vieja #${externalId} pudo quedar activa en Dropi (no se pudo marcar REEMPLAZADA) — verificala/cancelala en el panel.`;
        warningE = warningE ? `${warningE} ${extraE}` : extraE;
      }

      const { error: auditErrE } = await sbAdmin.from("order_results").insert({
        order_id: orderRow.id,
        phone: String(orderRow.phone || clientE.phone || ""),
        operator_id: user.id,
        module: "confirmar",
        result: "edicion_completa",
        reason: JSON.stringify({
          antes: { valor: oldValorE, external_id: externalId, transportadora: orderRow.transportadora || "" },
          despues: {
            valor: totalE,
            external_id: newIdE,
            transportadora: chosenE.name,
            lines: linesE.map((l) => ({ id: l.dropiId, q: l.quantity, p: l.price })),
          },
          via: "recreate",
        }).slice(0, 2000),
        store_id: storeId,
      });
      if (auditErrE) console.error("[apply_edit] audit insert failed:", auditErrE);

      return jsonOk({
        ok: true,
        editApplied: true,
        method: "recreate",
        oldReplaced: replacedE.ok,
        externalId: newIdE,
        oldExternalId: externalId,
        transportadora: chosenE.name,
        valor: totalE,
        dropiHttpStatus: dropiStatusE,
        ...(warningE ? { warning: warningE } : {}),
      });
    }

    // =========================== MODE: APPLY ===========================
    // Create-with-edit: cancela la orden vieja + crea una nueva (nuevo external_id)
    // con la transportadora ELEGIDA. Nunca rompe la card: cualquier fallo devuelve
    // jsonOk({ ok:false, ... }) con el body crudo de Dropi para diagnosticar.
    const distributionCompanyId = body.distributionCompanyId;
    const name = String(body.name || "").trim();
    if (distributionCompanyId == null || distributionCompanyId === "") {
      return jsonOk({ ok: false, error: "Falta distributionCompanyId" });
    }
    if (!name) {
      return jsonOk({ ok: false, error: "Falta el nombre de la transportadora elegida (name)." });
    }

    const country = cfg.countryCode === "EC" ? "ECUADOR" : "COLOMBIA";

    // 1) Detalle del cliente + líneas (prep compartida con apply_value).
    const prep = await resolveClientAndLines(cfg, orderRow, externalId);
    if (!prep.ok) {
      return jsonOk({ ok: false, error: prep.error, ...(prep.dropiBody ? { dropiBody: prep.dropiBody } : {}) });
    }
    const client = prep.client;
    const lines = prep.lines;

    // 2) Ciudad destino desde el catálogo local (NO /api/locations, bloqueado por IP).
    const destCity = await resolveDestCity(sbAdmin, cfg.countryCode, client.city, client.state);
    if (!destCity) {
      return jsonOk({
        ok: false,
        error: "No pude resolver la ciudad destino en el catálogo (agregala a dropi_city_catalog).",
        city: client.city, state: client.state,
      });
    }

    // 3) Cotizar (reusa quoteCarriers) para obtener origin.warehouseId, supplierId,
    //    dest.stateName/cityName y el productType por producto. destino ya resuelto.
    const total = Number(orderRow.valor) || lines.reduce((s, l) => s + l.price * l.quantity, 0);
    let ctx;
    try {
      ctx = await quoteCarriers(cfg, {
        country,
        city: client.city,
        state: client.state,
        destCity,
        lines,
        total,
      });
    } catch (e) {
      if (e instanceof WebFallbackError) {
        return jsonOk({ ok: false, error: e.message, dropiBody: (e as WebFallbackError).body });
      }
      throw e;
    }
    const { dest, origin, products, supplierId } = ctx;

    // 3b) Validar la transportadora ELEGIDA contra las opciones cotizadas — si no
    //     cotiza esta ruta, Dropi rechazaría el create (a veces con el genérico
    //     "Error al crear la orden"). Error claro y accionable ANTES del POST.
    const chosenA = findQuotedOption(ctx.options, distributionCompanyId as number | string, name);
    if (!chosenA) {
      return jsonOk({
        ok: false,
        code: "carrier_sin_cobertura",
        error: `${name} no cotiza envíos a ${dest.cityName} (${dest.stateName}) para este pedido. Transportadoras disponibles: ${ctx.options.map((o) => o.name).join(", ") || "ninguna"}.`,
      });
    }

    // 4) Construir el body de create-with-edit (idéntico al create + flags de edición).
    //    distributionCompany = la transportadora ELEGIDA (NO la más barata ≠ VELOCES).
    const userId = decodeJwtSub(cfg.sessionToken);
    const idOldOrder = Number(externalId);
    const orderBody: Record<string, unknown> = {
      total_order: total,
      notes: client.notes || "",
      name: client.name,
      surname: client.surname || "",
      dir: client.dir,
      country,
      state: dest.stateName,
      city: dest.cityName,
      phone: client.phone,
      client_email: client.email || "",
      payment_method_id: 1,
      user_id: userId,
      supplier_id: supplierId,
      type: "FINAL_ORDER",
      rate_type: client.rateType || "CON RECAUDO",
      products: products.map((p) => ({
        id: p.dropiId, uid: p.dropiId, quantity: p.quantity, price: p.price, type: p.productType,
      })),
      distributionCompany: { id: chosenA.id, name: chosenA.name },
      // Paridad con el create web QUE FUNCIONA (shopify-push createOrderViaWeb).
      type_service: chosenA.typeService || "normal",
      shipping_amount: chosenA.shippingAmount,
      zip_code: null,
      colonia: "",
      shop_id: client.shopId ?? null,
      dni: "",
      dni_type: null,
      insurance: false,
      shalom_data: null,
      warehouses_selected_id: origin.warehouseId,
      // Flags de EDICIÓN (verificados en vivo) — cancelan la vieja + linkean la nueva.
      is_edit_order: true,
      id_old_order: idOldOrder,
      shop_order_id: client.shopOrderId || "",
      shop_order_number: "",
      reasonComment: `Esta orden reemplaza a la orden ${externalId} que fue editada por el usuario.`,
    };

    // 5) POST /api/orders/myorders (session token vía dropiWebFetch sobre cfg.base).
    let newExternalId: string | null = null;
    let dropiHttpStatus = 0;
    try {
      const postA = await postCreateWithEdit(cfg, sbAdmin, {
        orderBody, userId: user.id, storeId, label: "Dropi rechazó el cambio",
      });
      dropiHttpStatus = postA.status;
      // `=== false` (no `!ok`): narrowing robusto también sin strict mode.
      if (postA.ok === false) {
        return jsonOk({
          ok: false,
          error: `Dropi rechazó el cambio de transportadora [${postA.status}]: ${postA.detail}`,
          dropiHttpStatus: postA.status,
          dropiBody: postA.respBody,
        });
      }
      newExternalId = postA.newId;
    } catch (e) {
      if (e instanceof WebFallbackError) {
        return jsonOk({ ok: false, error: e.message, dropiHttpStatus: (e as WebFallbackError).status, dropiBody: (e as WebFallbackError).body });
      }
      throw e;
    }

    // 4b) Paridad panel: soft-borrar la orden vieja (REEMPLAZADA) para que no quede
    //     duplicada en Dropi ni la re-importe el cron.
    const replacedA = await markOldOrderReplaced(cfg, externalId);
    if (!replacedA.ok) {
      await sbAdmin.from("sync_logs").insert({
        source: "dropi-change-carrier",
        status: "warn", synced_count: 0, duplicates_count: 0, total_count: 1,
        triggered_by: user.id,
        error_message: `No pude marcar REEMPLAZADA la orden vieja ${externalId} tras crear ${newExternalId} [${replacedA.status}]: ${replacedA.detail}`,
        store_id: storeId,
      });
    }

    // 5) Sincronizar la fila Guardian EN SU LUGAR (mismo dbId): external_id → nuevo id,
    //    transportadora → nuevo nombre. Sin esto, el nightly-reconcile crearía un
    //    duplicado (nuevo id como INSERT) y dejaría el viejo huérfano.
    let warning: string | undefined;
    const { error: updErr } = await sbAdmin
      .from("orders")
      .update({ external_id: newExternalId, transportadora: chosenA.name })
      .eq("id", orderRow.id);
    if (updErr) {
      console.error("[dropi-change-carrier] local external_id/transportadora update failed:", updErr);
      if ((updErr as { code?: string }).code === "23505") {
        // Carrera con el cron: orders.external_id tiene UNIQUE GLOBAL y el sync ya
        // insertó la orden nueva como fila propia en los segundos entre el create en
        // Dropi y este UPDATE. La fila vieja quedó obsoleta (Dropi la canceló):
        // la marcamos CANCELADO para no dejar un duplicado pendiente en la cola.
        const { error: cancelErr } = await sbAdmin
          .from("orders")
          .update({ estado: "CANCELADO" })
          .eq("id", orderRow.id);
        warning = cancelErr
          ? `El sync ya trajo la orden nueva ${newExternalId} y no pude cancelar la fila vieja: ${cancelErr.message}.`
          : `El sync ya había traído la orden nueva ${newExternalId}; la fila vieja quedó CANCELADO.`;
      } else {
        warning = `El cambio se aplicó en Dropi (nuevo id ${newExternalId}) pero no pude actualizar la fila local: ${updErr.message}. Puede aparecer un duplicado hasta el próximo sync.`;
      }
    }

    if (!replacedA.ok) {
      const extraA = `La orden vieja #${externalId} pudo quedar activa en Dropi (no se pudo marcar REEMPLAZADA) — verificala/cancelala en el panel.`;
      warning = warning ? `${warning} ${extraA}` : extraA;
    }

    // Auditoría del reemplazo (incluye old→new external id para trazabilidad).
    const auditPayload = {
      antes: { external_id: externalId, transportadora: orderRow.transportadora || "" },
      despues: { external_id: newExternalId, transportadora: chosenA.name },
    };
    const { error: auditErr } = await sbAdmin.from("order_results").insert({
      order_id: orderRow.id,
      phone: String(orderRow.phone || client.phone || ""),
      operator_id: user.id,
      module: "confirmar",
      result: "cambio_transportadora",
      reason: JSON.stringify(auditPayload).slice(0, 2000),
      store_id: storeId,
    });
    if (auditErr) console.error("[dropi-change-carrier] audit insert failed:", auditErr);

    return jsonOk({
      ok: true,
      oldReplaced: replacedA.ok,
      externalId: newExternalId,
      oldExternalId: externalId,
      transportadora: chosenA.name,
      dropiHttpStatus,
      ...(warning ? { warning } : {}),
    });
  } catch (err) {
    console.error("dropi-change-carrier error:", err);
    const msg = err instanceof Error ? err.message : "Error interno";
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

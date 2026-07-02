// Edge Function: dropi-change-carrier
//
// Permite a la operadora cambiar la transportadora de un pedido PENDIENTE desde
// Confirmar. Dos modos:
//   - mode "quote": cotiza en vivo (panel web Dropi) las transportadoras que
//     pueden despachar ese pedido + su precio. Devuelve también la actual.
//   - mode "apply": reasigna la transportadora elegida en Dropi y sincroniza
//     orders.transportadora + orders.external_id local + deja auditoría.
//
// Auth: Authorization: Bearer <user_jwt> (debe ser miembro de la tienda).
//
// MECÁNICA REAL DEL CAMBIO (verificada en vivo, panel app.dropi.ec 2026-07-01):
// Dropi NO reasigna la transportadora con un PUT distribution_company_id (eso es
// un no-op: devuelve 200 pero nunca cambia nada). Lo que hace el panel al
// "Editar Orden" es CANCELAR la orden vieja y CREAR una nueva (nuevo external_id)
// vía POST /api/orders/myorders (token de SESIÓN web) con:
//     is_edit_order: true
//     id_old_order: <external_id viejo>
//     distributionCompany: { id, name }   // la transportadora ELEGIDA
// Success → { isSuccess:true, objects:{ id:<NUEVO external_id>, ... } }.
//
// Por eso el "apply" hace un create-with-edit y, al éxito, ACTUALIZA la fila
// local (external_id → nuevo id, transportadora → nuevo nombre) y audita el
// reemplazo. Si no lo hiciéramos, el nightly-reconcile/sync crearía un duplicado
// (el nuevo id como INSERT) y dejaría el viejo huérfano. smartMerge dedup por
// dbId (UUID estable), así que la MISMA fila física refleja el cambio en la UI.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { loadStoreConfig, isStoreMember } from "../_shared/dropiStoreConfig.ts";
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
  mode?: "quote" | "apply";
  distributionCompanyId?: number | string;
  name?: string;
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

/** Extrae líneas {dropiId, quantity, price} desde el cuerpo de un pedido Dropi
 *  (integration GET) — usado como fallback cuando el detalle v2 no está. */
function parseOrderLines(body: Record<string, unknown>): QuoteLine[] {
  // El pedido puede venir en body, body.objects, body.data o body.order.
  const order = (body.objects ?? body.data ?? body.order ?? body) as Record<string, unknown>;
  const details = (order?.orderdetails ?? order?.order_details ?? []) as Array<Record<string, unknown>>;
  const lines: QuoteLine[] = [];
  for (const d of Array.isArray(details) ? details : []) {
    const product = (d.product ?? {}) as Record<string, unknown>;
    const dropiId = Number(product.id ?? d.product_id ?? d.id);
    if (!Number.isFinite(dropiId) || dropiId <= 0) continue;
    const quantity = Number(d.quantity ?? 1) || 1;
    const price = Number(d.price ?? product.sale_price ?? product.price ?? 0) || 0;
    lines.push({ dropiId, quantity, price });
  }
  return lines;
}

/** Extrae líneas {dropiId, quantity, price} desde el detalle v2 (data.products[]). */
function parseV2Lines(body: Record<string, unknown>): QuoteLine[] {
  const data = (body.data ?? body.objects ?? body) as Record<string, unknown>;
  const products = (data?.products ?? []) as Array<Record<string, unknown>>;
  const lines: QuoteLine[] = [];
  for (const p of Array.isArray(products) ? products : []) {
    const dropiId = Number(p.id ?? p.product_id);
    if (!Number.isFinite(dropiId) || dropiId <= 0) continue;
    const quantity = Number(p.quantity ?? 1) || 1;
    const price = Number(p.price ?? p.sale_price ?? 0) || 0;
    lines.push({ dropiId, quantity, price });
  }
  return lines;
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
    const mode = body.mode === "apply" ? "apply" : "quote";
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

    // Guía ya generada → la transportadora quedó fija al imprimir.
    if (String(orderRow.guia || "").trim()) {
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

    // =========================== MODE: QUOTE ===========================
    if (mode === "quote") {
      // 1) Leer las líneas del pedido desde Dropi (no guardamos product ids local).
      const ord = await dropiGetOrder(cfg.base, cfg.apiKey, cfg.storeUrl, externalId);
      if (!ord.ok) {
        return jsonOk({
          ok: false,
          error: `No pude leer el pedido en Dropi [${ord.httpStatus}].`,
          dropiHttpStatus: ord.httpStatus,
          dropiBody: ord.body,
        });
      }
      const lines = parseOrderLines(ord.body);
      if (lines.length === 0) {
        return jsonOk({
          ok: false,
          error: "No pude leer los productos del pedido desde Dropi (sin orderdetails con id).",
          dropiBody: ord.body,
        });
      }

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
      const total = Number(orderRow.valor) || lines.reduce((s, l) => s + l.price * l.quantity, 0);
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

    // 1) Detalle del cliente + líneas. PRIMERO el detalle v2 (rico: client, rate_type,
    //    notes, shop_order_id, products). FALLBACK a la fila Guardian + integration GET.
    let client: OrderClientFields | null = null;
    let lines: QuoteLine[] = [];
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
      return jsonOk({
        ok: false,
        error: "No pude leer los productos del pedido para recrearlo (ni v2 ni integración).",
        dropiBody: integrationBody ?? undefined,
      });
    }

    // Fallback de cliente: la fila Guardian (nombre/phone/direccion/ciudad/departamento).
    if (!client) {
      const nombre = String(orderRow.nombre || "").trim();
      const phone = String(orderRow.phone || "").trim();
      const dir = String(orderRow.direccion || "").trim();
      if (!nombre || !phone || !dir) {
        return jsonOk({
          ok: false,
          error: "No pude leer los datos del cliente (nombre/teléfono/dirección) para recrear la orden.",
        });
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

    // 3) Construir el body de create-with-edit (idéntico al create + flags de edición).
    //    distributionCompany = la transportadora ELEGIDA (NO la más barata ≠ VELOCES).
    const userId = decodeJwtSub(cfg.sessionToken);
    const idOldOrder = Number(externalId);
    // El panel manda el id como número; coercionamos por si la UI lo pasó string.
    const dcIdNum = Number(distributionCompanyId);
    const dcId = Number.isFinite(dcIdNum) ? dcIdNum : distributionCompanyId;
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
      distributionCompany: { id: dcId, name },
      type_service: "normal",
      zip_code: "",
      colonia: "",
      shop_id: client.shopId ?? null,
      dni: "",
      dni_type: "",
      insurance: false,
      warehouses_selected_id: origin.warehouseId,
      // Flags de EDICIÓN (verificados en vivo) — cancelan la vieja + linkean la nueva.
      is_edit_order: true,
      id_old_order: idOldOrder,
      shop_order_id: client.shopOrderId || "",
      shop_order_number: "",
      reasonComment: `Esta orden reemplaza a la orden ${externalId} que fue editada por el usuario.`,
    };

    // 4) POST /api/orders/myorders (session token vía dropiWebFetch sobre cfg.base).
    let newExternalId: string | null = null;
    let dropiHttpStatus = 0;
    try {
      const { status, body: respBody, text } = await dropiWebFetch(
        cfg,
        `/api/orders/myorders`,
        { method: "POST", body: orderBody },
      );
      dropiHttpStatus = status;
      const ok = status >= 200 && status < 300 && respBody?.isSuccess !== false;
      const newId =
        (respBody?.objects?.id as string | number | undefined) ??
        (respBody?.id as string | number | undefined) ??
        (respBody?.data?.id as string | number | undefined) ??
        (respBody?.order?.id as string | number | undefined) ??
        null;
      if (!ok || newId == null) {
        const detail = String(respBody?.message || respBody?.error || text || "error").slice(0, 500);
        await sbAdmin.from("sync_logs").insert({
          source: "dropi-change-carrier",
          status: "error", synced_count: 0, duplicates_count: 0, total_count: 1,
          triggered_by: user.id, error_message: `Dropi rechazó el cambio [${status}]: ${detail}`,
          store_id: storeId,
        });
        return jsonOk({
          ok: false,
          error: `Dropi rechazó el cambio de transportadora [${status}]: ${detail}`,
          dropiHttpStatus: status,
          dropiBody: respBody,
        });
      }
      newExternalId = String(newId);
    } catch (e) {
      if (e instanceof WebFallbackError) {
        return jsonOk({ ok: false, error: e.message, dropiHttpStatus: (e as WebFallbackError).status, dropiBody: (e as WebFallbackError).body });
      }
      throw e;
    }

    // 5) Sincronizar la fila Guardian EN SU LUGAR (mismo dbId): external_id → nuevo id,
    //    transportadora → nuevo nombre. Sin esto, el nightly-reconcile crearía un
    //    duplicado (nuevo id como INSERT) y dejaría el viejo huérfano.
    let warning: string | undefined;
    const { error: updErr } = await sbAdmin
      .from("orders")
      .update({ external_id: newExternalId, transportadora: name })
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

    // Auditoría del reemplazo (incluye old→new external id para trazabilidad).
    const auditPayload = {
      antes: { external_id: externalId, transportadora: orderRow.transportadora || "" },
      despues: { external_id: newExternalId, transportadora: name },
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
      externalId: newExternalId,
      oldExternalId: externalId,
      transportadora: name,
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

// Edge Function: dropi-update-order
//
// Purpose
// -------
// Update an order's status in Dropi using the **integration-key flow** (same
// header that `dropi-sync` already uses for reads).
//
// History
// -------
// We originally wrote this function to use the Bearer-token flow documented in
// the Dropi integration PDF (login email+password → token → PUT). That path is
// blocked in practice because the user account has 2FA enabled and the
// documented /api/login endpoint does not accept a TOTP code, so it returns
// 403 Access denied.
//
// After testing with curl we confirmed that `PUT /integrations/orders/myorders/{id}`
// with the `dropi-integration-key` header IS accepted by Dropi (even though
// the PDF does not document PUT on that path). So this version of the function
// uses the same read-only key that dropi-sync uses, avoiding the whole Bearer
// / 2FA mess.
//
// Invocation from frontend
// ------------------------
//   supabase.functions.invoke('dropi-update-order', {
//     body: { externalId: '<dropi order id>' }     // real PUT
//   })
//   supabase.functions.invoke('dropi-update-order', {
//     body: { dryRun: true }                       // connectivity test only
//   })
//   supabase.functions.invoke('dropi-update-order', {
//     body: { externalId: '...', status: 'GUIA_GENERADA' }  // override status
//   })
//
// The default new status is "PENDIENTE" (move orders from PENDIENTE
// CONFIRMACION → PENDIENTE the moment the operator confirms the call).
//
// VERIFY-AFTER-PUT (2026-07-12)
// -----------------------------
// El PUT de Dropi puede devolver 200 {isSuccess:true} y NO aplicar el cambio
// (mismo patrón visto con distribution_company_id en dropi-change-carrier).
// Por eso, tras un PUT "ok", hacemos un GET al mismo endpoint de integración
// y comparamos el status real:
//   - status nuevo (o un estado POSTERIOR del funnel) → { ok:true, verified:true }
//   - status NO cambió → FALLO { ok:false, code:'put_ignorado' } + sync_logs error
//   - PUT falló con señal 404/"Orden no encontrada" y el GET la confirma →
//     { ok:false, code:'pedido_bot' } (pedidos del bot LucidBot/FINAL_ORDER:
//     ninguna superficie por-id los escribe; NO deben reintentarse eterno).
// Respuesta SIEMPRE JSON: { ok, code?, verified?, externalId, newStatus,
// dropiHttpStatus, error? }.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { loadStoreConfig, storeIdFromExternalId, isStoreMember } from "../_shared/dropiStoreConfig.ts";
import { ensureFreshSessionToken } from "../_shared/dropiSessionLogin.ts";
import { dropiWebFetch, WebFallbackError } from "../_shared/dropiWebQuote.ts";
import {
  checkOrderLivenessWeb,
  getShopOrderIdV2,
  listActiveOrdersByPhone,
} from "../_shared/dropiOrderLiveness.ts";

const DEFAULT_NEW_STATUS = "PENDIENTE";

// Only these statuses can be pushed to Dropi via this endpoint. This prevents
// an operator from sending arbitrary strings (e.g. "CANCELADO") through the
// integration key. Add new values here as new flows are implemented.
const ALLOWED_STATUSES = ["PENDIENTE", "GUIA_GENERADA", "CONFIRMADO"];

interface DropiResult {
  ok: boolean;
  httpStatus: number;
  body: Record<string, unknown>;
  rawText: string;
}

async function dropiPutOrder(
  base: string,
  apiKey: string,
  storeUrl: string,
  externalId: string,
  newStatus: string,
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
      body: JSON.stringify({ status: newStatus }),
    },
  );

  const rawText = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = rawText ? JSON.parse(rawText) : {};
  } catch {
    body = { raw: rawText };
  }

  const ok = res.ok && body.isSuccess !== false;
  return { ok, httpStatus: res.status, body, rawText };
}

/** GET del pedido en el MISMO endpoint de integración que el PUT.
 *  Usado para VERIFY-AFTER-PUT y para confirmar la señal "Orden no encontrada"
 *  (mismo helper que dropi-change-carrier). */
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
  try {
    body = rawText ? JSON.parse(rawText) : {};
  } catch {
    body = { raw: rawText };
  }
  const ok = res.ok && body.isSuccess !== false;
  return { ok, httpStatus: res.status, body, rawText };
}

/** Extrae el status del cuerpo de un pedido Dropi (integration GET).
 *  Mismo patrón de shapes que parseOrderTotal en dropi-change-carrier
 *  (objects | data | order | raíz; objects puede venir como array). */
function parseOrderStatus(body: Record<string, unknown>): string | null {
  const raw = body.objects ?? body.data ?? body.order ?? body;
  const order = (Array.isArray(raw) ? raw[0] : raw) as
    | Record<string, unknown>
    | undefined;
  const s = String(order?.status ?? "").trim();
  return s ? s : null;
}

/** Normaliza un status Dropi para comparar: mayúsculas, sin acentos,
 *  `_` → espacio, espacios colapsados ("GUIA_GENERADA" ≡ "GUIA GENERADA"). */
function normalizeStatus(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Orden del funnel Dropi. Un status con rank MAYOR que el pedido en el PUT
// también cuenta como verificado (alguien/la transportadora lo movió adelante).
// CANCELADO/REEMPLAZADA van en -1: NO son "posterior del funnel" — si el GET
// los muestra tras un PUT ok, el cambio NO quedó aplicado como se pidió.
const FUNNEL_RANK: Record<string, number> = {
  "CANCELADO": -1,
  "REEMPLAZADA": -1,
  "PENDIENTE CONFIRMACION": 0,
  "POR CONFIRMAR": 0,
  "PENDIENTE": 1,
  "CONFIRMADO": 2,
  "PREPARADO PARA TRANSPORTADORA": 3,
  "GUIA GENERADA": 4,
  "EN BODEGA TRANSPORTADORA": 5,
  "EN PROCESAMIENTO": 5,
  "EN RUTA": 6,
  "EN TRANSITO": 6,
  "EN REPARTO": 7,
  "INTENTO DE ENTREGA": 7,
  "NOVEDAD": 7,
  "REEXPEDICION": 7,
  "RECLAME EN OFICINA": 7,
  "EN OFICINA": 7,
  "ENTREGADO": 8,
  "EN DEVOLUCION": 8,
  "DEVOLUCION": 8,
  "DEVUELTO": 8,
};

/** Señal de "la orden no existe para esta superficie": 404 explícito o el
 *  200 {isSuccess:false, status:404, "Orden no encontrada"} típico de los
 *  pedidos del bot (LucidBot/FINAL_ORDER) y de los borrados en Dropi.
 *  Variantes reales: "Orden no encontrada", "no encontrado" y "No se encontró
 *  registro" — esta última fue LA de los ~20 confirms fallidos del 2026-07-13
 *  y el regex viejo (/no encontrada|.../) NO la matcheaba, así que esos fallos
 *  caían al error genérico sin clasificarse como pedido bot. Alineado con la
 *  variante probada de _shared/dropiCancelOrder.ts.
 *  NO usar un 400 a secas — un bad-request genérico no es esta señal. */
function notFoundSignal(httpStatus: number, b: Record<string, unknown>): boolean {
  return (
    httpStatus === 404 ||
    (b.isSuccess === false &&
      (Number(b.status) === 404 ||
        /no (se )?encontr|no existe|not found/i.test(String(b.message || ""))))
  );
}

/** FALLBACK WEB para confirmar pedidos clase-bot (2026-07-13): la API de
 *  integración no los ve ("No se encontró registro") pero el canal WEB del
 *  panel SÍ escribe las órdenes VIVAS — el mismo PUT /api/orders/myorders/{id}
 *  que usa la cancelación (verificado en vivo: #6110951 pasó a PENDIENTE con
 *  isSuccess:true). Tras el PUT, VERIFICA por el LISTADO buscado por teléfono
 *  (el detalle v2 NO trae status) que el status realmente avanzó. Nunca tira. */
async function webConfirmFallback(
  cfg: { base: string; sessionToken: string; apiKey: string; storeUrl: string },
  // deno-lint-ignore no-explicit-any
  sb: any,
  externalId: string,
  newStatus: string,
  phone: string,
): Promise<
  | { ok: true; verified: boolean; currentStatus: string | null; putStatus: number }
  | { ok: false; detail: string; putStatus: number; putBody?: unknown }
> {
  try {
    cfg.sessionToken = await ensureFreshSessionToken(sb, cfg);
  } catch (e) {
    const msg = e instanceof WebFallbackError ? e.message : (e instanceof Error ? e.message : String(e));
    return { ok: false, detail: `sin sesión web: ${msg}`.slice(0, 300), putStatus: 0 };
  }
  let putStatus = 0;
  let putBody: Record<string, unknown> | undefined;
  try {
    const put = await dropiWebFetch(
      cfg,
      `/api/orders/myorders/${encodeURIComponent(externalId)}`,
      { method: "PUT", body: { status: newStatus } },
    );
    putStatus = put.status;
    putBody = put.body as Record<string, unknown>;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, detail: `PUT web lanzó: ${msg}`.slice(0, 300), putStatus: 0 };
  }
  const putOk = putStatus >= 200 && putStatus < 300 && putBody?.isSuccess !== false;
  // Verificar por el listado-teléfono (el PUT web puede devolver 200 ignorando).
  let currentStatus: string | null = null;
  try {
    const live = await checkOrderLivenessWeb(cfg, externalId, { phone });
    if (live.via === "listing" && live.estado) currentStatus = live.estado;
  } catch (e) {
    console.error("dropi-update-order: verify listado del fallback web lanzó:", e);
  }
  if (currentStatus) {
    const rank = FUNNEL_RANK[normalizeStatus(currentStatus)];
    const target = FUNNEL_RANK[normalizeStatus(newStatus)];
    if (rank !== undefined && target !== undefined && rank >= target) {
      return { ok: true, verified: true, currentStatus, putStatus };
    }
    // Listado legible y el status NO avanzó → el PUT web no aplicó de verdad.
    return {
      ok: false,
      detail: `PUT web [${putStatus}] pero el status sigue ${currentStatus}`,
      putStatus,
      putBody,
    };
  }
  if (putOk) {
    // PUT aceptado sin verificación posible: no castigamos (criterio leniente
    // del verify de integración) pero queda verified:false y logueado.
    return { ok: true, verified: false, currentStatus: null, putStatus };
  }
  return {
    ok: false,
    detail: String(putBody?.message || putBody?.error || `PUT web falló [${putStatus}]`).slice(0, 300),
    putStatus,
    putBody,
  };
}

/** RETARGET A LA HERMANA VIVA (2026-07-13, caso Cristina/Luis): cuando el
 *  pedido de Guardian es el STUB de una compra que Dropi forwardeó, NINGÚN
 *  canal lo escribe (integración 404 + PUT web "Error SQL desconocido") — pero
 *  la orden VIVA de la MISMA compra (mismo shop_order_id, id más nuevo) SÍ
 *  acepta el PUT web (probado: stub #6110807 → viva #6110951 → PENDIENTE ok).
 *  Resuelve la hermana por listado-teléfono + match de shop_order_id (v2),
 *  la confirma, verifica, y retargetea la fila Guardian (external_id → viva).
 *  Devuelve null si no hay UNA hermana inequívoca. Nunca tira. */
async function confirmLiveSibling(
  cfg: { base: string; sessionToken: string; apiKey: string; storeUrl: string },
  // deno-lint-ignore no-explicit-any
  sb: any,
  opts: { stubId: string; newStatus: string; phone: string; nombre: string; orderRowId: string; storeId: string },
): Promise<{ siblingId: string; verified: boolean; retargeted: boolean } | null> {
  const { stubId, newStatus, phone, nombre, orderRowId, storeId } = opts;
  // 1) Candidatas vivas del cliente (excluye el stub).
  let sibs: Awaited<ReturnType<typeof listActiveOrdersByPhone>> = [];
  try {
    sibs = await listActiveOrdersByPhone(cfg, { phone, fallbackName: nombre, excludeIds: [stubId] });
  } catch {
    return null;
  }
  let candidates = sibs.filter((s) => /PENDIENTE CONFIRMACION|POR CONFIRMAR/i.test(String(s.status || "")));
  if (candidates.length === 0) return null;
  // 2) Con 2+ candidatas, desambiguar por shop_order_id (misma compra exacta).
  if (candidates.length > 1) {
    const stubShop = await getShopOrderIdV2(cfg, stubId);
    if (!stubShop) return null;
    const matched: typeof candidates = [];
    for (const c of candidates.slice(0, 4)) {
      const shop = await getShopOrderIdV2(cfg, c.id);
      if (shop && shop === stubShop) matched.push(c);
    }
    candidates = matched;
  }
  if (candidates.length !== 1) return null;
  const sibling = candidates[0];
  // 3) Confirmar la hermana viva por el canal web + verificar por listado.
  const web = await webConfirmFallback(cfg, sb, sibling.id, newStatus, phone);
  if (!web.ok) return null;
  // 4) Retarget de la fila Guardian: la card de la asesora pasa a apuntar a la
  //    orden viva (mismo patrón in-place del editor). Carrera 23505 (el cron ya
  //    importó la hermana como fila propia) → la fila stub queda REEMPLAZADA.
  let retargeted = false;
  try {
    const { error: updErr } = await sb.from("orders")
      .update({ external_id: sibling.id })
      .eq("id", orderRowId);
    if (!updErr) {
      retargeted = true;
    } else if ((updErr as { code?: string }).code === "23505") {
      await sb.from("orders").update({ estado: "REEMPLAZADA" }).eq("id", orderRowId);
    } else {
      console.error("dropi-update-order: retarget local falló:", updErr);
    }
  } catch (e) {
    console.error("dropi-update-order: retarget local lanzó:", e);
  }
  await sb.from("sync_logs").insert({
    source: "dropi-update-order",
    status: "warn", synced_count: 1, duplicates_count: 0, total_count: 1,
    store_id: storeId,
    error_message: `Stub del bot #${stubId} sin superficie de escritura — la confirmación se aplicó a la orden VIVA de la misma compra #${sibling.id} (${web.verified ? "verificada" : "sin verificar"}); fila local ${retargeted ? "retargeteada" : "marcada REEMPLAZADA"}.`,
  });
  return { siblingId: sibling.id, verified: web.verified, retargeted };
}

async function dropiSanityCheck(
  base: string,
  apiKey: string,
  storeUrl: string,
): Promise<{ ok: boolean; httpStatus: number; message?: string }> {
  const url =
    `${base}/integrations/orders/myorders?result_number=1&start=0` +
    `&date_from=2020-01-01&date_to=2020-01-01` +
    `&filter_date_by=FECHA%20DE%20CREADO&orderBy=id&orderDirection=desc`;

  const res = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "dropi-integration-key": apiKey,
      "Origin": storeUrl,
    },
  });

  const rawText = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = rawText ? JSON.parse(rawText) : {};
  } catch {
    body = {};
  }

  const ok = res.ok && body.isSuccess !== false;
  const message = ok ? "Conexión OK" : String(body.message || `HTTP ${res.status}`);
  return { ok, httpStatus: res.status, message };
}

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ---- Auth: require a Supabase-authenticated caller (JWT in Authorization) ----
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "No autorizado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, supabaseServiceKey);

    // C1: Eliminado el bypass que aceptaba `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
    // como autenticación válida. La service-role key NUNCA debe compararse
    // contra input del caller — un admin con acceso a app_settings podía
    // leerla del legacy `dropi_service_role_fallback` y operar sobre
    // cualquier pedido sin audit trail. El antiguo retry de dropi-cron
    // que dependía de este bypass fue removido también.
    const anonKey =
      Deno.env.get("SUPABASE_ANON_KEY") ||
      Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
    const anonClient = createClient(supabaseUrl, anonKey);
    const {
      data: { user: authUser },
      error: authError,
    } = await anonClient.auth.getUser(authHeader.replace("Bearer ", ""));
    if (authError || !authUser) {
      return new Response(JSON.stringify({ error: "Token inválido" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const user: { id: string } = authUser;

    // ---- Role check: solo admin u operator pueden tocar Dropi ----
    const { data: roles } = await sb
      .from("user_roles")
      .select("role")
      .eq("user_id", authUser.id);
    const allowed = (roles || []).some((r: { role: string }) => r.role === "admin" || r.role === "operator");
    if (!allowed) {
      return new Response(JSON.stringify({ error: "No tienes permiso para actualizar pedidos en Dropi" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ---- Parse body ----
    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      /* no body */
    }
    const dryRun = body.dryRun === true;
    const externalId =
      typeof body.externalId === "string" ? body.externalId.trim() : "";
    // Normalize to uppercase so the value sent to Dropi always matches
    // the allowlist exactly. Previously, a caller sending "pendiente"
    // passed validation (via .toUpperCase() check) but the mixed-case
    // original was sent to Dropi, which could reject it or store garbage.
    const newStatus =
      typeof body.status === "string" && body.status.trim()
        ? body.status.trim().toUpperCase()
        : DEFAULT_NEW_STATUS;

    if (!dryRun && !externalId) {
      return new Response(
        JSON.stringify({ error: "Falta externalId en el body" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // ---- Validate status against allowlist ----
    if (!dryRun && !ALLOWED_STATUSES.includes(newStatus.toUpperCase())) {
      return new Response(
        JSON.stringify({ error: `Estado '${newStatus}' no permitido. Permitidos: ${ALLOWED_STATUSES.join(", ")}` }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // ---- Resolve store + verify order exists ----
    let storeId: string | null =
      typeof body.storeId === "string" && body.storeId.trim() ? body.storeId.trim() : null;

    let orderRowId = "";
    let orderPhone = "";
    let orderNombre = "";
    if (!dryRun) {
      const { data: orderRow } = await sb
        .from("orders")
        .select("id, store_id, phone, nombre")
        .eq("external_id", externalId)
        .maybeSingle();
      if (!orderRow) {
        return new Response(
          JSON.stringify({ error: `Pedido ${externalId} no encontrado en la base de datos` }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      storeId = String((orderRow as { store_id: string }).store_id);
      orderRowId = String((orderRow as { id: string }).id);
      orderPhone = String((orderRow as { phone?: string | null }).phone || "");
      orderNombre = String((orderRow as { nombre?: string | null }).nombre || "");
    }

    if (!storeId) {
      return new Response(
        JSON.stringify({ error: "Falta storeId (para dryRun) o externalId válido." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ---- Membership check ----
    const isMember = await isStoreMember(sb, user.id, storeId);
    if (!isMember) {
      return new Response(
        JSON.stringify({ error: "No perteneces a esta tienda" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ---- Load store config (integration-key + store URL + host por país) ----
    const cfg = await loadStoreConfig(sb, storeId);
    if (!cfg.apiKey) {
      return new Response(
        JSON.stringify({
          error: "La tienda no tiene Clave API de Dropi. Configurala en Ajustes → Tienda.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ---- PROBE (solo admin, 2026-07-13): diagnóstico crudo del camino de
    // confirmación sobre UN pedido — integration PUT + fallback web + v2.
    // Ejecuta los PUTs DE VERDAD (la gracia es confirmar un pedido bot real que
    // las asesoras necesitan confirmado) pero no escribe sync_logs de éxito.
    if (body.probe === true) {
      const isAdmin = (roles || []).some((r: { role: string }) => r.role === "admin");
      if (!isAdmin) {
        return new Response(JSON.stringify({ error: "probe es solo para admin" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const integrationPut = await dropiPutOrder(cfg.base, cfg.apiKey, cfg.storeUrl, externalId, newStatus);
      const web = await webConfirmFallback(cfg, sb, externalId, newStatus, orderPhone);
      let listingAfter: Record<string, unknown> = {};
      try {
        const live = await checkOrderLivenessWeb(cfg, externalId, { phone: orderPhone, fallbackName: orderNombre });
        listingAfter = live as unknown as Record<string, unknown>;
      } catch (e) {
        listingAfter = { error: e instanceof Error ? e.message : String(e) };
      }
      return new Response(
        JSON.stringify({
          ok: true,
          probe: true,
          externalId,
          newStatus,
          integrationPut: { status: integrationPut.httpStatus, body: integrationPut.body },
          webFallback: web,
          listingAfter,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ---- DryRun: just a sanity GET so the admin can verify connectivity ----
    if (dryRun) {
      const check = await dropiSanityCheck(cfg.base, cfg.apiKey, cfg.storeUrl);
      return new Response(
        JSON.stringify({
          ok: check.ok,
          dryRun: true,
          dropiHttpStatus: check.httpStatus,
          message: check.message,
        }),
        {
          status: check.ok ? 200 : 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // ---- PUT order status via integration-key ----
    const res = await dropiPutOrder(cfg.base, cfg.apiKey, cfg.storeUrl, externalId, newStatus);

    // Log de error en sync_logs con contexto completo. Antes se insertaba
    // status='error' SIN error_message NI store_id — imposible de diagnosticar.
    const logSyncError = async (message: string) => {
      await sb.from("sync_logs").insert({
        source: "dropi-update-order",
        status: "error",
        synced_count: 0,
        duplicates_count: 0,
        total_count: 1,
        triggered_by: user?.id ?? null,
        store_id: storeId,
        error_message: message.slice(0, 500),
      });
    };

    if (!res.ok) {
      const errorMsg = `Dropi PUT [${res.httpStatus}]: ${String(
        res.body.message || res.body.error || res.rawText || "error",
      ).slice(0, 300)}`;

      // ---- ¿YA confirmado? El PUT PENDIENTE CONFIRMACION → PENDIENTE falla con
      // "La orden no se encuentra en estatus PENDIENTE_CONFIRMACION" cuando el
      // pedido YA salió de esa etapa (lo confirmó un intento previo, el bot, o
      // Dropi mismo). Eso NO es un fallo: la meta (confirmar) ya está cumplida.
      // Verificamos con un GET que de verdad esté en PENDIENTE o más adelante
      // (NO cancelado/reemplazado) antes de declararlo éxito idempotente.
      // Sin esto, 9+ pedidos CO reales por día figuraban "confirmación falló"
      // en el panel aunque el cliente SÍ quedó confirmado (auditoría 2026-07-13).
      if (
        normalizeStatus(newStatus) === "PENDIENTE" &&
        /no se encuentra en est[a]tus\s+pendiente[_\s]?confirmacion/i.test(
          `${res.body.message || res.body.error || res.rawText || ""}`
            .normalize("NFD").replace(/[̀-ͯ]/g, ""),
        )
      ) {
        try {
          const chk = await dropiGetOrder(cfg.base, cfg.apiKey, cfg.storeUrl, externalId);
          const st = chk.ok ? parseOrderStatus(chk.body) : null;
          const rank = st ? FUNNEL_RANK[normalizeStatus(st)] : undefined;
          if (rank !== undefined && rank >= FUNNEL_RANK["PENDIENTE"]) {
            // Ya está confirmado (o más adelante): éxito idempotente.
            await sb.from("sync_logs").insert({
              source: "dropi-update-order", status: "success",
              synced_count: 1, duplicates_count: 0, total_count: 1,
              triggered_by: user?.id ?? null, store_id: storeId,
            });
            return new Response(
              JSON.stringify({
                ok: true, verified: true, alreadyConfirmed: true,
                externalId, newStatus, currentStatus: st, dropiHttpStatus: res.httpStatus,
              }),
              { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }
        } catch (e) {
          console.error("dropi-update-order: verify de 'ya confirmado' falló:", e);
        }
      }

      // ---- ¿Pedido del bot? El PUT falló con señal "Orden no encontrada":
      // confirmamos con un GET a la MISMA superficie de integración. Los
      // pedidos del bot de Dropi (LucidBot/FINAL_ORDER) están VIVOS en el
      // panel pero dan 404 en toda superficie por-id — reintentarlos eterno
      // (cron, ventana 7d) nunca va a funcionar. Esta clase NO debe
      // reintentarse: se gestiona a mano en el panel de Dropi.
      if (notFoundSignal(res.httpStatus, res.body)) {
        let getConfirmsNotFound = false;
        try {
          const check = await dropiGetOrder(cfg.base, cfg.apiKey, cfg.storeUrl, externalId);
          getConfirmsNotFound = notFoundSignal(check.httpStatus, check.body);
        } catch (e) {
          // GET lanzó (red): no podemos confirmar la clase → caer al error genérico.
          console.error("dropi-update-order: GET de confirmación 404 lanzó:", e);
        }
        if (getConfirmsNotFound) {
          // FALLBACK WEB (2026-07-13): la integración no ve pedidos clase-bot
          // pero el canal web del panel SÍ escribe las órdenes VIVAS (probado:
          // #6110951 → PENDIENTE ok). Intentar el mismo PUT con el status
          // pedido + verificación por listado ANTES de rendirse con pedido_bot.
          // Degradación segura: si el web también falla, la respuesta es la
          // misma de siempre (pedido_bot) con el detalle del fallback.
          const web = await webConfirmFallback(cfg, sb, externalId, newStatus, orderPhone);
          if (web.ok) {
            await sb.from("sync_logs").insert({
              source: "dropi-update-order",
              status: "success",
              synced_count: 1,
              duplicates_count: 0,
              total_count: 1,
              triggered_by: user?.id ?? null,
              store_id: storeId,
            });
            return new Response(
              JSON.stringify({
                ok: true,
                verified: web.verified,
                via: "web",
                externalId,
                newStatus,
                currentStatus: web.currentStatus,
                dropiHttpStatus: web.putStatus,
              }),
              { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }
          // RETARGET A LA HERMANA VIVA (caso Cristina/Luis 2026-07-13): el id
          // de Guardian es el STUB de una compra forwardeada — ningún canal lo
          // escribe, pero la orden VIVA de la misma compra sí. Resolver por
          // teléfono + shop_order_id, confirmarla y retargetear la fila local.
          const sib = await confirmLiveSibling(cfg, sb, {
            stubId: externalId, newStatus, phone: orderPhone, nombre: orderNombre,
            orderRowId, storeId: String(storeId),
          });
          if (sib) {
            return new Response(
              JSON.stringify({
                ok: true,
                verified: sib.verified,
                via: "web_sibling",
                externalId: sib.siblingId,
                oldExternalId: externalId,
                retargeted: sib.retargeted,
                newStatus,
              }),
              { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }
          const botError =
            `Pedido del bot de Dropi — la API no permite actualizarlo y el fallback web tampoco pudo (${web.detail}); gestionalo en el panel de Dropi.`;
          await logSyncError(
            `pedido_bot: PUT y GET integración dan "Orden no encontrada"; fallback web falló (${web.detail}); sin hermana viva inequívoca para retarget | external_id=${externalId} → ${newStatus}`,
          );
          // HTTP 200 con ok:false para que el cliente pueda LEER code/error
          // (con un 5xx, supabase.functions.invoke deja data=null).
          return new Response(
            JSON.stringify({
              ok: false,
              code: "pedido_bot",
              error: botError,
              externalId,
              newStatus,
              dropiHttpStatus: res.httpStatus,
            }),
            {
              status: 200,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
      }

      await logSyncError(`${errorMsg} | external_id=${externalId} → ${newStatus}`);

      return new Response(
        JSON.stringify({
          ok: false,
          error: errorMsg,
          externalId,
          newStatus,
          dropiHttpStatus: res.httpStatus,
        }),
        {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // ---- VERIFY-AFTER-PUT ----
    // El PUT de Dropi puede devolver 200 {isSuccess:true} y NO aplicar el
    // cambio (patrón ya verificado con distribution_company_id en
    // dropi-change-carrier). Nunca confiar en el 200: releer el pedido.
    let verified = false;
    let currentStatus: string | null = null;
    let putIgnored = false; // GET ok y el status quedó en un estado ANTERIOR (no aplicó)
    try {
      const after = await dropiGetOrder(cfg.base, cfg.apiKey, cfg.storeUrl, externalId);
      if (after.ok) {
        currentStatus = parseOrderStatus(after.body);
        if (currentStatus) {
          const cur = normalizeStatus(currentStatus);
          const target = normalizeStatus(newStatus);
          const rankCur = FUNNEL_RANK[cur];
          const rankTarget = FUNNEL_RANK[target];
          if (cur === target) {
            verified = true;
          } else if (rankCur !== undefined && rankTarget !== undefined && rankCur > rankTarget) {
            // Estado POSTERIOR del funnel: la transportadora/otro flujo ya lo
            // movió adelante — el pedido no está atascado, cuenta como aplicado.
            verified = true;
          } else if (rankCur !== undefined && rankTarget !== undefined) {
            // Sigue en un estado ANTERIOR (típico: "PENDIENTE CONFIRMACION")
            // o en CANCELADO/REEMPLAZADA → Dropi ignoró el PUT.
            putIgnored = true;
          } else {
            // Status no enumerado en FUNNEL_RANK: casi seguro un estado de
            // transportadora posterior. No fallamos, pero no juramos verified.
            console.warn(
              `dropi-update-order: status desconocido en verify: "${currentStatus}" (${externalId})`,
            );
          }
        }
      } else {
        // GET falló (throttle/404 raro tras PUT ok): no castigamos un PUT que
        // Dropi aceptó — devolvemos ok:true pero verified:false.
        console.warn(
          `dropi-update-order: GET de verificación falló [${after.httpStatus}] para ${externalId} — PUT ok sin verificar`,
        );
      }
    } catch (e) {
      console.error("dropi-update-order: verify GET lanzó:", e);
    }

    if (putIgnored) {
      const ignoredMsg = `PUT 200 pero Dropi no aplicó (status sigue ${currentStatus})`;
      await logSyncError(`${ignoredMsg} | external_id=${externalId} → ${newStatus}`);
      // HTTP 200 con ok:false: el cliente actual ya trata data.ok===false como
      // fallo (markDropiFailure) y además puede leer code/error.
      return new Response(
        JSON.stringify({
          ok: false,
          code: "put_ignorado",
          error: ignoredMsg,
          externalId,
          newStatus,
          dropiHttpStatus: res.httpStatus,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // ---- Success (éxito no lleva error_message; sí store_id) ----
    await sb.from("sync_logs").insert({
      source: "dropi-update-order",
      status: "success",
      synced_count: 1,
      duplicates_count: 0,
      total_count: 1,
      triggered_by: user?.id ?? null,
      store_id: storeId,
    });

    return new Response(
      JSON.stringify({
        ok: true,
        verified,
        externalId,
        newStatus,
        dropiHttpStatus: res.httpStatus,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    console.error("dropi-update-order error:", err);
    const msg = err instanceof Error ? err.message : "Error interno";

    // Best-effort error log (may fail if sb was never created).
    try {
      const sb = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      await sb.from("sync_logs").insert({
        source: "dropi-update-order",
        status: "error",
        synced_count: 0,
        duplicates_count: 0,
        total_count: 0,
        error_message: msg.slice(0, 500),
      });
    } catch {
      /* ignore */
    }

    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

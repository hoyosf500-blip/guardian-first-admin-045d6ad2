// Edge Function: dropi-change-carrier
//
// Permite a la operadora cambiar la transportadora de un pedido PENDIENTE desde
// Confirmar. Dos modos:
//   - mode "quote": cotiza en vivo (panel web Dropi) las transportadoras que
//     pueden despachar ese pedido + su precio. Devuelve también la actual.
//   - mode "apply": reasigna la transportadora elegida en Dropi y sincroniza
//     orders.transportadora local + deja auditoría en order_results.
//
// Auth: Authorization: Bearer <user_jwt> (debe ser miembro de la tienda).
//
// FASE 0 (cómo aplica Dropi el cambio): el "apply" usa el integration-key
// permanente vía PUT /integrations/orders/myorders/{id} con
// { distribution_company_id }. Siempre devolvemos dropiHttpStatus + dropiBody
// para verificar la respuesta cruda. Si Dropi rechaza ese campo, capturar el
// request real del panel (DevTools) y ajustar `dropiApplyCarrier`.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { loadStoreConfig, isStoreMember } from "../_shared/dropiStoreConfig.ts";
import { quoteCarriers, WebFallbackError, type QuoteLine } from "../_shared/dropiWebQuote.ts";

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

/** PUT que reasigna la transportadora (FASE 0 — Candidato A, integration-key). */
async function dropiApplyCarrier(
  base: string,
  apiKey: string,
  storeUrl: string,
  externalId: string,
  distributionCompanyId: number | string,
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
      body: JSON.stringify({ distribution_company_id: distributionCompanyId }),
    },
  );
  const rawText = await res.text();
  let body: Record<string, unknown> = {};
  try { body = rawText ? JSON.parse(rawText) : {}; } catch { body = { raw: rawText }; }
  const ok = res.ok && body.isSuccess !== false;
  return { ok, httpStatus: res.status, body, rawText };
}

/** Extrae líneas {dropiId, quantity, price} desde el cuerpo de un pedido Dropi. */
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
      .select("id, store_id, ciudad, departamento, valor, guia, transportadora, external_id")
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

      // 2) Cotizar en vivo (panel web — session token).
      const country = cfg.countryCode === "EC" ? "ECUADOR" : "COLOMBIA";
      const total = Number(orderRow.valor) || lines.reduce((s, l) => s + l.price * l.quantity, 0);
      try {
        const ctx = await quoteCarriers(cfg, {
          country,
          city: String(orderRow.ciudad || ""),
          state: String(orderRow.departamento || ""),
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
          // Token de sesión vencido / sin opciones: mensaje accionable, no rompe la card.
          return jsonOk({ ok: false, error: e.message });
        }
        throw e;
      }
    }

    // =========================== MODE: APPLY ===========================
    const distributionCompanyId = body.distributionCompanyId;
    const name = String(body.name || "").trim();
    if (distributionCompanyId == null || distributionCompanyId === "") {
      return jsonOk({ ok: false, error: "Falta distributionCompanyId" });
    }

    const dropi = await dropiApplyCarrier(cfg.base, cfg.apiKey, cfg.storeUrl, externalId, distributionCompanyId);
    if (!dropi.ok) {
      const detail = String(dropi.body.message || dropi.body.error || dropi.rawText || "error").slice(0, 500);
      await sbAdmin.from("sync_logs").insert({
        source: "dropi-change-carrier",
        status: "error", synced_count: 0, duplicates_count: 0, total_count: 1,
        triggered_by: user.id, error_message: `Dropi rechazó el cambio [${dropi.httpStatus}]: ${detail}`,
        store_id: storeId,
      });
      return jsonOk({
        ok: false,
        error: `Dropi rechazó el cambio de transportadora [${dropi.httpStatus}]: ${detail}`,
        dropiHttpStatus: dropi.httpStatus,
        dropiBody: dropi.body,
      });
    }

    // Dropi aceptó → sincronizar nombre local (si la UI lo mandó).
    if (name) {
      const { error: updErr } = await sbAdmin
        .from("orders")
        .update({ transportadora: name })
        .eq("id", orderRow.id);
      if (updErr) console.error("[dropi-change-carrier] local update failed:", updErr);
    }

    const auditPayload = {
      antes: { transportadora: orderRow.transportadora || "" },
      despues: { transportadora: name || `id:${distributionCompanyId}` },
    };
    const { error: auditErr } = await sbAdmin.from("order_results").insert({
      order_id: orderRow.id,
      phone: "",
      operator_id: user.id,
      module: "confirmar",
      result: "cambio_transportadora",
      reason: JSON.stringify(auditPayload).slice(0, 2000),
      store_id: storeId,
    });
    if (auditErr) console.error("[dropi-change-carrier] audit insert failed:", auditErr);

    return jsonOk({
      ok: true,
      externalId,
      transportadora: name || null,
      dropiHttpStatus: dropi.httpStatus,
    });
  } catch (err) {
    console.error("dropi-change-carrier error:", err);
    const msg = err instanceof Error ? err.message : "Error interno";
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

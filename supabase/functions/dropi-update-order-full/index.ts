// Edge Function: dropi-update-order-full
//
// Update editable customer fields on a Dropi order (multi-tenant: resolves
// store from the order's external_id, uses that store's API key + país host).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { loadStoreConfig, isStoreMember } from "../_shared/dropiStoreConfig.ts";

interface EditPayload {
  externalId: string;
  nombre?: string;
  apellido?: string;
  phone?: string;
  ciudad?: string;
  departamento?: string;
  direccion?: string;
  email?: string;
}

function sanitizePhone(p: string): string {
  return (p || "").replace(/\D/g, "");
}
function isValidEmail(e: string): boolean {
  if (!e) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

interface DropiResult { ok: boolean; httpStatus: number; body: Record<string, unknown>; rawText: string; }

async function dropiPutCustomer(
  base: string,
  apiKey: string,
  storeUrl: string,
  externalId: string,
  payload: Record<string, unknown>,
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
      body: JSON.stringify(payload),
    },
  );
  const rawText = await res.text();
  let body: Record<string, unknown> = {};
  try { body = rawText ? JSON.parse(rawText) : {}; } catch { body = { raw: rawText }; }
  const ok = res.ok && body.isSuccess !== false;
  return { ok, httpStatus: res.status, body, rawText };
}

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const jsonErr = (error: string, status: number) =>
    new Response(JSON.stringify({ ok: false, error }), {
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

    let body: EditPayload;
    try { body = await req.json() as EditPayload; } catch { return jsonErr("Body inválido", 400); }

    const externalId = String(body.externalId || "").trim();
    if (!externalId) return jsonErr("Falta externalId", 400);

    const nombre = String(body.nombre || "").trim();
    const apellido = String(body.apellido || "").trim();
    const phone = sanitizePhone(String(body.phone || ""));
    const ciudad = String(body.ciudad || "").trim();
    const departamento = String(body.departamento || "").trim();
    const direccion = String(body.direccion || "").trim();
    const email = String(body.email || "").trim();

    if (!nombre) return jsonErr("Nombre obligatorio", 400);
    if (!direccion) return jsonErr("Dirección obligatoria", 400);
    if (!ciudad) return jsonErr("Ciudad obligatoria", 400);
    if (!departamento) return jsonErr("Departamento obligatorio", 400);
    if (phone && (phone.length < 7 || phone.length > 15)) return jsonErr("Teléfono inválido (7-15 dígitos)", 400);
    if (email && !isValidEmail(email)) return jsonErr("Email inválido", 400);

    const { data: orderRow, error: orderErr } = await sbAdmin
      .from("orders")
      .select("id, store_id, assigned_to, nombre, phone, ciudad, departamento, direccion, email, external_id")
      .eq("external_id", externalId)
      .maybeSingle();
    if (orderErr || !orderRow) return jsonErr(`Pedido ${externalId} no encontrado`, 404);

    const storeId = String((orderRow as { store_id: string }).store_id);
    const isMember = await isStoreMember(sbAdmin, user.id, storeId);
    if (!isMember) return jsonErr("No perteneces a esta tienda", 403);

    const fullName = apellido ? `${nombre} ${apellido}`.trim() : nombre;

    const nothingChanged =
      orderRow.nombre === fullName &&
      orderRow.phone === phone &&
      (orderRow.ciudad || "") === ciudad &&
      (orderRow.departamento || "") === departamento &&
      (orderRow.direccion || "") === direccion &&
      (orderRow.email || "") === email;
    if (nothingChanged) {
      return new Response(JSON.stringify({ ok: true, noChange: true }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const cfg = await loadStoreConfig(sbAdmin, storeId);
    if (!cfg.apiKey) return jsonErr("La tienda no tiene Clave API de Dropi configurada", 400);

    const dropiPayload: Record<string, unknown> = {
      name: nombre,
      surname: apellido || "",
      dir: direccion,
      city: ciudad,
      state: departamento,
    };
    if (phone) dropiPayload.phone = phone;
    if (email) dropiPayload.email = email;

    const dropi = await dropiPutCustomer(cfg.base, cfg.apiKey, cfg.storeUrl, externalId, dropiPayload);

    if (!dropi.ok) {
      const detail = String(dropi.body.message || dropi.body.error || dropi.rawText || "error").slice(0, 500);
      const errorMsg = `Dropi rechazó el cambio [${dropi.httpStatus}]: ${detail}`;
      await sbAdmin.from("sync_logs").insert({
        source: "dropi-update-order-full",
        status: "error", synced_count: 0, duplicates_count: 0, total_count: 1,
        triggered_by: user.id, error_message: errorMsg, store_id: storeId,
      });
      return new Response(JSON.stringify({
        ok: false, error: errorMsg, dropiHttpStatus: dropi.httpStatus, dropiBody: dropi.body,
      }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Usar sbAdmin: la membresía ya se validó arriba (línea ~115) y Dropi YA
    // aceptó el cambio. Si RLS con sbUser bloquea, queda Dropi actualizado y
    // DB local desincronizado — bug peor que el riesgo de bypass.
    const { error: updateErr } = await sbAdmin
      .from("orders")
      .update({
        nombre: fullName,
        phone, ciudad, departamento, direccion,
        email: email || null,
        last_edit_sync_at: new Date().toISOString(),
        last_edited_by: user.id,
      })
      .eq("id", orderRow.id);

    if (updateErr) {
      return new Response(JSON.stringify({
        ok: false, dropiAccepted: true, dbError: updateErr.message,
        error: `Dropi aceptó el cambio pero la base de datos lo rechazó: ${updateErr.message}`,
      }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const auditPayload = {
      antes: { nombre: orderRow.nombre, phone: orderRow.phone, ciudad: orderRow.ciudad, departamento: orderRow.departamento, direccion: orderRow.direccion, email: orderRow.email },
      despues: { nombre: fullName, phone, ciudad, departamento, direccion, email: email || null },
    };

    const { error: auditErr } = await sbAdmin.from("order_results").insert({
      order_id: orderRow.id,
      phone: phone || orderRow.phone || "",
      operator_id: user.id,
      module: "confirmar",
      result: "edicion_orden",
      reason: JSON.stringify(auditPayload).slice(0, 2000),
      store_id: storeId,
    });
    if (auditErr) console.error("[dropi-update-order-full] audit insert failed:", auditErr);

    return new Response(
      JSON.stringify({ ok: true, externalId, dropiHttpStatus: dropi.httpStatus }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("dropi-update-order-full error:", err);
    const msg = err instanceof Error ? err.message : "Error interno";
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

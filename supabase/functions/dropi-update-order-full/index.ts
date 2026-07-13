// Edge Function: dropi-update-order-full
//
// Update editable customer fields on a Dropi order (multi-tenant: resolves
// store from the order's external_id, uses that store's API key + país host).
//
// Contrato de errores (mismo patrón que dropi-change-carrier): los errores de
// DOMINIO (rechazo de Dropi, pedido no encontrado, tienda sin api key, fallo
// del UPDATE local con dropiAccepted) responden HTTP 200 con {ok:false, code?,
// error, ...} — con non-2xx, supabase-js v2 deja data=null y el motivo real
// quedaba enterrado en error.context (el cliente ahora también lo rescata vía
// parseInvoke, doble cobertura). Non-2xx queda SOLO para auth/CORS/malformed
// (401/403/400 tempranos).
//
// La auditoría en order_results ('edicion_orden') la inserta el CLIENTE
// (OrderEditorDialog) con dropi_sync_status 'pending'→'synced'/'failed' ANTES
// de saber el resultado — acá ya NO se inserta (evita fila duplicada y deja
// rastro también cuando Dropi rechaza o la red muere).

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
  // Errores de dominio: HTTP 200 con ok:false para que invoke() entregue el
  // body en `data` (con non-2xx llega data=null y el motivo real se pierde).
  const jsonOk = (payload: Record<string, unknown>) =>
    new Response(JSON.stringify(payload), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
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
    if (orderErr || !orderRow) {
      return jsonOk({ ok: false, code: "not_found", error: `Pedido ${externalId} no encontrado` });
    }

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
    if (!cfg.apiKey) {
      return jsonOk({ ok: false, code: "no_api_key", error: "La tienda no tiene Clave API de Dropi configurada" });
    }

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
      return jsonOk({
        ok: false, code: "dropi_rejected", error: errorMsg,
        dropiHttpStatus: dropi.httpStatus, dropiBody: dropi.body,
      });
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
      // OJO: dropiAccepted:true — Dropi SÍ guardó los datos; lo que falló fue
      // la ficha local. El cliente bifurca el toast con este flag para no
      // hacer que la asesora re-dicte datos que ya están en Dropi.
      return jsonOk({
        ok: false, code: "db_update_failed", dropiAccepted: true, dbError: updateErr.message,
        error: `Dropi aceptó el cambio pero la base de datos lo rechazó: ${updateErr.message}`,
      });
    }

    // (El insert de auditoría 'edicion_orden' se movió al cliente — ver
    //  cabecera. Insertarlo también acá duplicaba la fila en cada edición.)

    return jsonOk({ ok: true, externalId, dropiHttpStatus: dropi.httpStatus });
  } catch (err) {
    console.error("dropi-update-order-full error:", err);
    const msg = err instanceof Error ? err.message : "Error interno";
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

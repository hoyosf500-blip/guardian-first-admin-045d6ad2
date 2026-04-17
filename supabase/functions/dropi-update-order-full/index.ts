// Edge Function: dropi-update-order-full
//
// Purpose
// -------
// Update editable customer fields (name, phone, address, city, state, email)
// on a Dropi order using the integration-key flow, then mirror the change
// back into our DB.
//
// Flow
// ----
// 1. Auth: validate the caller's JWT and get the user.id.
// 2. Ownership: assigned_to must equal the user, or the user must be admin.
// 3. Read Dropi integration key from app_settings.
// 4. PUT https://api.dropi.co/integrations/orders/myorders/{externalId}
//    with the customer payload (name, surname, phone, dir, city, state, email).
// 5. If Dropi 200, UPDATE orders SET <fields>, last_edit_sync_at, last_edited_by
//    using the user's JWT (so the protect_order_financial_fields trigger
//    sees auth.uid() correctly and validates ownership).
// 6. Insert an audit row in order_results with module='confirmar',
//    result='edicion_orden', reason=JSON{antes, despues}.
// 7. If Dropi fails, do NOT touch the DB; return error detail to frontend
//    so the operator knows which field Dropi rejected.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const DROPI_BASE = "https://api.dropi.co";
const DEFAULT_STORE_URL = "https://rushmira.com/";

// deno-lint-ignore no-explicit-any
type SB = any;

interface EditPayload {
  externalId: string;
  nombre?: string;       // can include "Nombre Apellido" combined
  apellido?: string;
  phone?: string;
  ciudad?: string;
  departamento?: string;
  direccion?: string;
  email?: string;
}

async function getConfig(sb: SB): Promise<{ apiKey: string; storeUrl: string }> {
  const { data, error } = await sb
    .from("app_settings")
    .select("key, value")
    .in("key", ["dropi_api_key", "dropi_store_url"]);

  if (error) {
    throw new Error(`No se pudo leer app_settings: ${error.message}`);
  }
  const map = new Map<string, string>();
  // deno-lint-ignore no-explicit-any
  (data || []).forEach((row: any) => map.set(String(row.key), String(row.value || "")));
  const apiKey = map.get("dropi_api_key") || Deno.env.get("DROPI_API_KEY") || "";
  const storeUrl = map.get("dropi_store_url") || DEFAULT_STORE_URL;
  return { apiKey, storeUrl };
}

function sanitizePhone(p: string): string {
  return (p || "").replace(/\D/g, "");
}

function isValidEmail(e: string): boolean {
  if (!e) return true; // empty is allowed
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

interface DropiResult {
  ok: boolean;
  httpStatus: number;
  body: Record<string, unknown>;
  rawText: string;
}

async function dropiPutCustomer(
  apiKey: string,
  storeUrl: string,
  externalId: string,
  payload: Record<string, unknown>,
): Promise<DropiResult> {
  const res = await fetch(
    `${DROPI_BASE}/integrations/orders/myorders/${encodeURIComponent(externalId)}`,
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
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ---- Auth ----
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "No autorizado" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;

    // sbAdmin: for reads (app_settings) and audit log inserts
    const sbAdmin = createClient(supabaseUrl, serviceKey);
    // sbUser: passes user JWT so the protect_order_financial_fields trigger
    // runs under auth.uid() and enforces ownership column-level rules.
    const sbUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: authError } = await sbUser.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (authError || !userData?.user) {
      return new Response(JSON.stringify({ error: "Token inválido" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const user = userData.user;

    // ---- Parse body ----
    let body: EditPayload;
    try { body = await req.json() as EditPayload; } catch {
      return new Response(JSON.stringify({ error: "Body inválido" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const externalId = String(body.externalId || "").trim();
    if (!externalId) {
      return new Response(JSON.stringify({ error: "Falta externalId" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const nombre = String(body.nombre || "").trim();
    const apellido = String(body.apellido || "").trim();
    const phone = sanitizePhone(String(body.phone || ""));
    const ciudad = String(body.ciudad || "").trim();
    const departamento = String(body.departamento || "").trim();
    const direccion = String(body.direccion || "").trim();
    const email = String(body.email || "").trim();

    // Validation
    if (!nombre) return jsonErr("Nombre obligatorio", 400);
    if (!direccion) return jsonErr("Dirección obligatoria", 400);
    if (!ciudad) return jsonErr("Ciudad obligatoria", 400);
    if (!departamento) return jsonErr("Departamento obligatorio", 400);
    if (phone && (phone.length < 7 || phone.length > 15)) {
      return jsonErr("Teléfono inválido (7-15 dígitos)", 400);
    }
    if (email && !isValidEmail(email)) return jsonErr("Email inválido", 400);

    // ---- Load order (admin client to bypass RLS for ownership check) ----
    const { data: orderRow, error: orderErr } = await sbAdmin
      .from("orders")
      .select("id, assigned_to, nombre, phone, ciudad, departamento, direccion, email, external_id")
      .eq("external_id", externalId)
      .maybeSingle();

    if (orderErr || !orderRow) {
      return jsonErr(`Pedido ${externalId} no encontrado`, 404);
    }

    // Ownership check removido (cola libre). El lock de orders + claim_order
    // ya garantiza que solo una operadora edita a la vez.

    // ---- Combined name handling ----
    // Dropi expects name + surname; our DB stores a single nombre column.
    // We always send "nombre apellido" combined to Dropi, and store the
    // combined value in our DB.
    const fullName = apellido ? `${nombre} ${apellido}`.trim() : nombre;

    // ---- Skip if nothing changed ----
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

    // ---- Load Dropi config ----
    const { apiKey, storeUrl } = await getConfig(sbAdmin);
    if (!apiKey) {
      return jsonErr("Clave API de Dropi no configurada", 400);
    }

    // ---- Build Dropi payload (omit empty optional fields) ----
    const dropiPayload: Record<string, unknown> = {
      name: nombre,
      surname: apellido || "",
      dir: direccion,
      city: ciudad,
      state: departamento,
    };
    if (phone) dropiPayload.phone = phone;
    if (email) dropiPayload.email = email;

    // ---- PUT to Dropi ----
    const dropi = await dropiPutCustomer(apiKey, storeUrl, externalId, dropiPayload);

    if (!dropi.ok) {
      const detail = String(
        dropi.body.message || dropi.body.error || dropi.rawText || "error",
      ).slice(0, 500);
      const errorMsg = `Dropi rechazó el cambio [${dropi.httpStatus}]: ${detail}`;

      await sbAdmin.from("sync_logs").insert({
        source: "dropi-update-order-full",
        status: "error",
        synced_count: 0,
        duplicates_count: 0,
        total_count: 1,
        triggered_by: user.id,
        error_message: errorMsg,
      });

      return new Response(
        JSON.stringify({
          ok: false,
          error: errorMsg,
          dropiHttpStatus: dropi.httpStatus,
          dropiBody: dropi.body,
        }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ---- Mirror to DB using user JWT (trigger validates ownership) ----
    const { error: updateErr } = await sbUser
      .from("orders")
      .update({
        nombre: fullName,
        phone,
        ciudad,
        departamento,
        direccion,
        email: email || null,
        last_edit_sync_at: new Date().toISOString(),
        last_edited_by: user.id,
      })
      .eq("id", orderRow.id);

    if (updateErr) {
      // Dropi accepted but DB rejected (likely RLS/trigger). Return warning
      // so the operator knows the source of truth diverged.
      return new Response(
        JSON.stringify({
          ok: false,
          dropiAccepted: true,
          dbError: updateErr.message,
          error: `Dropi aceptó el cambio pero la base de datos lo rechazó: ${updateErr.message}`,
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ---- Audit log via order_results ----
    // Uses sbAdmin (service role) so RLS doesn't block; we still set
    // operator_id to the real user so dashboards attribute correctly.
    // Logs the failure if any so we don't silently lose audit rows
    // (the previous version swallowed errors and made it look like the
    // edit happened with no trail).
    const auditPayload = {
      antes: {
        nombre: orderRow.nombre,
        phone: orderRow.phone,
        ciudad: orderRow.ciudad,
        departamento: orderRow.departamento,
        direccion: orderRow.direccion,
        email: orderRow.email,
      },
      despues: {
        nombre: fullName,
        phone,
        ciudad,
        departamento,
        direccion,
        email: email || null,
      },
    };

    const { error: auditErr } = await sbAdmin.from("order_results").insert({
      order_id: orderRow.id,
      phone: phone || orderRow.phone || "",
      operator_id: user.id,
      module: "confirmar",
      result: "edicion_orden",
      reason: JSON.stringify(auditPayload).slice(0, 2000),
    });

    if (auditErr) {
      // Don't fail the whole request — Dropi + DB already succeeded.
      // Just surface the error so we can see it in function logs.
      console.error("[dropi-update-order-full] audit insert failed:", auditErr);
    }

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

function jsonErr(error: string, status: number) {
  return new Response(JSON.stringify({ ok: false, error }), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

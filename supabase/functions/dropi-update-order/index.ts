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

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const DROPI_BASE = "https://api.dropi.co";
const DEFAULT_NEW_STATUS = "PENDIENTE";
const DEFAULT_STORE_URL = "https://rushmira.com/";

// Only these statuses can be pushed to Dropi via this endpoint. This prevents
// an operator from sending arbitrary strings (e.g. "CANCELADO") through the
// integration key. Add new values here as new flows are implemented.
const ALLOWED_STATUSES = ["PENDIENTE", "GUIA_GENERADA", "CONFIRMADO"];

// deno-lint-ignore no-explicit-any
type SB = any;

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
  (data || []).forEach((row: any) =>
    map.set(String(row.key), String(row.value || "")),
  );

  const apiKey = map.get("dropi_api_key") || Deno.env.get("DROPI_API_KEY") || "";
  const storeUrl = map.get("dropi_store_url") || DEFAULT_STORE_URL;

  return { apiKey, storeUrl };
}

interface DropiResult {
  ok: boolean;
  httpStatus: number;
  body: Record<string, unknown>;
  rawText: string;
}

async function dropiPutOrder(
  apiKey: string,
  storeUrl: string,
  externalId: string,
  newStatus: string,
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

async function dropiSanityCheck(
  apiKey: string,
  storeUrl: string,
): Promise<{ ok: boolean; httpStatus: number; message?: string }> {
  // Lightweight GET against the integrations listing endpoint to verify the
  // key is still valid and Dropi is reachable. This is what dropi-sync uses
  // so we know it works.
  const url =
    `${DROPI_BASE}/integrations/orders/myorders?result_number=1&start=0` +
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
  const message = ok
    ? "Conexión OK"
    : String(body.message || `HTTP ${res.status}`);

  return { ok, httpStatus: res.status, message };
}

Deno.serve(async (req: Request) => {
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

    const anonKey =
      Deno.env.get("SUPABASE_ANON_KEY") ||
      Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
    const anonClient = createClient(supabaseUrl, anonKey);
    const {
      data: { user },
      error: authError,
    } = await anonClient.auth.getUser(authHeader.replace("Bearer ", ""));
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Token inválido" }), {
        status: 401,
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

    // ---- Verify the order exists in our DB (ownership check) ----
    if (!dryRun) {
      const { data: orderRow } = await sb
        .from("orders")
        .select("id")
        .eq("external_id", externalId)
        .maybeSingle();
      if (!orderRow) {
        return new Response(
          JSON.stringify({ error: `Pedido ${externalId} no encontrado en la base de datos` }),
          {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
    }

    // ---- Load config (integration-key + store URL) ----
    const { apiKey, storeUrl } = await getConfig(sb);
    if (!apiKey) {
      return new Response(
        JSON.stringify({
          error:
            "Clave API de Dropi no configurada. Configúrala en Admin → Clave API de Dropi.",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // ---- DryRun: just a sanity GET so the admin can verify connectivity ----
    if (dryRun) {
      const check = await dropiSanityCheck(apiKey, storeUrl);
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
    const res = await dropiPutOrder(apiKey, storeUrl, externalId, newStatus);

    if (!res.ok) {
      const errorMsg = `Dropi PUT [${res.httpStatus}]: ${String(
        res.body.message || res.body.error || res.rawText || "error",
      ).slice(0, 500)}`;

      await sb.from("sync_logs").insert({
        source: "dropi-update-order",
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
          externalId,
          dropiHttpStatus: res.httpStatus,
        }),
        {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // ---- Success ----
    await sb.from("sync_logs").insert({
      source: "dropi-update-order",
      status: "success",
      synced_count: 1,
      duplicates_count: 0,
      total_count: 1,
      triggered_by: user.id,
    });

    return new Response(
      JSON.stringify({
        ok: true,
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

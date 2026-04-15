// Edge Function: dropi-update-order
//
// Purpose
// -------
// Update an order's status in Dropi via the official Bearer-token flow documented
// in the Dropi integration PDF (login email+password+white_brand_id → Bearer token,
// then PUT /api/orders/myorders/{id} with { "status": NEW_STATUS }).
//
// This function is ADDITIVE. It coexists with the existing `dropi-sync` /
// `dropi-cron` functions which use the integration-key flow for read-only sync.
//
// Invocation
// ----------
// From the frontend (authenticated user):
//   supabase.functions.invoke('dropi-update-order', {
//     body: { externalId: '<dropi order id>' }         // real PUT
//   })
//   supabase.functions.invoke('dropi-update-order', {
//     body: { dryRun: true }                            // login test only
//   })
//   supabase.functions.invoke('dropi-update-order', {
//     body: { externalId: '...', status: 'GUIA_GENERADA' }  // override status
//   })
//
// The default new status is "PENDIENTE" (to move an order from PENDIENTE
// CONFIRMACION → PENDIENTE when the operator confirms the call).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const DROPI_PROD = "https://api.dropi.co";
const DROPI_TEST = "https://test-api.dropi.co";
const WHITE_BRAND_DEFAULT =
  "df3e6b0bb66ceaadca4f84cbc371fd66e04d20fe51fc414da8d1b84d31d178de";
const DEFAULT_NEW_STATUS = "PENDIENTE";

interface DropiSettings {
  email: string;
  password: string;
  whiteBrandId: string;
  token: string;
  tokenAt: string;
  ttlMin: number;
  env: "prod" | "test";
}

// deno-lint-ignore no-explicit-any
type SB = any;

async function loadSettings(sb: SB): Promise<DropiSettings> {
  const keys = [
    "dropi_email",
    "dropi_password",
    "dropi_white_brand_id",
    "dropi_token",
    "dropi_token_at",
    "dropi_token_ttl_min",
    "dropi_env",
  ];
  const { data, error } = await sb
    .from("app_settings")
    .select("key, value")
    .in("key", keys);

  if (error) throw new Error(`No se pudo leer app_settings: ${error.message}`);

  const map = new Map<string, string>();
  // deno-lint-ignore no-explicit-any
  (data || []).forEach((row: any) =>
    map.set(String(row.key), String(row.value || ""))
  );

  // Fallback to env vars for secrets, keeping the same pattern as dropi-sync.
  const email = map.get("dropi_email") || Deno.env.get("DROPI_EMAIL") || "";
  const password =
    map.get("dropi_password") || Deno.env.get("DROPI_PASSWORD") || "";
  const whiteBrandId =
    map.get("dropi_white_brand_id") ||
    Deno.env.get("DROPI_WHITE_BRAND_ID") ||
    WHITE_BRAND_DEFAULT;
  const token = map.get("dropi_token") || "";
  const tokenAt = map.get("dropi_token_at") || "";
  const ttlMinStr = map.get("dropi_token_ttl_min") || "25";
  const ttlMin = Math.max(1, parseInt(ttlMinStr, 10) || 25);
  const envRaw = (map.get("dropi_env") || "prod").toLowerCase();
  const env: "prod" | "test" = envRaw === "test" ? "test" : "prod";

  return { email, password, whiteBrandId, token, tokenAt, ttlMin, env };
}

function baseUrl(env: "prod" | "test"): string {
  return env === "test" ? DROPI_TEST : DROPI_PROD;
}

function tokenIsFresh(tokenAt: string, ttlMin: number): boolean {
  if (!tokenAt) return false;
  const t = new Date(tokenAt).getTime();
  if (isNaN(t)) return false;
  const elapsedMin = (Date.now() - t) / 60000;
  return elapsedMin < ttlMin;
}

async function login(settings: DropiSettings): Promise<string> {
  if (!settings.email || !settings.password) {
    throw new Error(
      "Credenciales Dropi Bearer no configuradas (email/password).",
    );
  }

  const res = await fetch(`${baseUrl(settings.env)}/api/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      email: settings.email,
      password: settings.password,
      white_brand_id: settings.whiteBrandId || WHITE_BRAND_DEFAULT,
    }),
  });

  const raw = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = { raw };
  }

  if (!res.ok) {
    throw new Error(
      `Dropi login [${res.status}]: ${String(body.message || body.error || raw || "error desconocido")}`,
    );
  }

  // The Dropi PDF documents that login returns a top-level `token` field,
  // but some deployments wrap it under `data` or `objects`. Try all.
  const token =
    (body.token as string) ||
    ((body.data as Record<string, unknown> | undefined)?.token as string) ||
    ((body.objects as Record<string, unknown> | undefined)?.token as string) ||
    "";

  if (!token) {
    throw new Error(
      `Dropi login OK pero sin token en la respuesta: ${raw.slice(0, 300)}`,
    );
  }
  return token;
}

async function persistToken(sb: SB, token: string): Promise<string> {
  const tokenAt = new Date().toISOString();
  const { error } = await sb
    .from("app_settings")
    .upsert(
      [
        { key: "dropi_token", value: token },
        { key: "dropi_token_at", value: tokenAt },
      ],
      { onConflict: "key" },
    );
  if (error) {
    // Non-fatal: we still return the token in memory for this invocation.
    console.error("persistToken error:", error.message);
  }
  return tokenAt;
}

interface PutResult {
  ok: boolean;
  httpStatus: number;
  body: Record<string, unknown>;
  expired: boolean;
  rawText: string;
}

async function putOrderStatus(
  base: string,
  externalId: string,
  token: string,
  newStatus: string,
): Promise<PutResult> {
  const res = await fetch(
    `${base}/api/orders/myorders/${encodeURIComponent(externalId)}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
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

  const expired =
    res.status === 401 ||
    String(body.message || "")
      .toLowerCase()
      .includes("token is expired");

  const ok = res.ok && body.isSuccess !== false;

  return { ok, httpStatus: res.status, body, expired, rawText };
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
    const newStatus =
      typeof body.status === "string" && body.status.trim()
        ? body.status.trim()
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

    // ---- Load settings ----
    const settings = await loadSettings(sb);
    if (!settings.email || !settings.password) {
      return new Response(
        JSON.stringify({
          error:
            "Credenciales Dropi Bearer no configuradas. Configúralas en Admin → Credenciales Dropi (flujo Bearer).",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const base = baseUrl(settings.env);

    // ---- DryRun: just login and persist token ----
    if (dryRun) {
      const token = await login(settings);
      const tokenAt = await persistToken(sb, token);
      return new Response(
        JSON.stringify({
          ok: true,
          dryRun: true,
          env: settings.env,
          tokenAt,
          ttlMin: settings.ttlMin,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // ---- Resolve a valid token: use cache if fresh, otherwise login ----
    let token = settings.token;
    if (!token || !tokenIsFresh(settings.tokenAt, settings.ttlMin)) {
      token = await login(settings);
      await persistToken(sb, token);
    }

    // ---- PUT order status ----
    let res = await putOrderStatus(base, externalId, token, newStatus);

    // ---- Reactive refresh if token expired (one retry only) ----
    if (res.expired) {
      token = await login(settings);
      await persistToken(sb, token);
      res = await putOrderStatus(base, externalId, token, newStatus);
    }

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

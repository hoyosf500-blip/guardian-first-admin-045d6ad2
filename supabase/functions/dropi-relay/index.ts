// dropi-relay: HTTP proxy autenticado a la API de Dropi.
// Permite que un sistema externo (otro proyecto Lovable/Supabase) ejecute
// requests a Dropi desde la IP fija de ESTE proyecto, evitando el "Access denied"
// por whitelist de IP en los JWT de Rushmira.
//
// NO almacena tokens ni datos. Solo proxea HTTP.
//
// Endpoints:
//   GET  /health      → { ok: true, ts }
//   GET  /egress-ip   → IP pública de salida (vista por Dropi)
//   POST /            → Proxy a Dropi (requiere x-relay-secret)

import { getCorsHeaders } from "../_shared/cors.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";


const DROPI_HOSTS: Record<string, string> = {
  CO: "https://api.dropi.co",
  MX: "https://api.dropi.mx",
  EC: "https://api.dropi.ec",
  CL: "https://api.dropi.cl",
  PE: "https://api.dropi.pe",
  PA: "https://api.dropi.pa",
  AR: "https://api.dropi.ar",
  GT: "https://api.dropi.gt",
  PY: "https://api.dropi.com.py",
  VE: "https://api.dropi.com.ve",
  BO: "https://api.dropi.bo",
  CR: "https://api.dropi.cr",
  ES: "https://dropipro.com",
};

function json(body: unknown, status = 200, corsHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function decodeJwtClaims(token: string): Record<string, unknown> | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const jsonStr = atob(padded);
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  // Path puede venir como /dropi-relay, /dropi-relay/health, /dropi-relay/egress-ip
  const subpath = url.pathname.replace(/^.*\/dropi-relay/, "") || "/";

  // M1: /health y /egress-ip ahora exigen el mismo x-relay-secret que
  // el POST de proxy. Antes /egress-ip exponía la IP de salida del
  // function (la que Dropi tiene whitelisted) sin auth, lo que ayudaba
  // a un atacante a mapear infraestructura.
  const expectedSecret = Deno.env.get("RELAY_SHARED_SECRET");
  const providedSecret = req.headers.get("x-relay-secret");
  const secretOk = !!expectedSecret && providedSecret === expectedSecret;

  // ---- GET /health ----
  if (req.method === "GET" && subpath === "/health") {
    if (!secretOk) {
      return json({ ok: false, error: "Unauthorized" }, 401, corsHeaders);
    }
    return json({ ok: true, ts: new Date().toISOString() }, 200, corsHeaders);
  }

  // ---- GET /egress-ip ----
  if (req.method === "GET" && subpath === "/egress-ip") {
    if (!secretOk) {
      return json({ ok: false, error: "Unauthorized" }, 401, corsHeaders);
    }
    try {
      const r = await fetch("https://api.ipify.org?format=json");
      const data = await r.json();
      return json({ ok: true, ...data, ts: new Date().toISOString() }, 200, corsHeaders);
    } catch (err) {
      return json({ ok: false, error: err instanceof Error ? err.message : "ipify failed" }, 500, corsHeaders);
    }
  }

  // ---- POST / (proxy a Dropi) ----
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed. Use POST or GET /health|/egress-ip" }, 405, corsHeaders);
  }

  // 1) Validar shared secret
  const expected = Deno.env.get("RELAY_SHARED_SECRET");
  if (!expected) {
    return json({ ok: false, error: "Relay no configurado: falta RELAY_SHARED_SECRET" }, 500, corsHeaders);
  }
  const provided = req.headers.get("x-relay-secret");
  if (!provided || provided !== expected) {
    return json({ ok: false, error: "Unauthorized: x-relay-secret invalido o ausente" }, 401, corsHeaders);
  }

  // 2) Parse body
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Body JSON invalido" }, 400, corsHeaders);
  }

  const dropiToken = String(body.dropi_token || "").trim();
  const country = String(body.country || "CO").toUpperCase();
  const endpoint = String(body.endpoint || "orders/myorders").replace(/^\/+/, "");
  const page = Math.max(1, Number(body.page) || 1);
  const pageSize = Math.max(1, Math.min(500, Number(body.page_size) || 100));
  const dateFrom = body.date_from ? String(body.date_from) : "";
  const dateTo = body.date_to ? String(body.date_to) : "";

  if (!dropiToken) {
    return json({ ok: false, error: "Falta dropi_token" }, 400, corsHeaders);
  }

  const base = DROPI_HOSTS[country];
  if (!base) {
    return json({ ok: false, error: `Pais no soportado: ${country}. Validos: ${Object.keys(DROPI_HOSTS).join(", ")}` }, 400, corsHeaders);
  }

  // 2.5) Validar que el dropi_token corresponda al token autorizado en app_settings
  try {
    const sb = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );
    const { data: keySetting } = await sb
      .from("app_settings")
      .select("value")
      .eq("key", "dropi_api_key")
      .maybeSingle();
    if (!keySetting || keySetting.value !== dropiToken) {
      return json({ ok: false, error: "Token Dropi no autorizado" }, 403, corsHeaders);
    }
  } catch (err) {
    console.error("[dropi-relay] token validation failed", err);
    return json({ ok: false, error: "No se pudo validar el token" }, 500, corsHeaders);
  }

  // 3) Diagnostics: parse JWT claims (NO log del token completo)
  const claims = decodeJwtClaims(dropiToken);
  const iss = claims?.iss as string | undefined;
  const integrationUrl = (claims?.integration_url as string | undefined) || "";
  const ipUrl = claims?.ip_url as string | string[] | undefined;
  const aud = claims?.aud as string | undefined;
  const integrationType = claims?.integration_type as string | undefined;

  // 4) Construir URL
  const params = new URLSearchParams({
    result_number: String(pageSize),
    start: String((page - 1) * pageSize),
    filter_date_by: "FECHA DE CREADO",
    orderBy: "id",
    orderDirection: "desc",
  });
  if (dateFrom) params.set("date_from", dateFrom);
  if (dateTo) params.set("date_to", dateTo);

  const requestedUrl = `${base}/integrations/${endpoint}?${params.toString()}`;

  // Origin/Referer: usar integration_url del JWT si viene, si no derivar del país
  const originHost = integrationUrl || `https://rushmira.com`;

  const t0 = Date.now();
  let egressIp = "";
  try {
    // Best-effort: obtener egress IP en paralelo (no bloquea si falla)
    fetch("https://api.ipify.org?format=json")
      .then((r) => r.json())
      .then((d) => { egressIp = String(d.ip || ""); })
      .catch(() => {});
  } catch { /* ignore */ }

  console.log("[dropi-relay] REQ", {
    country,
    endpoint,
    page,
    pageSize,
    dateFrom,
    dateTo,
    iss,
    aud,
    integrationType,
    integrationUrl,
    ipUrl,
    requestedUrl,
  });

  try {
    const dropiRes = await fetch(requestedUrl, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "dropi-integration-key": dropiToken,
        "Origin": originHost,
        "Referer": originHost.endsWith("/") ? originHost : `${originHost}/`,
      },
    });

    const status = dropiRes.status;
    const text = await dropiRes.text();
    const duration = Date.now() - t0;
    let data: unknown = null;
    try { data = JSON.parse(text); } catch { data = text; }

    console.log("[dropi-relay] RES", {
      status,
      duration_ms: duration,
      length: text.length,
      preview: text.slice(0, 200),
    });

    const ok = dropiRes.ok && (typeof data === "object" && data !== null && (data as Record<string, unknown>).isSuccess !== false);

    return json({
      ok,
      status,
      data,
      diagnostics: {
        egress_ip: egressIp,
        requested_url: requestedUrl,
        country,
        duration_ms: duration,
        jwt: { iss, aud, integration_type: integrationType, integration_url: integrationUrl, ip_url: ipUrl },
      },
    }, ok ? 200 : 502, corsHeaders);
  } catch (err) {
    const duration = Date.now() - t0;
    console.error("[dropi-relay] ERR", err);
    return json({
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : "fetch failed",
      diagnostics: { egress_ip: egressIp, requested_url: requestedUrl, country, duration_ms: duration },
    }, 502, corsHeaders);
  }
});

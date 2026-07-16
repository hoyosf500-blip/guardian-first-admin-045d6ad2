// dropi-relay — proxy de EGRESS con IP FIJA para Guardian.
// ----------------------------------------------------------------------------
// Corre en el VPS Hostinger (srv1784684.hstgr.cloud, egress 2.25.69.238), detras
// de Caddy en https://srv1784684.hstgr.cloud/dropi/. Su unico proposito: que las
// llamadas a la API OFICIAL de Dropi (/integrations/*) salgan SIEMPRE desde la IP
// fija whitelisteada por Dropi, sin importar la IP dinamica de Supabase.
//
// NO confundir con supabase/functions/dropi-relay (ese es INBOUND: le presta la IP
// de Supabase a un tercero externo). Este es OUTBOUND para nuestras propias llamadas.
//
// Contrato:
//   GET  /health                      -> { ok, egress_ip, ts }   (publico)
//   POST /  (o cualquier path)        -> proxy. Requiere x-relay-secret.
//     body: { base?, endpoint, method?, query?, body?, token }
//       base    default https://api.dropi.co  (DEBE ser dominio de Dropi)
//       endpoint  ej "orders/myorders"  -> se antepone "/integrations/"
//       token   -> header dropi-integration-key
//   resp: { ok, status, data, target, duration_ms }
//
// NO guarda tokens: Guardian pasa el token en cada request. Auth = x-relay-secret.
//
// Endurecido 2026-07-16:
//   * allowlist de host destino (solo dominios de Dropi)  -> mata SSRF / proxy abierto
//   * timeout upstream (AbortController)                  -> no cuelga conexiones
//   * allowlist de metodo HTTP
//   * log estructurado (sin token ni secret)
//   * health cachea la IP de egress (no pega a ipify en cada request)
// ----------------------------------------------------------------------------

const SECRET = Deno.env.get("RELAY_SECRET") || "";
const PORT = Number(Deno.env.get("PORT") || "8081");
const UPSTREAM_TIMEOUT_MS = Number(Deno.env.get("UPSTREAM_TIMEOUT_MS") || "30000");
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

// Dropi es dueño de estos apex; cualquier subdominio (api., test-api., api-v2.,
// stg-api., etc.) es de fiar porque no puede ser registrado por un tercero.
const DROPI_APEX = [
  "dropi.co", "dropi.mx", "dropi.ec", "dropi.cl", "dropi.pe", "dropi.pa",
  "dropi.ar", "dropi.gt", "dropi.com.py", "dropi.com.ve", "dropi.bo", "dropi.cr",
  "dropipro.com",
];

function hostAllowed(base: string): boolean {
  let host: string;
  try {
    const u = new URL(base);
    if (u.protocol !== "https:") return false;
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  return DROPI_APEX.some((apex) => host === apex || host.endsWith("." + apex));
}

let cachedEgressIp = "";
async function egressIp(): Promise<string> {
  if (cachedEgressIp) return cachedEgressIp;
  try {
    const r = await fetch("https://api.ipify.org?format=json");
    const j = await r.json();
    cachedEgressIp = String(j.ip || "");
  } catch { /* ignore */ }
  return cachedEgressIp;
}
egressIp(); // calentar cache al arrancar

function log(o: Record<string, unknown>) {
  console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));
}

Deno.serve({ port: PORT, hostname: "0.0.0.0" }, async (req) => {
  const url = new URL(req.url);

  if (req.method === "GET" && url.pathname.endsWith("/health")) {
    return Response.json({ ok: true, service: "dropi-relay", egress_ip: await egressIp(), ts: new Date().toISOString() });
  }
  if (req.method !== "POST") {
    return Response.json({ ok: false, error: "POST only" }, { status: 405 });
  }

  // --- Auth ---
  const provided = req.headers.get("x-relay-secret") || url.searchParams.get("secret") || "";
  if (!SECRET || provided !== SECRET) {
    log({ evt: "auth_fail" });
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "bad json" }, { status: 400 });
  }

  const base = String(body.base || "https://api.dropi.co").replace(/\/+$/, "");
  const endpoint = String(body.endpoint || "").replace(/^\/+/, "");
  const method = String(body.method || "GET").toUpperCase();
  const token = String(body.token || "");
  const q = (body.query && typeof body.query === "object")
    ? "?" + new URLSearchParams(body.query as Record<string, string>).toString()
    : "";

  if (!ALLOWED_METHODS.has(method)) {
    return Response.json({ ok: false, error: "metodo no permitido" }, { status: 405 });
  }
  if (!hostAllowed(base)) {
    log({ evt: "base_blocked", base });
    return Response.json({ ok: false, error: "base no permitido (solo dominios de Dropi)" }, { status: 400 });
  }
  if (!token) return Response.json({ ok: false, error: "missing token" }, { status: 400 });
  if (!endpoint) return Response.json({ ok: false, error: "missing endpoint" }, { status: 400 });

  const target = base + "/integrations/" + endpoint + q;
  const targetHost = new URL(target).host;
  const headers: Record<string, string> = { "Accept": "application/json", "dropi-integration-key": token };
  let payload: string | undefined;
  if (body.body !== undefined && method !== "GET") {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body.body);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const r = await fetch(target, { method, headers, body: payload, signal: ctrl.signal });
    const text = await r.text();
    let data: unknown; try { data = JSON.parse(text); } catch { data = text; }
    const ms = Date.now() - t0;
    log({ evt: "proxy", method, host: targetHost, endpoint, status: r.status, ms });
    return Response.json({ ok: r.ok, status: r.status, data, target, duration_ms: ms });
  } catch (e) {
    const ms = Date.now() - t0;
    const aborted = (e as Error)?.name === "AbortError";
    log({ evt: aborted ? "timeout" : "error", method, host: targetHost, endpoint, ms });
    return Response.json(
      { ok: false, error: aborted ? "upstream timeout" : String(e), target },
      { status: aborted ? 504 : 502 },
    );
  } finally {
    clearTimeout(timer);
  }
});

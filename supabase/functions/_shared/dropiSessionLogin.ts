// Renovación automática del session token de Dropi (login del panel web).
//
// El `dropi_session_token` (JWT de app.dropi.*) vence ~24h. Históricamente se
// pegaba a mano en Admin → Credenciales; cuando vencía, cotizar/cambiar
// transportadora y el push de productos privados morían con 401.
//
// El flujo documentado es POST {base}/api/login con {email, password,
// white_brand_id} → { token } (a veces envuelto en data/objects — el PDF de
// Dropi documenta `token` top-level, pero hay deployments que lo anidan).
// OJO 2FA: si la cuenta tiene verificación en dos pasos, /api/login devuelve
// 403 y NO acepta el código TOTP (por eso el flujo Bearer se abandonó en
// 2026-04 para la cuenta CO). Es POR CUENTA: la cuenta EC no tiene 2FA
// (confirmado 2026-07-06), así que el auto-login sirve por tienda.
//
// Diseño defensivo:
//  - Si el token vigente aún no vence (exp del JWT con margen), se devuelve
//    tal cual — cero requests extra en el camino feliz.
//  - Si las columnas de login no existen (migración 20260706120000 sin
//    aplicar) o la tienda no configuró email/clave → devuelve el token actual
//    sin tirar: el flujo cae en el mensaje accionable de siempre.
//  - Si el login FALLA (403/2FA, clave mala), tira WebFallbackError con un
//    mensaje que dice exactamente qué hacer.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { WebFallbackError } from "./dropiWebQuote.ts";

/** Margen antes del vencimiento real para renovar (evita usar un token que
 *  muere en pleno flujo de cotización/creación). */
const EXP_SLACK_SECONDS = 120;

/** Decodifica el `exp` (epoch segundos) de un JWT sin verificar firma. */
function decodeJwtExp(token: string): number | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
    const payload = JSON.parse(atob(b64 + pad)) as { exp?: number };
    const exp = Number(payload?.exp || 0);
    return exp > 0 ? exp : null;
  } catch {
    return null;
  }
}

interface SessionCfg {
  storeId: string;
  base: string;
  sessionToken: string;
}

/**
 * Devuelve un session token utilizable para el panel web de Dropi.
 * Si el actual sigue vigente lo devuelve; si venció y la tienda tiene login
 * configurado, entra a Dropi, persiste el token nuevo en store_dropi_config
 * y lo devuelve. El caller debe asignarlo: `cfg.sessionToken = await ensure...`.
 *
 * `force: true` saltea el chequeo de vencimiento (para reintentos tras un 401
 * con token "vigente" — Dropi puede revocar tokens antes del exp).
 */
export async function ensureFreshSessionToken(
  // deno-lint-ignore no-explicit-any
  sbAdmin: SupabaseClient<any>,
  cfg: SessionCfg,
  opts?: { force?: boolean },
): Promise<string> {
  // Limpieza de comillas de paste (`"eyJ..."` da 401 — mismo guard que dropiWebFetch).
  const current = String(cfg.sessionToken || "").replace(/^"+|"+$/g, "");

  if (!opts?.force && current) {
    const exp = decodeJwtExp(current);
    const now = Math.floor(Date.now() / 1000);
    // Vigente con margen → usar el actual. Token no-JWT (exp indescifrable):
    // no sabemos el vencimiento, dejamos que el endpoint decida.
    if (exp === null || exp - now > EXP_SLACK_SECONDS) return current;
  }

  // Credenciales de login — query aparte y tolerante: si las columnas no
  // existen todavía (migración sin aplicar) degradamos a "sin auto-login".
  let email = "";
  let password = "";
  let whiteBrandId = 1;
  try {
    const { data, error } = await sbAdmin
      .from("store_dropi_config")
      .select("dropi_login_email, dropi_login_password, dropi_white_brand_id")
      .eq("store_id", cfg.storeId)
      .maybeSingle();
    if (error || !data) return current;
    email = String(data.dropi_login_email || "").trim();
    password = String(data.dropi_login_password || "");
    whiteBrandId = Number(data.dropi_white_brand_id ?? 1) || 1;
  } catch {
    return current;
  }
  if (!email || !password) return current;

  // El login pasa por el mismo WAF que el resto de /api/* → firma de navegador
  // (User-Agent + Origin/Referer de app.dropi.* + Sec-Fetch-*), verificada en
  // vivo 2026-07-01 para getOriginCity/cotiza.
  const appOrigin = cfg.base.replace("://api.", "://app.");
  const res = await fetch(`${cfg.base}/api/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/plain, */*",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
      "Origin": appOrigin,
      "Referer": `${appOrigin}/`,
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-site",
    },
    body: JSON.stringify({ email, password, white_brand_id: whiteBrandId }),
  });
  const raw = await res.text();
  // Nunca loguear password; el body de login trae el token → solo status/tamaño.
  console.log("[dropi-login]", { storeId: cfg.storeId, status: res.status, bodyLen: raw.length });

  // deno-lint-ignore no-explicit-any
  let body: any = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = { raw: raw.slice(0, 200) };
  }

  if (!res.ok || body?.isSuccess === false) {
    const msg = String(body?.message || body?.error || raw || "error").slice(0, 200);
    throw new WebFallbackError(
      `El login automático de Dropi falló [${res.status}]: ${msg}. ` +
        `Si la cuenta tiene verificación en dos pasos (2FA), Dropi bloquea este login — ` +
        `desactivá el 2FA de esa cuenta o pegá un token fresco en Admin → Credenciales Dropi.`,
      422,
    );
  }

  const token = String(
    body?.token || body?.data?.token || body?.objects?.token || "",
  ).trim();
  if (!token) {
    throw new WebFallbackError(
      `Dropi respondió al login sin token (revisá email/clave en Admin → Credenciales Dropi).`,
      422,
    );
  }

  // Persistir para que TODAS las funciones (y el panel de Admin) vean el token
  // nuevo. Best-effort: si falla el update igual devolvemos el token para que
  // ESTE request salga adelante.
  const { error: updErr } = await sbAdmin
    .from("store_dropi_config")
    .update({
      dropi_session_token: token,
      dropi_session_refreshed_at: new Date().toISOString(),
    })
    .eq("store_id", cfg.storeId);
  if (updErr) console.error("[dropi-login] no pude persistir el token nuevo:", updErr.message);

  return token;
}

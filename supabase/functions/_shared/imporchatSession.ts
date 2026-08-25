// Renovación automática de la llave de ImporChat — el fix de raíz del
// vencimiento de 7 días.
//
// ── El problema ────────────────────────────────────────────────────────────
// `store_importchat_config.session_token` es un JWT del panel web que vence a
// los 7 días. Guardian lo usa para TODO lo de ImporChat: leer la conversación,
// el sync que predice cancelaciones, y escribirle al cliente. Cuando muere, se
// apaga todo a la vez — y sin aviso. Medido el 25-ago-2026: le quedaban 3 días
// 15 h, y NADA lo renovaba. Era una bomba de tiempo.
//
// ── La solución, verificada en vivo ────────────────────────────────────────
// ImporChat tiene un endpoint que renueva la llave A PARTIR DE LA LLAVE ACTUAL,
// sin pedir contraseña:
//     GET {base}/auth/renew   con  Authorization: Bearer <llave actual>
//     → { status:"success", token:"<llave nueva de 7 días>", exp:<epoch seg> }
// Probado el 25-ago-2026 contra la cuenta viva: devolvió una llave fresca con
// exp a +7 días. Es una rotación de refresh-token: mientras se renueve ANTES de
// que venza, la llave no muere nunca y no hay que guardar ninguna contraseña.
//
// El `importchat-sync` (cron cada 30 min) llama a esto al ARRANQUE de cada
// corrida. Con 30 min de cadencia y 7 días de vida, el margen es enorme: aunque
// fallen muchas corridas seguidas, sobra tiempo. Y va primero, antes del paso
// del XLSX que a veces muere por memoria — así una corrida que después se cae
// igual ya dejó la llave renovada.
//
// Molde de `dropiSessionLogin.ts`, pero más simple: Dropi necesita email+clave
// (y choca con 2FA); ImporChat se renueva con la propia llave.

// ⛔ Sin imports por URL a propósito: este archivo lo cruza `src/lib` para las
// pruebas, y el `tsc` de la app sigue el re-export y typechequea lo que
// importe. Un `import ... from "https://esm.sh/..."` acá rompe el build con
// TS2307 (le pasó a imporchatSocket.ts). Por eso el cliente de Supabase se
// tipa con la FORMA mínima que se usa, no con su tipo real.
interface DbActualizable {
  from(tabla: string): {
    update(valores: Record<string, unknown>): {
      eq(col: string, val: string): Promise<unknown> | { then?: unknown };
    };
  };
}

/** Cuántas horas ANTES del vencimiento se renueva. 7 días de vida y sync cada
 *  30 min hacen que 48 h de margen sean de sobra para reintentar si algo falla
 *  transitoriamente. */
export const MARGEN_RENOVACION_HORAS = 48;

export const IMPORCHAT_BASE_DEFAULT = "https://chat.imporfactory.app/api/v1";

/** Decodifica el `exp` (epoch segundos) de un JWT sin verificar firma. */
export function decodeJwtExp(token: string): number | null {
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

/**
 * ¿Hay que renovar la llave? Puro y testeable — es la regla que decide, sacada
 * aparte para poder probarla sin red.
 *
 * Se renueva si vence dentro del margen. Un `expSeg` nulo (llave sin exp
 * legible) se trata como "sí, renovar": mejor pedir una fresca que arriesgarse
 * a usar una muerta.
 */
export function necesitaRenovar(
  expSeg: number | null,
  ahoraMs: number,
  margenHoras: number = MARGEN_RENOVACION_HORAS,
): boolean {
  if (expSeg == null) return true;
  const margenMs = margenHoras * 3600_000;
  return expSeg * 1000 - ahoraMs < margenMs;
}

/** El endpoint de renovación a partir del `api_base` de la tienda. */
function urlRenovar(base: string): string {
  const limpio = (base || IMPORCHAT_BASE_DEFAULT).replace(/\/+$/, "");
  return `${limpio}/auth/renew`;
}

interface ResultadoRenovacion {
  token: string;
  /** exp en epoch segundos, si vino. */
  expSeg: number | null;
}

/**
 * Pide una llave nueva a partir de la actual. `null` si no se pudo (red,
 * llave ya muerta, respuesta rara): el llamador sigue con la llave que tenía,
 * que es lo mejor que hay.
 */
export async function renovarTokenImporchat(
  base: string,
  tokenActual: string,
): Promise<ResultadoRenovacion | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15_000);
    const r = await fetch(urlRenovar(base), {
      method: "GET",
      headers: { Authorization: `Bearer ${tokenActual}` },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!r.ok) return null;
    const j = await r.json().catch(() => null) as
      | { status?: string; token?: string; exp?: number }
      | null;
    const nuevo = String(j?.token || "");
    if (!nuevo || j?.status !== "success") return null;
    // exp preferido del cuerpo; si no vino, del propio JWT.
    const expSeg = Number(j?.exp) > 0 ? Number(j!.exp) : decodeJwtExp(nuevo);
    return { token: nuevo, expSeg };
  } catch {
    return null;
  }
}

export interface ImporchatCfg {
  storeId: string;
  base: string;
  sessionToken: string;
  /** ISO de vencimiento guardado, o null. */
  tokenExpiraAt: string | null;
}

/**
 * Devuelve una llave de ImporChat vigente, renovándola si está por vencer y
 * persistiendo la nueva en `store_importchat_config`. El llamador asigna el
 * resultado: `cfg.sessionToken = await ensureFreshImporchatToken(sb, cfg)`.
 *
 * En el camino feliz (llave lejos de vencer) NO toca la red: devuelve la que
 * ya tenía. Si la renovación falla, devuelve la actual —nunca tira— para que
 * la corrida siga con lo que hay en vez de romperse por un fallo transitorio.
 *
 * `force: true` renueva sin mirar el vencimiento (para reintentar tras un 401
 * con una llave "vigente" que el servidor ya revocó).
 */
export async function ensureFreshImporchatToken(
  sb: DbActualizable,
  cfg: ImporchatCfg,
  opts: { force?: boolean } = {},
): Promise<string> {
  const expSeg = cfg.tokenExpiraAt
    ? Math.floor(new Date(cfg.tokenExpiraAt).getTime() / 1000)
    : decodeJwtExp(cfg.sessionToken);

  if (!opts.force && !necesitaRenovar(expSeg, Date.now())) {
    return cfg.sessionToken;
  }

  const fresco = await renovarTokenImporchat(cfg.base, cfg.sessionToken);
  if (!fresco) return cfg.sessionToken;

  const expIso = fresco.expSeg ? new Date(fresco.expSeg * 1000).toISOString() : null;
  await sb.from("store_importchat_config")
    .update({ session_token: fresco.token, token_expira_at: expIso })
    .eq("store_id", cfg.storeId);

  return fresco.token;
}

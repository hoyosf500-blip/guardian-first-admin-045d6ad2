// Fuente ÚNICA de "¿este pedido está VIVO en Dropi?" — por el canal WEB
// (session token), NUNCA por la API de integración.
//
// POR QUÉ EXISTE (incidente 2026-07-13, Fausto Cepeda #6101142/#6107398):
// los pedidos clase-bot (LucidBot / compras "reenviadas a dropiX") dan 404 en
// /integrations AUNQUE ESTÉN VIVOS en el panel. `guardReplacedOldOrder` usaba
// ese 404 como prueba de muerte ("clase bot benigno") y una hermana VIVA
// (#6107398, PENDIENTE CONFIRMACION) quedó activa en Dropi mientras Guardian
// reportaba éxito → riesgo real de doble envío. El 404 de integración NO es
// evidencia de nada para esta clase de pedidos.
//
// DISEÑO (calibrado con el incidente + gotchas documentados):
//  * `textToSearch` del listado web NO busca por external_id (verificado
//    2026-05, paridad mayo EC) → NUNCA inferir "muerto" por ausencia en el
//    listado. La señal primaria es el DETALLE v2, que responde también para
//    pedidos borrados (dropiCancelOrder.ts) pero con su status real
//    (REEMPLAZADA/CANCELADO = el soft-delete ES el cambio de status).
//  * Sesgo conservador: falso "sigue vivo" → warning + intento de cancelación
//    + humano revisa (barato). Falso "muerto" → duplicado silencioso + doble
//    envío (carísimo). Ante la duda: 'unknown', JAMÁS 'dead'.
//
// El caller es responsable de tener cfg.sessionToken FRESCO
// (ensureFreshSessionToken) — acá no se renueva nada.

import { dropiWebFetch } from "./dropiWebQuote.ts";

export interface LivenessCfg {
  base: string;
  sessionToken: string;
  apiKey: string;
  storeUrl: string;
}

/** Estados terminales/soft-delete de Dropi: la orden NO va a despacharse. */
export const DEAD_STATUS_RE = /CANCELAD|REEMPLAZAD|RECHAZAD/i;

export interface Liveness {
  state: "alive" | "dead" | "unknown";
  /** Status crudo de Dropi si se pudo leer (p.ej. "PENDIENTE CONFIRMACION"). */
  estado: string | null;
  /** Qué señal decidió: detalle v2, listado web, o ninguna (unknown). */
  via: "v2" | "listing" | "none";
}

/** Deriva el host api-v2 desde el host de integraciones.
 *  "https://api.dropi.ec" → "https://api-v2.dropi.ec". */
function apiV2Host(base: string): string {
  if (/\/\/api-v2\./.test(base)) return base.replace(/\/+$/, "");
  return base.replace(/\/\/api\./, "//api-v2.").replace(/\/+$/, "");
}

/** GET del detalle v2 de un pedido (session token, X-Authorization). Responde
 *  también para pedidos borrados/soft-deleted — con su status real. */
export async function dropiGetOrderV2Detail(
  cfg: LivenessCfg,
  externalId: string,
): Promise<{ ok: boolean; httpStatus: number; body: Record<string, unknown> }> {
  const url = `${apiV2Host(cfg.base)}/orders/orders/${encodeURIComponent(externalId)}`;
  const token = String(cfg.sessionToken || cfg.apiKey || "").replace(/^"+|"+$/g, "");
  const headers: Record<string, string> = {
    "X-Authorization": "Bearer " + token,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
  if (cfg.storeUrl) headers["Origin"] = cfg.storeUrl;
  const res = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(30_000) });
  const rawText = await res.text();
  let body: Record<string, unknown> = {};
  try { body = rawText ? JSON.parse(rawText) : {}; } catch { body = { raw: rawText }; }
  const ok = res.ok && body.isSuccess !== false;
  return { ok, httpStatus: res.status, body };
}

/** Extrae el status del detalle v2 (data.status / objects.status / status). */
export function parseV2Status(body: Record<string, unknown>): string | null {
  const data = (body.data ?? body.objects ?? body) as Record<string, unknown>;
  const st = String(data?.status ?? "").trim().toUpperCase();
  return st || null;
}

/** ¿La orden está viva en Dropi? Ladder de 2 señales:
 *   1) Detalle v2 → status DEAD_STATUS_RE = dead; status vivo = alive.
 *   2) v2 sin respuesta útil → listado web por teléfono/nombre (si el caller
 *      pasó searchText): si el listado LO ENCUENTRA decide por su status.
 *      La AUSENCIA en el listado NO decide nada (textToSearch no busca por id).
 *   3) Nada respondió → 'unknown'. Nunca tira. */
export async function checkOrderLivenessWeb(
  cfg: LivenessCfg,
  externalId: string,
  opts?: { searchText?: string },
): Promise<Liveness> {
  // Señal 1: detalle v2.
  try {
    const v2 = await dropiGetOrderV2Detail(cfg, externalId);
    if (v2.ok) {
      const st = parseV2Status(v2.body);
      if (st) {
        return { state: DEAD_STATUS_RE.test(st) ? "dead" : "alive", estado: st, via: "v2" };
      }
    }
  } catch (e) {
    console.error("[dropiOrderLiveness] v2 check falló:", e);
  }
  // Señal 2: listado web (solo puede decidir si ENCUENTRA la orden).
  const search = String(opts?.searchText || "").trim();
  if (search.length >= 4) {
    try {
      const { status, body } = await dropiWebFetch(
        cfg,
        `/api/orders/myorders?result_number=15&start=0&textToSearch=${encodeURIComponent(search)}`,
        { method: "GET", logBody: false },
      );
      if (status >= 200 && status < 300) {
        // deno-lint-ignore no-explicit-any
        const objs: any[] = Array.isArray((body as Record<string, unknown>)?.objects)
          ? (body as { objects: unknown[] }).objects as any[]
          : [];
        const hit = objs.find((o) => String(o?.id) === externalId);
        if (hit) {
          const st = String(hit.status || "").trim().toUpperCase() || null;
          return {
            state: st && DEAD_STATUS_RE.test(st) ? "dead" : "alive",
            estado: st,
            via: "listing",
          };
        }
      }
    } catch (e) {
      console.error("[dropiOrderLiveness] listing check falló:", e);
    }
  }
  return { state: "unknown", estado: null, via: "none" };
}

export interface SiblingOrder {
  id: string;
  status: string;
  total: string;
  createdAt: string | null;
}

/** Órdenes ACTIVAS del mismo cliente en el listado web. Busca por TELÉFONO
 *  (últimos 9 dígitos — la llave anti-dup de todo el CRM) y, si el teléfono no
 *  matchea nada o es corto, cae al NOMBRE (comportamiento previo de
 *  findActiveSiblings). Excluye ids pedidos + estados muertos/terminales.
 *  Orden: id numérico DESC (la más nueva primero). Nunca tira. */
export async function listActiveOrdersByPhone(
  cfg: LivenessCfg,
  opts: { phone: string; fallbackName?: string; excludeIds?: string[] },
): Promise<SiblingOrder[]> {
  const exclude = new Set((opts.excludeIds || []).map((x) => String(x)));
  const digits = String(opts.phone || "").replace(/\D/g, "").slice(-9);
  const terms: string[] = [];
  if (digits.length >= 7) terms.push(digits);
  const name = String(opts.fallbackName || "").trim();
  if (name.length >= 4) terms.push(name);

  const seen = new Map<string, SiblingOrder>();
  for (const term of terms) {
    try {
      const { status, body } = await dropiWebFetch(
        cfg,
        `/api/orders/myorders?result_number=15&start=0&textToSearch=${encodeURIComponent(term)}`,
        { method: "GET", logBody: false },
      );
      if (status < 200 || status >= 300) continue;
      // deno-lint-ignore no-explicit-any
      const objs: any[] = Array.isArray((body as Record<string, unknown>)?.objects)
        ? (body as { objects: unknown[] }).objects as any[]
        : [];
      for (const o of objs) {
        const id = String(o?.id ?? "");
        if (!id || exclude.has(id) || seen.has(id)) continue;
        const st = String(o?.status || "");
        if (/CANCELAD|REEMPLAZAD|ENTREGAD|DEVOLUCION|DEVUELTO/i.test(st)) continue;
        seen.set(id, {
          id,
          status: st,
          total: String(o?.total_order ?? ""),
          createdAt: o?.created_at != null ? String(o.created_at) : null,
        });
      }
      // El teléfono matcheó → suficiente (no mezclar con homónimos por nombre).
      if (seen.size > 0) break;
    } catch (e) {
      console.error("[dropiOrderLiveness] listado de hermanas falló:", e);
    }
  }
  return [...seen.values()].sort((a, b) => Number(b.id) - Number(a.id));
}

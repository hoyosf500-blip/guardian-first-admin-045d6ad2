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

/** Extrae el status del detalle v2. OJO (verificado en vivo 2026-07-13): el
 *  detalle v2 de EC NO incluye `status` (keys: id, client, products,
 *  shop_order_id, ...) — casi siempre devuelve null. NO usar para liveness;
 *  queda por compatibilidad/por si otros países sí lo traen. */
export function parseV2Status(body: Record<string, unknown>): string | null {
  const data = (body.data ?? body.objects ?? body) as Record<string, unknown>;
  const st = String(data?.status ?? "").trim().toUpperCase();
  return st || null;
}

/** shop_order_id del detalle v2 — la llave EXACTA de "misma compra" entre un
 *  stub forwardeado y su hermana viva (verificado: stub #6110094 y viva
 *  #6111108 comparten shop_order_id 3708533). null si no se pudo leer. */
export async function getShopOrderIdV2(cfg: LivenessCfg, externalId: string): Promise<string | null> {
  try {
    const v2 = await dropiGetOrderV2Detail(cfg, externalId);
    if (!v2.ok) return null;
    const data = (v2.body.data ?? v2.body.objects ?? v2.body) as Record<string, unknown>;
    return data?.shop_order_id != null ? String(data.shop_order_id) : null;
  } catch {
    return null;
  }
}

const LISTING_PAGE_SIZE = 15;

/** ¿La orden está viva en Dropi? Señal ÚNICA confiable (calibrada en vivo
 *  2026-07-13): el LISTADO web buscado por el TELÉFONO del cliente.
 *   - La orden APARECE → decide su status.
 *   - NO aparece, el listado devolvió OTRAS órdenes del mismo cliente Y la
 *     página NO está llena (objs.length < LISTING_PAGE_SIZE) → 'dead': las
 *     REEMPLAZADA reciben deleted_at y desaparecen del listado (probado: el
 *     stub #6110807 no aparece mientras la viva #6110951 sí).
 *   - NO aparece pero la página vino LLENA (objs.length === LISTING_PAGE_SIZE) →
 *     'unknown': con >15 pedidos del cliente el target VIVO puede estar en la
 *     página 2 y no traerlo NO es prueba de muerte. Declarar 'dead' acá sería
 *     un falso muerto → REEMPLAZADA (pair-resolver) o cancel-retry falso
 *     mientras Dropi despacha. El sesgo del módulo es JAMÁS 'dead' con página
 *     posiblemente incompleta (guard de página-llena).
 *   - Listado vacío o falló → 'unknown' (JAMÁS asumir muerto sin evidencia).
 *  El detalle v2 NO sirve: responde para órdenes borradas y NO trae status.
 *  `phone` es OBLIGATORIO para decidir; sin él devuelve 'unknown'. Nunca tira. */
export async function checkOrderLivenessWeb(
  cfg: LivenessCfg,
  externalId: string,
  opts?: { phone?: string; fallbackName?: string },
): Promise<Liveness> {
  const terms: string[] = [];
  const digits = String(opts?.phone || "").replace(/\D/g, "").slice(-9);
  if (digits.length >= 7) terms.push(digits);
  const name = String(opts?.fallbackName || "").trim();
  if (name.length >= 4) terms.push(name);
  for (const term of terms) {
    try {
      const { status, body } = await dropiWebFetch(
        cfg,
        `/api/orders/myorders?result_number=${LISTING_PAGE_SIZE}&start=0&textToSearch=${encodeURIComponent(term)}`,
        { method: "GET", logBody: false },
      );
      if (status < 200 || status >= 300) continue;
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
      // Ausente con OTRAS órdenes del cliente presentes → soft-deleted, PERO
      // solo si la página NO está llena. Si vino con LISTING_PAGE_SIZE filas la
      // página puede estar truncada (>15 pedidos del cliente) y el target VIVO
      // caer en la 2da página → jamás 'dead' con página posiblemente incompleta.
      if (objs.length > 0 && objs.length < LISTING_PAGE_SIZE) {
        return { state: "dead", estado: null, via: "listing" };
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

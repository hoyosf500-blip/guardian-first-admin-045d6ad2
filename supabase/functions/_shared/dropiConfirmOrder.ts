// Confirmación/escritura de status por el canal WEB + retarget a la hermana
// viva — EXTRAÍDO de dropi-update-order (2026-07-13, probado en vivo:
// stub #6110807 → viva #6110951 → PENDIENTE ok) para que dropi-cron y
// dropi-update-order-full usen EXACTAMENTE el mismo rescate en vez de
// duplicar la lógica (o peor: quemar el cap BOT-SIN-API sin intentarlo).
//
// Piezas:
//  * webConfirmFallback  — PUT web de status + verificación por listado-teléfono
//  * resolveLiveSibling  — hermana viva inequívoca (listado + shop_order_id v2)
//  * retargetLocalOrder  — fila Guardian apunta a la viva (23505 → REEMPLAZADA)
//  * confirmLiveSibling  — composición de las tres, con sync_log warn
//
// El caller pasa `source` para que el sync_log diga QUIÉN rescató
// (dropi-update-order | dropi-cron | dropi-update-order-full).

import { ensureFreshSessionToken } from "./dropiSessionLogin.ts";
import { dropiWebFetch, WebFallbackError } from "./dropiWebQuote.ts";
import {
  checkOrderLivenessWeb,
  getShopOrderIdV2,
  listActiveOrdersByPhone,
  type SiblingOrder,
} from "./dropiOrderLiveness.ts";

export interface ConfirmCfg {
  base: string;
  sessionToken: string;
  apiKey: string;
  storeUrl: string;
}

/** Normaliza un status Dropi para comparar: mayúsculas, sin acentos,
 *  `_` → espacio, espacios colapsados ("GUIA_GENERADA" ≡ "GUIA GENERADA"). */
export function normalizeStatus(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Orden del funnel Dropi. Un status con rank MAYOR que el pedido en el PUT
// también cuenta como verificado (alguien/la transportadora lo movió adelante).
// CANCELADO/REEMPLAZADA van en -1: NO son "posterior del funnel" — si el GET
// los muestra tras un PUT ok, el cambio NO quedó aplicado como se pidió.
export const FUNNEL_RANK: Record<string, number> = {
  "CANCELADO": -1,
  "REEMPLAZADA": -1,
  "PENDIENTE CONFIRMACION": 0,
  "POR CONFIRMAR": 0,
  "PENDIENTE": 1,
  "CONFIRMADO": 2,
  "PREPARADO PARA TRANSPORTADORA": 3,
  "GUIA GENERADA": 4,
  "EN BODEGA TRANSPORTADORA": 5,
  "EN PROCESAMIENTO": 5,
  "EN RUTA": 6,
  "EN TRANSITO": 6,
  "EN REPARTO": 7,
  "INTENTO DE ENTREGA": 7,
  "NOVEDAD": 7,
  "REEXPEDICION": 7,
  "RECLAME EN OFICINA": 7,
  "EN OFICINA": 7,
  "ENTREGADO": 8,
  "EN DEVOLUCION": 8,
  "DEVOLUCION": 8,
  "DEVUELTO": 8,
};

/** FALLBACK WEB para confirmar pedidos clase-bot (2026-07-13): la API de
 *  integración no los ve ("No se encontró registro") pero el canal WEB del
 *  panel SÍ escribe las órdenes VIVAS — el mismo PUT /api/orders/myorders/{id}
 *  que usa la cancelación (verificado en vivo: #6110951 pasó a PENDIENTE con
 *  isSuccess:true). Tras el PUT, VERIFICA por el LISTADO buscado por teléfono
 *  (el detalle v2 NO trae status) que el status realmente avanzó. Nunca tira. */
export async function webConfirmFallback(
  cfg: ConfirmCfg,
  // deno-lint-ignore no-explicit-any
  sb: any,
  externalId: string,
  newStatus: string,
  phone: string,
): Promise<
  | { ok: true; verified: boolean; currentStatus: string | null; putStatus: number }
  | { ok: false; detail: string; putStatus: number; putBody?: unknown }
> {
  try {
    cfg.sessionToken = await ensureFreshSessionToken(sb, cfg);
  } catch (e) {
    const msg = e instanceof WebFallbackError ? e.message : (e instanceof Error ? e.message : String(e));
    return { ok: false, detail: `sin sesión web: ${msg}`.slice(0, 300), putStatus: 0 };
  }
  let putStatus = 0;
  let putBody: Record<string, unknown> | undefined;
  try {
    const put = await dropiWebFetch(
      cfg,
      `/api/orders/myorders/${encodeURIComponent(externalId)}`,
      { method: "PUT", body: { status: newStatus } },
    );
    putStatus = put.status;
    putBody = put.body as Record<string, unknown>;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, detail: `PUT web lanzó: ${msg}`.slice(0, 300), putStatus: 0 };
  }
  const putOk = putStatus >= 200 && putStatus < 300 && putBody?.isSuccess !== false;
  // Verificar por el listado-teléfono (el PUT web puede devolver 200 ignorando).
  let currentStatus: string | null = null;
  try {
    const live = await checkOrderLivenessWeb(cfg, externalId, { phone });
    if (live.via === "listing" && live.estado) currentStatus = live.estado;
  } catch (e) {
    console.error("[dropiConfirmOrder] verify listado del fallback web lanzó:", e);
  }
  if (currentStatus) {
    const rank = FUNNEL_RANK[normalizeStatus(currentStatus)];
    const target = FUNNEL_RANK[normalizeStatus(newStatus)];
    if (rank !== undefined && target !== undefined && rank >= target) {
      return { ok: true, verified: true, currentStatus, putStatus };
    }
    // Listado legible y el status NO avanzó → el PUT web no aplicó de verdad.
    return {
      ok: false,
      detail: `PUT web [${putStatus}] pero el status sigue ${currentStatus}`,
      putStatus,
      putBody,
    };
  }
  if (putOk) {
    // PUT aceptado sin verificación posible: no castigamos (criterio leniente
    // del verify de integración) pero queda verified:false y logueado.
    return { ok: true, verified: false, currentStatus: null, putStatus };
  }
  return {
    ok: false,
    detail: String(putBody?.message || putBody?.error || `PUT web falló [${putStatus}]`).slice(0, 300),
    putStatus,
    putBody,
  };
}

/** Hermana viva INEQUÍVOCA de un stub: listado por teléfono (excluye el stub),
 *  filtro opcional de status, y con 2+ candidatas desambiguación por
 *  shop_order_id (la llave exacta de "misma compra" — v2). null si no hay UNA
 *  sola. `statusFilter` default = estados de confirmación pendiente (el caso
 *  confirmar); para ediciones de datos pasar `null` (cualquier viva sirve,
 *  pero la desambiguación por shop_order_id sigue siendo obligatoria). */
export async function resolveLiveSibling(
  cfg: ConfirmCfg,
  opts: {
    stubId: string;
    phone: string;
    nombre: string;
    statusFilter?: RegExp | null;
  },
): Promise<SiblingOrder | null> {
  const { stubId, phone, nombre } = opts;
  const statusFilter = opts.statusFilter === undefined
    ? /PENDIENTE CONFIRMACION|POR CONFIRMAR/i
    : opts.statusFilter;
  let sibs: SiblingOrder[] = [];
  try {
    sibs = await listActiveOrdersByPhone(cfg, { phone, fallbackName: nombre, excludeIds: [stubId] });
  } catch {
    return null;
  }
  let candidates = statusFilter
    ? sibs.filter((s) => statusFilter.test(String(s.status || "")))
    : sibs;
  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    const stubShop = await getShopOrderIdV2(cfg, stubId);
    if (!stubShop) return null;
    const matched: typeof candidates = [];
    for (const c of candidates.slice(0, 4)) {
      const shop = await getShopOrderIdV2(cfg, c.id);
      if (shop && shop === stubShop) matched.push(c);
    }
    candidates = matched;
    if (candidates.length !== 1) return null;
    return candidates[0];
  }
  // Candidata ÚNICA: verificar igual el shop_order_id cuando sea legible —
  // "única viva del teléfono" NO implica "misma compra" (puede ser OTRA compra
  // del mismo cliente cuya hermana real ya salió del pool). Mismatch → null.
  // Ilegible: aceptable SOLO en el flujo confirmar (statusFilter estricto =
  // pool chico y es el comportamiento probado en vivo); para ediciones de
  // datos (statusFilter null = pool amplio) exigimos el match — escribir
  // datos sobre la compra equivocada es carísimo.
  const single = candidates[0];
  const stubShop = await getShopOrderIdV2(cfg, stubId);
  if (stubShop) {
    const shop = await getShopOrderIdV2(cfg, single.id);
    if (shop && shop !== stubShop) return null;
    if (!shop && !statusFilter) return null;
  } else if (!statusFilter) {
    return null;
  }
  return single;
}

/** Retarget de la fila Guardian: la card de la asesora pasa a apuntar a la
 *  orden viva (mismo patrón in-place del editor). Carrera 23505 (el cron ya
 *  importó la hermana como fila propia) → la fila stub queda REEMPLAZADA. */
export async function retargetLocalOrder(
  // deno-lint-ignore no-explicit-any
  sb: any,
  opts: { orderRowId: string; siblingId: string },
): Promise<"retargeted" | "replaced" | "failed"> {
  try {
    const { error: updErr } = await sb.from("orders")
      .update({ external_id: opts.siblingId })
      .eq("id", opts.orderRowId);
    if (!updErr) return "retargeted";
    if ((updErr as { code?: string }).code === "23505") {
      await sb.from("orders").update({ estado: "REEMPLAZADA" }).eq("id", opts.orderRowId);
      return "replaced";
    }
    console.error("[dropiConfirmOrder] retarget local falló:", updErr);
    return "failed";
  } catch (e) {
    console.error("[dropiConfirmOrder] retarget local lanzó:", e);
    return "failed";
  }
}

/** RETARGET A LA HERMANA VIVA (2026-07-13, caso Cristina/Luis): cuando el
 *  pedido de Guardian es el STUB de una compra que Dropi forwardeó, NINGÚN
 *  canal lo escribe (integración 404 + PUT web "Error SQL desconocido") — pero
 *  la orden VIVA de la MISMA compra (mismo shop_order_id, id más nuevo) SÍ
 *  acepta el PUT web (probado: stub #6110807 → viva #6110951 → PENDIENTE ok).
 *  Resuelve la hermana por listado-teléfono + match de shop_order_id (v2),
 *  la confirma, verifica, y retargetea la fila Guardian (external_id → viva).
 *  Devuelve null si no hay UNA hermana inequívoca. Nunca tira. */
export async function confirmLiveSibling(
  cfg: ConfirmCfg,
  // deno-lint-ignore no-explicit-any
  sb: any,
  opts: {
    stubId: string;
    newStatus: string;
    phone: string;
    nombre: string;
    orderRowId: string;
    storeId: string;
    source?: string;
  },
): Promise<{ siblingId: string; verified: boolean; retargeted: boolean } | null> {
  const { stubId, newStatus, phone, nombre, orderRowId, storeId } = opts;
  const source = opts.source || "dropi-update-order";
  const sibling = await resolveLiveSibling(cfg, { stubId, phone, nombre });
  if (!sibling) return null;
  // Confirmar la hermana viva por el canal web + verificar por listado.
  const web = await webConfirmFallback(cfg, sb, sibling.id, newStatus, phone);
  if (!web.ok) return null;
  const retarget = await retargetLocalOrder(sb, { orderRowId, siblingId: sibling.id });
  const retargeted = retarget === "retargeted";
  await sb.from("sync_logs").insert({
    source,
    status: "warn", synced_count: 1, duplicates_count: 0, total_count: 1,
    store_id: storeId,
    error_message: `Stub del bot #${stubId} sin superficie de escritura — la confirmación se aplicó a la orden VIVA de la misma compra #${sibling.id} (${web.verified ? "verificada" : "sin verificar"}); fila local ${retargeted ? "retargeteada" : "marcada REEMPLAZADA"}.`,
  });
  return { siblingId: sibling.id, verified: web.verified, retargeted };
}

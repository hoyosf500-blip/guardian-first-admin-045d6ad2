// Edge Function: dropi-change-carrier
//
// Permite a la operadora cambiar la transportadora de un pedido PENDIENTE desde
// Confirmar. Modos:
//   - mode "quote": cotiza en vivo (panel web Dropi) las transportadoras que
//     pueden despachar ese pedido + su precio. Devuelve tambiÃ©n la actual.
//   - mode "apply": reasigna la transportadora elegida en Dropi y sincroniza
//     orders.transportadora + orders.external_id local + deja auditorÃ­a.
//   - mode "cancel" (FASE 3): cancela DE VERDAD el pedido y mata el fantasma.
//     (a) Orden VIVA en Dropi â†’ PUT /api/orders/myorders/{id} {status:"CANCELADO",
//         reasonComment} (mismo request del "Cancelar orden" del panel) + marca
//         orders.estado='CANCELADO' local. Devuelve canceled:true.
//     (b) FANTASMA (el PUT falla y un GET de integraciÃ³n confirma que la orden YA NO
//         existe en Dropi â€” 404 "Orden no encontrada"): se cancela SOLO local. Estos
//         son pedidos borrados/reemplazados en Dropi que quedaron atascados PENDIENTE
//         en Guardian (que solo upsertea, nunca borra) y reaparecÃ­an al caducar el
//         overlay local a los 7 dÃ­as. Devuelve canceled:true + dropiMissing:true.
//     (c) Orden viva pero Dropi rechaza â†’ ok:false (el cliente reintenta, no esconde).
//     Antes (v1) el fantasma no morÃ­a: el PUT devolvÃ­a "Error SQL" porque la orden no
//     existÃ­a, y sin el check (b) el pedido quedaba atascado. Root cause hallado en la
//     verificaciÃ³n e2e 2026-07-08 (Manuel MacÃ­as 5524000 y dup 6004033 = 404 en Dropi).
//
// Auth: Authorization: Bearer <user_jwt> (debe ser miembro de la tienda).
//
// MECÃNICA REAL DEL CAMBIO (capturada del panel app.dropi.ec con clicks reales,
// 2026-07-01 y 2026-07-06): Dropi NO edita in-place â€” su propio panel avisa
// "La actualizaciÃ³n generarÃ¡ un nuevo ID de la orden" y dispara DOS requests:
//   1) POST /api/orders/myorders (token de SESIÃ“N web) con:
//        is_edit_order: true
//        id_old_order: <external_id viejo>
//        distributionCompany: { id, name }   // la transportadora ELEGIDA
//      Success â†’ { isSuccess:true, objects:{ id:<NUEVO external_id>, ... } }.
//   2) PUT /api/orders/myorders/<external_id viejo> con:
//        { status: "REEMPLAZADA", reasonComment: "CancelaciÃ³n por ediciÃ³n de orden", replaced: true }
//      â†’ la vieja queda REEMPLAZADA + deleted_at (soft-delete) y desaparece de
//      los listados. SIN ESTE PUT la vieja sigue PENDIENTE en Dropi y el cron la
//      re-importa a los 5 min â†’ duplicado en Dropi Y en el CRM (bug del 2026-07-06).
//
// Por eso cada recreate hace POST + markOldOrderReplaced() y, al Ã©xito, ACTUALIZA
// la fila local (external_id â†’ nuevo id, transportadora â†’ nuevo nombre) y audita
// el reemplazo. smartMerge dedup por dbId (UUID estable), asÃ­ que la MISMA fila
// fÃ­sica refleja el cambio en la UI.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { loadStoreConfig, isStoreMember } from "../_shared/dropiStoreConfig.ts";
import { ensureFreshSessionToken } from "../_shared/dropiSessionLogin.ts";
import {
  quoteCarriers,
  dropiWebFetch,
  decodeJwtSub,
  normUp,
  WebFallbackError,
  type QuoteLine,
} from "../_shared/dropiWebQuote.ts";
import { resolveDestCity, noCoverageMessage } from "../_shared/dropiCityCatalog.ts";
import { cancelOrderInDropi } from "../_shared/dropiCancelOrder.ts";
import {
  checkOrderLivenessWeb,
  listActiveOrdersByPhone,
  type SiblingOrder,
} from "../_shared/dropiOrderLiveness.ts";

interface ChangeCarrierBody {
  externalId?: string;
  mode?: "quote" | "apply" | "apply_value" | "apply_edit" | "cancel" | "debug";
  /** mode "cancel": motivo de la cancelaciÃ³n (va en reasonComment del PUT a Dropi). */
  reason?: string;
  distributionCompanyId?: number | string;
  name?: string;
  /** modes "apply_value" / "apply_edit": nuevo valor a cobrar (COD) del pedido. */
  newValor?: number | string;
  /** mode "quote": override de lÃ­neas para re-cotizar con cantidades/precios editados. */
  lines?: Array<{ dropiId?: number | string; quantity?: number | string; price?: number | string }>;
  /** mode "apply_edit": lÃ­neas editadas (mismo set de dropiIds, sin agregar/quitar). */
  newLines?: Array<{ dropiId?: number | string; quantity?: number | string; price?: number | string }>;
}

/** QuoteLine + nombre del producto (para el editor unificado del CRM).
 *  Tipo LOCAL â€” no tocamos QuoteLine en _shared/dropiWebQuote.ts. */
interface LineDetail extends QuoteLine {
  name?: string;
}

/** Valida un override de lÃ­neas del cliente contra las lÃ­neas reales del pedido:
 *  mismo SET de dropiIds (sin agregar/quitar), cantidad entera 1-1000, precio â‰¥0.
 *  InvÃ¡lido â†’ null (el caller decide el fallback). Conserva el name original. */
function sanitizeLinesOverride(
  raw: ChangeCarrierBody["lines"],
  existing: LineDetail[],
): LineDetail[] | null {
  if (!Array.isArray(raw) || raw.length !== existing.length) return null;
  const byId = new Map(existing.map((l) => [l.dropiId, l]));
  const out: LineDetail[] = [];
  const seen = new Set<number>();
  for (const r of raw) {
    const id = Number(r?.dropiId);
    const orig = byId.get(id);
    if (!orig || seen.has(id)) return null;
    seen.add(id);
    const quantity = Number(r?.quantity);
    const price = Number(r?.price);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) return null;
    if (!Number.isFinite(price) || price < 0) return null;
    out.push({ ...orig, quantity, price });
  }
  return out;
}

interface DropiResult {
  ok: boolean;
  httpStatus: number;
  body: Record<string, unknown>;
  rawText: string;
}

/** Datos de cliente/pedido para reconstruir el body de creaciÃ³n (v2 o fallback DB). */
interface OrderClientFields {
  name: string;
  surname: string;
  dir: string;
  phone: string;
  state: string;
  city: string;
  email: string;
  notes: string;
  rateType: string;
  /** "Orden ID" interno de Dropi (data.shop_order_id) â€” distinto del external_id. */
  shopOrderId: string;
  /** shop_id del cliente (data.client.shop_id) si viene. */
  shopId: number | null;
}

/** GET de UN pedido por su id externo (integration-key) â†’ para leer orderdetails. */
async function dropiGetOrder(
  base: string,
  apiKey: string,
  storeUrl: string,
  externalId: string,
): Promise<DropiResult> {
  const res = await fetch(
    `${base}/integrations/orders/myorders/${encodeURIComponent(externalId)}`,
    {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "dropi-integration-key": apiKey,
        "Origin": storeUrl,
      },
    },
  );
  const rawText = await res.text();
  let body: Record<string, unknown> = {};
  try { body = rawText ? JSON.parse(rawText) : {}; } catch { body = { raw: rawText }; }
  const ok = res.ok && body.isSuccess !== false;
  return { ok, httpStatus: res.status, body, rawText };
}

/** PUT del total del pedido vÃ­a integration-key. OJO: el PUT de Dropi IGNORA EN
 *  SILENCIO los campos que no soporta (devuelve 200 sin cambiar nada â€” verificado
 *  con distribution_company_id), asÃ­ que NUNCA confiar en el 200: verificar con
 *  un GET posterior (parseOrderTotal). */
async function dropiPutTotal(
  base: string,
  apiKey: string,
  storeUrl: string,
  externalId: string,
  newTotal: number,
): Promise<DropiResult> {
  const res = await fetch(
    `${base}/integrations/orders/myorders/${encodeURIComponent(externalId)}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "dropi-integration-key": apiKey,
        "Origin": storeUrl,
      },
      body: JSON.stringify({ total_order: newTotal }),
    },
  );
  const rawText = await res.text();
  let body: Record<string, unknown> = {};
  try { body = rawText ? JSON.parse(rawText) : {}; } catch { body = { raw: rawText }; }
  const ok = res.ok && body.isSuccess !== false;
  return { ok, httpStatus: res.status, body, rawText };
}

/** Extrae total_order del cuerpo de un pedido Dropi (integration GET). */
function parseOrderTotal(body: Record<string, unknown>): number | null {
  const order = (body.objects ?? body.data ?? body.order ?? body) as Record<string, unknown>;
  const t = parseFloat(String(order?.total_order ?? ""));
  return Number.isFinite(t) ? t : null;
}

/** Redondeo por paÃ­s: EC usa centavos (USD), CO pesos enteros. */
function roundMoney(n: number, countryCode: string): number {
  const f = countryCode === "EC" ? 100 : 1;
  return Math.round(n * f) / f;
}

/** Escala los precios de lÃ­nea para que acompaÃ±en el valor nuevo del pedido.
 *  `total_order` es la verdad del recaudo (puede diferir por centavos de la
 *  suma de lÃ­neas â€” el create ya lo permitÃ­a), esto solo mantiene coherencia
 *  visual/contable en el panel de Dropi. */
function scaleLinePrices(lines: QuoteLine[], newTotal: number, countryCode: string): QuoteLine[] {
  const oldSum = lines.reduce((s, l) => s + l.price * l.quantity, 0);
  if (oldSum > 0) {
    const factor = newTotal / oldSum;
    return lines.map((l) => ({ ...l, price: roundMoney(l.price * factor, countryCode) }));
  }
  // Sin precios previos: repartir el total entre las unidades.
  const units = lines.reduce((s, l) => s + (l.quantity || 1), 0) || 1;
  const perUnit = roundMoney(newTotal / units, countryCode);
  return lines.map((l) => ({ ...l, price: perUnit }));
}

/** Paridad con el panel Dropi (request capturado en vivo 2026-07-06): tras el
 *  POST create-with-edit, el panel manda este PUT que deja la orden VIEJA con
 *  status=REEMPLAZADA + deleted_at (soft-delete) â†’ desaparece de los listados y
 *  el cron ya no puede re-importarla como duplicado. NUNCA tira: si falla, la
 *  orden nueva ya existe y el caller degrada a warning (la vieja queda activa). */
async function markOldOrderReplaced(
  cfg: Parameters<typeof dropiWebFetch>[0],
  oldId: string,
): Promise<{ ok: boolean; status: number; detail: string }> {
  try {
    const { status, body } = await dropiWebFetch(
      cfg,
      `/api/orders/myorders/${encodeURIComponent(oldId)}`,
      {
        method: "PUT",
        body: { status: "REEMPLAZADA", reasonComment: "CancelaciÃ³n por ediciÃ³n de orden", replaced: true },
      },
    );
    const ok = status >= 200 && status < 300 && body?.isSuccess !== false;
    return { ok, status, detail: ok ? "" : String(body?.message || body?.error || "").slice(0, 300) };
  } catch (e) {
    return { ok: false, status: 0, detail: e instanceof Error ? e.message.slice(0, 300) : "error" };
  }
}

/** Control de daÃ±os tras un create-with-edit. SIEMPRE siembra la FILA-TUMBA
 *  local con el external_id viejo (estado REEMPLAZADA) â€” tambiÃ©n cuando el PUT
 *  REEMPLAZADA fue ok: un ciclo de cron EN VUELO (que ya paginÃ³ la lista vieja
 *  antes del PUT) puede re-upsertear el id viejo como fila PENDIENTE nueva, y
 *  la tumba (UNIQUE external_id) lo absorbe.
 *
 *  VERIFICACIÃ“N (reescrita 2026-07-13, incidente Fausto #6101142): SIEMPRE se
 *  verifica el estado real de la orden vieja por el canal WEB
 *  (checkOrderLivenessWeb: detalle v2, NO integraciÃ³n) â€” tambiÃ©n cuando el PUT
 *  dijo ok, porque Dropi devuelve 200 ignorando PUTs en silencio. 3 estados:
 *    (a) 'dead' (v2 dice CANCELADO/REEMPLAZADA/RECHAZADO) â†’ benigno;
 *    (b) 'alive' â†’ REINTENTAR el PUT una vez + re-verificar; si sigue viva â†’
 *        oldAlive (riesgo REAL de doble envÃ­o) + sync_log ERROR + order_results
 *        'failed' (panel de fallos);
 *    (c) 'unknown' â†’ warning honesto "no pude verificar".
 *  El 404 de integraciÃ³n YA NO es evidencia: los pedidos clase-bot dan 404 ahÃ­
 *  AUNQUE ESTÃ‰N VIVOS en el panel (la suposiciÃ³n "clase bot â†’ el create-with-edit
 *  ya la cancela server-side" dejÃ³ viva la hermana #6107398 el 2026-07-13).
 *  LLAMAR DESPUÃ‰S del update local (la fila propia ya no ocupa el external_id
 *  viejo). Nunca tira. */
async function guardReplacedOldOrder(
  cfg: { base: string; sessionToken: string; apiKey: string; storeUrl: string },
  // deno-lint-ignore no-explicit-any
  sbAdmin: any,
  opts: {
    replaced: { ok: boolean; status: number; detail: string };
    externalId: string;
    newId: string;
    rowId: string;
    storeId: string;
    userId: string;
    /** TelÃ©fono de la fila (order_results.phone es NOT NULL). */
    phone: string;
    /** true si queda presupuesto de wall-clock para el reintento del PUT. */
    budgetLeft?: () => boolean;
  },
): Promise<{ warning?: string; oldAlive?: { externalId: string; estado: string } }> {
  const { replaced, externalId, newId, rowId, storeId, userId, phone } = opts;
  const budgetLeft = opts.budgetLeft ?? (() => true);

  // FILA-TUMBA anti-reimport: copia de la fila propia (que ya apunta al id nuevo)
  // con el external_id VIEJO y estado REEMPLAZADA. Si el cron vuelve a listar el
  // id viejo, su upsert cae sobre esta fila (UNIQUE external_id) y la resucita
  // VISIBLEMENTE en vez de crear una fila PENDIENTE duplicada. Si nunca vuelve,
  // queda REEMPLAZADA (excluida de colas y mÃ©tricas â€” PR #111). Corre SIEMPRE,
  // tambiÃ©n con PUT ok (el cron en vuelo no se entera del soft-delete de Dropi).
  try {
    const { data: fullRow } = await sbAdmin.from("orders").select("*").eq("id", rowId).maybeSingle();
    if (fullRow) {
      const tomb: Record<string, unknown> = { ...fullRow };
      delete tomb.id;
      delete tomb.created_at;
      tomb.external_id = externalId;
      tomb.estado = "REEMPLAZADA";
      const { error: tombErr } = await sbAdmin.from("orders").insert(tomb);
      if (tombErr && (tombErr as { code?: string }).code === "23505") {
        // El id viejo ya estÃ¡ ocupado (cron re-importÃ³ en la ventana, o el update
        // local fallÃ³ y la fila propia aÃºn lo tiene â€” .neq la protege). Marcar
        // REEMPLAZADA: si Dropi de verdad la lista viva, el cron la resucita solo.
        await sbAdmin.from("orders").update({ estado: "REEMPLAZADA" })
          .eq("external_id", externalId).eq("store_id", storeId).neq("id", rowId);
      } else if (tombErr) {
        console.error("[guardReplacedOldOrder] tumba no insertada:", tombErr);
      }
    }
  } catch (e) {
    console.error("[guardReplacedOldOrder] tumba fallÃ³:", e);
  }

  // VerificaciÃ³n SIEMPRE (tambiÃ©n con PUT ok â€” Dropi devuelve 200 ignorando
  // PUTs en silencio; nunca creer el 200 sin mirar el estado real). La seÃ±al
  // es el listado web por TELÃ‰FONO (v2 no trae status â€” verificado 2026-07-13).
  let liveness = await checkOrderLivenessWeb(cfg, externalId, { phone });

  // Sigue viva â†’ reintentar el PUT REEMPLAZADA una vez y re-verificar (si
  // queda presupuesto de wall-clock; la respuesta SIEMPRE tiene que salir).
  let retried = false;
  if (liveness.state === "alive" && budgetLeft()) {
    retried = true;
    const retry = await markOldOrderReplaced(cfg, externalId);
    if (retry.ok || budgetLeft()) {
      liveness = await checkOrderLivenessWeb(cfg, externalId, { phone });
    }
  }

  if (liveness.state === "dead" && replaced.ok) return {};

  let warning: string | undefined;
  let oldAlive: { externalId: string; estado: string } | undefined;
  let logMsg: string;
  let logStatus = "warn";
  const putTxt = replaced.ok
    ? `PUT REEMPLAZADA respondiÃ³ ok [${replaced.status}]`
    : `PUT REEMPLAZADA fallÃ³ [${replaced.status}]: ${replaced.detail}`;
  if (liveness.state === "alive") {
    oldAlive = { externalId, estado: liveness.estado || "ACTIVA" };
    warning = `DUPLICADO VIVO en Dropi: la orden vieja #${externalId} sigue ACTIVA (${liveness.estado || "?"}) tras crear #${newId} â€” cancelala YA para evitar doble envÃ­o.`;
    logMsg = `Orden vieja ${externalId} SIGUE ACTIVA (${liveness.estado || "?"}, vÃ­a ${liveness.via}) en Dropi tras crear ${newId}; ${putTxt}${retried ? " â€” reintento del PUT tampoco la matÃ³" : ""}. Tumba local creada.`;
    logStatus = "error";
  } else if (liveness.state === "unknown") {
    if (!replaced.ok) {
      warning = `No pude verificar si la orden vieja #${externalId} quedÃ³ fuera de Dropi â€” revisala en el panel (riesgo de doble envÃ­o si sigue activa).`;
      logMsg = `${putTxt} para la orden vieja ${externalId} tras crear ${newId} â€” y la verificaciÃ³n web (v2) no dio respuesta clara: estado DESCONOCIDO, revisar en el panel. Tumba local creada.`;
    } else {
      // PUT ok + verificaciÃ³n sin seÃ±al: probablemente bien; log suave, sin warning.
      logMsg = `${putTxt} para la orden vieja ${externalId} tras crear ${newId}; la verificaciÃ³n web (v2) no respondiÃ³ â€” asumo ok por el PUT, tumba local creada.`;
    }
  } else {
    // dead verificado pero el PUT habÃ­a fallado (p.ej. clase bot: el
    // create-with-edit la matÃ³ server-side y el PUT posterior dio error SQL).
    logMsg = `PUT REEMPLAZADA fallÃ³ para la orden vieja ${externalId} tras crear ${newId} [${replaced.status}]: ${replaced.detail} â€” pero la verificaciÃ³n web (v2) confirma que quedÃ³ ${liveness.estado || "MUERTA"} en Dropi. Benigno. Tumba local creada.`;
  }

  await sbAdmin.from("sync_logs").insert({
    source: "dropi-change-carrier",
    status: logStatus, synced_count: 0, duplicates_count: 0, total_count: 1,
    triggered_by: userId,
    error_message: logMsg,
    store_id: storeId,
  });

  // Warning PERSISTENTE en order_results (panel de fallos): el toast del cliente
  // muere solo; esto queda. SOLO en los caminos con warning del guard.
  if (warning) {
    try {
      const { error: persistErr } = await sbAdmin.from("order_results").insert({
        order_id: rowId,
        store_id: storeId,
        operator_id: userId,
        phone,
        result: "edicion_orden",
        dropi_sync_status: "failed",
        result_notes: ("EDICIÃ“N: " + warning).slice(0, 300),
      });
      if (persistErr) console.error("[guardReplacedOldOrder] warning persistente no insertado:", persistErr);
    } catch (e) {
      console.error("[guardReplacedOldOrder] warning persistente fallÃ³:", e);
    }
  }

  return { warning, oldAlive };
}

/** BARRIDO POST-CREATE de hermanas vivas (incidente 2026-07-13: el forwarding
 *  interno de Dropi puede dejar una orden HERMANA viva de la misma compra â€”
 *  #6107398 quedÃ³ PENDIENTE CONFIRMACION mientras Guardian reportaba Ã©xito).
 *  Lista las Ã³rdenes activas del cliente (por telÃ©fono) excluyendo la nueva y
 *  la vieja. AUTO-MATA (PUT REEMPLAZADA + verificaciÃ³n) SOLO la clase
 *  forwarding inequÃ­voca: PENDIENTE CONFIRMACION *y* total idÃ©ntico al pedido
 *  editado (la hermana carga la MISMA compra â€” Fausto: los 3 con $31.98). Una
 *  recompra legÃ­tima del mismo cliente tambiÃ©n puede estar PENDIENTE
 *  CONFIRMACION, asÃ­ que sin match de total NO se toca: se devuelve como
 *  duplicado vivo para decisiÃ³n humana (tarjeta accionable del CRM). Nunca tira. */
async function sweepStraySiblings(
  cfg: { base: string; sessionToken: string; apiKey: string; storeUrl: string },
  // deno-lint-ignore no-explicit-any
  sbAdmin: any,
  opts: {
    phone: string;
    clientName: string;
    newId: string;
    oldId: string;
    storeId: string;
    /** Totales del pedido editado (viejo y nuevo) â€” llave de "misma compra". */
    knownTotals: number[];
    budgetLeft: () => boolean;
  },
): Promise<{ leftovers: Array<{ externalId: string; estado: string }>; skippedByBudget: boolean }> {
  const leftovers: Array<{ externalId: string; estado: string }> = [];
  if (!opts.budgetLeft()) return { leftovers, skippedByBudget: true };
  let sibs: SiblingOrder[] = [];
  try {
    sibs = await listActiveOrdersByPhone(cfg, {
      phone: opts.phone,
      fallbackName: opts.clientName,
      excludeIds: [opts.newId, opts.oldId],
    });
  } catch (e) {
    console.error("[sweepStraySiblings] listado fallÃ³:", e);
    return { leftovers, skippedByBudget: false };
  }
  const totalMatches = (sibTotal: string): boolean => {
    const t = parseFloat(sibTotal);
    if (!Number.isFinite(t)) return false;
    return opts.knownTotals.some((k) => Number.isFinite(k) && Math.abs(t - k) < 0.01);
  };
  for (const sib of sibs) {
    const st = String(sib.status || "").toUpperCase();
    if (/PENDIENTE CONFIRMACION|POR CONFIRMAR/.test(st) && totalMatches(sib.total) && opts.budgetLeft()) {
      // Clase forwarding: matarla con la misma mecÃ¡nica del panel + VERIFICAR.
      const killed = await markOldOrderReplaced(cfg, sib.id);
      const after = opts.budgetLeft()
        ? await checkOrderLivenessWeb(cfg, sib.id, { phone: opts.phone, fallbackName: opts.clientName })
        : { state: "unknown" as const, estado: null, via: "none" as const };
      if (killed.ok && after.state !== "alive") {
        // Best-effort: si Guardian ya tenÃ­a fila para la hermana, marcarla local.
        try {
          await sbAdmin.from("orders").update({ estado: "REEMPLAZADA" })
            .eq("external_id", sib.id).eq("store_id", opts.storeId);
        } catch { /* best-effort */ }
        console.log(`[sweepStraySiblings] hermana #${sib.id} (${st}) barrida (REEMPLAZADA) tras crear #${opts.newId}.`);
        continue;
      }
      leftovers.push({ externalId: sib.id, estado: after.estado || st });
    } else {
      leftovers.push({ externalId: sib.id, estado: st });
    }
  }
  return { leftovers, skippedByBudget: false };
}

/** RecuperaciÃ³n de un create-with-edit INCIERTO (aceptado sin id / POST que
 *  lanzÃ³ tras enviarse): busca en el listado web una orden nueva del cliente
 *  que solo puede ser la reciÃ©n creada â€” id numÃ©rico MAYOR al viejo y (si el
 *  listado trae created_at parseable) creada en los Ãºltimos 10 minutos, o con
 *  total â‰ˆ esperado como seÃ±al secundaria. EXACTAMENTE UN candidato â†’ se
 *  adopta y el pipeline sigue normal. 0 o 2+ â†’ null (el caller devuelve
 *  'creacion_incierta' y el cliente NO debe reintentar). Nunca tira. */
async function recoverUncertainCreate(
  cfg: { base: string; sessionToken: string; apiKey: string; storeUrl: string },
  // deno-lint-ignore no-explicit-any
  sbAdmin: any,
  opts: {
    phone: string;
    clientName: string;
    oldId: string;
    expectedTotal: number;
    storeId: string;
    userId: string;
    label: string;
  },
): Promise<{ newId: string } | null> {
  let sibs: SiblingOrder[] = [];
  try {
    sibs = await listActiveOrdersByPhone(cfg, {
      phone: opts.phone,
      fallbackName: opts.clientName,
      excludeIds: [opts.oldId],
    });
  } catch (e) {
    console.error("[recoverUncertainCreate] listado fallÃ³:", e);
    return null;
  }
  const oldNum = Number(opts.oldId);
  const candidates = sibs.filter((s) => {
    if (!(Number(s.id) > oldNum)) return false;
    // created_at del listado (si parsea): ventana de 10 min. OJO: Dropi devuelve
    // hora LOCAL del paÃ­s sin zona â€” comparar contra Date.now() directo darÃ­a
    // falsos negativos, asÃ­ que solo se usa como seÃ±al si parsea Y da >10min de
    // diferencia ABSOLUTA imposible (>24h) para descartar Ã³rdenes viejas.
    if (s.createdAt) {
      const t = Date.parse(s.createdAt);
      if (Number.isFinite(t) && Math.abs(Date.now() - t) > 24 * 3600_000) return false;
    }
    const tot = parseFloat(s.total);
    if (Number.isFinite(tot) && Number.isFinite(opts.expectedTotal) && opts.expectedTotal > 0) {
      return Math.abs(tot - opts.expectedTotal) < 0.01;
    }
    return true;
  });
  if (candidates.length !== 1) {
    console.log(`[recoverUncertainCreate] ${candidates.length} candidatos para el pedido viejo #${opts.oldId} â€” no adopto.`);
    return null;
  }
  const newId = candidates[0].id;
  await sbAdmin.from("sync_logs").insert({
    source: "dropi-change-carrier",
    status: "warn", synced_count: 0, duplicates_count: 0, total_count: 1,
    triggered_by: opts.userId,
    error_message: `${opts.label}: resultado incierto RECUPERADO â€” Dropi sÃ­ creÃ³ la orden #${newId} (pedido viejo #${opts.oldId}); el pipeline siguiÃ³ normal.`,
    store_id: opts.storeId,
  });
  return { newId };
}

/** Carrera 23505 con el cron tras un recreate: el sync ya insertÃ³ la orden
 *  NUEVA como fila propia y el UPDATE local (external_id â†’ nuevo id) chocÃ³ por
 *  UNIQUE. La fila vieja queda REEMPLAZADA (NO 'CANCELADO' â€” eso metÃ­a una
 *  cancelaciÃ³n FANTASMA en las mÃ©tricas: el pedido sigue vivo, solo cambiÃ³ de
 *  fila). AdemÃ¡s busca la fila NUEVA (external_id nuevo + store_id) para:
 *  (a) redirigir la auditorÃ­a de ediciÃ³n a su order_id (antes quedaba huÃ©rfana
 *  en la fila vieja) y (b) copiarle locked_by/locked_at de la vieja si los
 *  tenÃ­a (best-effort: la asesora no pierde el claim). Nunca tira. */
async function absorbCronDuplicate(
  // deno-lint-ignore no-explicit-any
  sbAdmin: any,
  opts: {
    newId: string;
    storeId: string;
    rowId: string;
    lockedBy?: string | null;
    lockedAt?: string | null;
  },
): Promise<{ warning: string; auditOrderId: string | null }> {
  const { newId, storeId, rowId, lockedBy, lockedAt } = opts;
  const { error: replErr } = await sbAdmin
    .from("orders")
    .update({ estado: "REEMPLAZADA" })
    .eq("id", rowId);
  const warning = replErr
    ? `El sync ya trajo la orden nueva ${newId} y no pude marcar la fila vieja como REEMPLAZADA: ${replErr.message}.`
    : `El sync ya habÃ­a traÃ­do la orden nueva ${newId}; la fila vieja quedÃ³ REEMPLAZADA.`;

  let auditOrderId: string | null = null;
  try {
    const { data: newRow } = await sbAdmin
      .from("orders")
      .select("id")
      .eq("external_id", newId)
      .eq("store_id", storeId)
      .maybeSingle();
    if (newRow?.id) {
      auditOrderId = String(newRow.id);
      if (lockedBy) {
        // Best-effort: conservar el claim de la asesora sobre la fila nueva.
        const { error: lockErr } = await sbAdmin
          .from("orders")
          .update({ locked_by: lockedBy, locked_at: lockedAt ?? new Date().toISOString() })
          .eq("id", newRow.id);
        if (lockErr) console.error("[absorbCronDuplicate] copia de lock fallÃ³:", lockErr);
      }
    }
  } catch (e) {
    console.error("[absorbCronDuplicate] lookup de la fila nueva fallÃ³:", e);
  }
  return { warning, auditOrderId };
}

/** Auto-retiro del stub del bot cuando Dropi bloquea con "ya fue enviada".
 *  REESCRITO 2026-07-13: el 404 de integraciÃ³n YA NO alcanza como evidencia â€”
 *  los pedidos clase-bot dan 404 en /integrations AUNQUE ESTÃ‰N VIVOS en el
 *  panel (asÃ­ se ocultÃ³ el duplicado vivo #6107398). Ahora se retira SOLO con
 *  evidencia POSITIVA doble: (1) checkOrderLivenessWeb (detalle v2) dice que
 *  ESTE pedido estÃ¡ muerto (CANCELADO/REEMPLAZADA/RECHAZADO), Y (2) existe al
 *  menos una hermana VIVA donde vive la compra real. 'unknown' o 'alive' â†’ NO
 *  toca nada (el pedido queda en la cola y la asesora ve el mensaje con la
 *  hermana activa). Nunca tira. */
async function retireBotStubIfGone(
  cfg: { base: string; sessionToken: string; apiKey: string; storeUrl: string },
  // deno-lint-ignore no-explicit-any
  sbAdmin: any,
  externalId: string,
  rowId: string,
  liveSiblingsCount: number,
  phone: string,
): Promise<boolean> {
  try {
    if (liveSiblingsCount < 1) return false;
    const liveness = await checkOrderLivenessWeb(cfg, externalId, { phone });
    if (liveness.state !== "dead") return false;
    const { error } = await sbAdmin
      .from("orders")
      .update({ estado: "REEMPLAZADA" })
      .eq("id", rowId);
    if (error) {
      console.error("[retireBotStubIfGone] update local fallÃ³:", error);
      return false;
    }
    console.log(`[retireBotStubIfGone] stub del bot #${externalId} verificado ${liveness.estado || "MUERTO"} en Dropi (v2) â€” retirado de la cola (REEMPLAZADA local).`);
    return true;
  } catch (e) {
    console.error("[retireBotStubIfGone] check de existencia fallÃ³:", e);
    return false;
  }
}

/** Busca la transportadora elegida DENTRO de las opciones cotizadas (por id o
 *  nombre normalizado). Devuelve la opciÃ³n completa (con typeService y
 *  shippingAmount) o null si no cotiza esta ruta. Evita POSTear un create con
 *  una carrier sin cobertura â€” Dropi lo rechaza (a veces con mensaje claro tipo
 *  "La ciudad no tiene habilitado el mÃ©todo de envÃ­o", a veces con el genÃ©rico
 *  "Error al crear la orden"). Caso real: ECHEANDIA-BOLIVAR-LAARCOURIER 2026-07-09. */
function findQuotedOption(
  options: Array<{ id: number | string; name: string; typeService: string; shippingAmount: number }>,
  dcIdRaw: number | string | undefined,
  dcName: string,
): { id: number | string; name: string; typeService: string; shippingAmount: number } | null {
  const idNum = Number(dcIdRaw);
  const nameNorm = normUp(dcName);
  return (
    options.find((op) => Number(op.id) === idNum && Number.isFinite(idNum)) ??
    options.find((op) => normUp(op.name) === nameNorm && nameNorm !== "") ??
    null
  );
}

/** POST del create-with-edit con reintento defensivo para pedidos "de bot"
 *  (LucidBot/FINAL_ORDER de otra shop): si el primer POST falla y el body
 *  llevaba shop_order_id/shop_id (heredados del pedido viejo vÃ­a detalle v2),
 *  reintenta UNA vez sin ellos â€” el create web que SÃ funciona (shopify-push)
 *  nunca los manda, y Dropi rechaza con el genÃ©rico "Error al crear la orden"
 *  cuando el shop_order_id pertenece a otra integraciÃ³n (caso #6053027,
 *  LUCIDBOT-4783411). Loguea cada intento en sync_logs con el body de Dropi. */
async function postCreateWithEdit(
  cfg: Parameters<typeof dropiWebFetch>[0],
  // deno-lint-ignore no-explicit-any
  sbAdmin: any,
  opts: { orderBody: Record<string, unknown>; userId: string; storeId: string; label: string },
): Promise<
  | { ok: true; newId: string; status: number; retriedSinShop: boolean }
  | { ok: false; code?: "orden_ya_enviada" | "created_sin_id" | "post_incierto"; status: number; detail: string; respBody: Record<string, unknown> | null }
> {
  const attempt = async (body: Record<string, unknown>) => {
    const { status, body: respBody, text } = await dropiWebFetch(
      cfg, `/api/orders/myorders`, { method: "POST", body },
    );
    // `accepted` = Dropi dijo que sÃ­ (2xx, isSuccess!==false) aunque no hayamos
    // podido parsear el id â€” distinto de `ok` (aceptado Y con id). La distinciÃ³n
    // importa: un "aceptado sin id" probablemente SÃ creÃ³ la orden.
    const accepted = status >= 200 && status < 300 && respBody?.isSuccess !== false;
    const rawId =
      (respBody?.objects?.id as string | number | undefined) ??
      (respBody?.id as string | number | undefined) ??
      (respBody?.data?.id as string | number | undefined) ??
      (respBody?.order?.id as string | number | undefined) ??
      null;
    const detail = String(respBody?.message || respBody?.error || text || "error").slice(0, 500);
    return { ok: accepted && rawId != null, accepted, rawId, status, respBody: respBody ?? null, detail };
  };
  // external_id del pedido VIEJO (viaja en el body del create-with-edit) â€” para
  // correlacionar fallas de sync_logs con pedidos concretos.
  const oldOrderId = String(opts.orderBody?.id_old_order ?? "");
  const logFail = async (status: number, detail: string, respBody: unknown, extra: string) => {
    await sbAdmin.from("sync_logs").insert({
      source: "dropi-change-carrier",
      status: "error", synced_count: 0, duplicates_count: 0, total_count: 1,
      triggered_by: opts.userId,
      // Incluir el body crudo de Dropi: el `message` genÃ©rico ("Error al crear
      // la orden") no alcanza para diagnosticar; el JSON completo sÃ­.
      error_message: `${opts.label} (pedido viejo #${oldOrderId}) [${status}]${extra}: ${detail} :: dropiBody=${JSON.stringify(respBody ?? {}).slice(0, 700)}`,
      store_id: opts.storeId,
    });
  };

  let first: Awaited<ReturnType<typeof attempt>>;
  try {
    first = await attempt(opts.orderBody);
  } catch (e) {
    // El POST lanzÃ³ (red/timeout) ANTES de que llegara una respuesta: la orden
    // pudo haberse creado igual en Dropi. NUNCA reintentar tras un throw â€” un
    // retry a ciegas puede duplicar. Resultado INCIERTO: verificaciÃ³n manual.
    const msg = e instanceof Error ? e.message : String(e);
    await logFail(0, `lanzÃ³ excepciÃ³n: ${msg}`, null, " (intento 1 lanzÃ³)");
    return {
      ok: false,
      code: "post_incierto",
      status: 0,
      detail: "El POST a Dropi lanzÃ³ antes de responder â€” resultado INCIERTO: verificÃ¡ en el panel de Dropi si la orden nueva se creÃ³ ANTES de reintentar. " + msg,
      respBody: null,
    };
  }
  if (first.ok) return { ok: true, newId: String(first.rawId), status: first.status, retriedSinShop: false };

  // Dropi ACEPTÃ“ el POST (2xx, isSuccess!==false) pero no pudimos parsear el id
  // de la orden nueva â†’ la orden probablemente SÃ se creÃ³. NO entrar al retry
  // sin shop fields (crearÃ­a DOS Ã³rdenes). VerificaciÃ³n manual en el panel.
  if (first.accepted && first.rawId == null) {
    await logFail(first.status, `aceptado SIN id parseable: ${first.detail}`, first.respBody, " (intento 1, aceptado sin id)");
    return {
      ok: false,
      code: "created_sin_id",
      status: first.status,
      detail: "Dropi aceptÃ³ el POST pero no devolviÃ³ id de la orden nueva â€” verificÃ¡ en el panel antes de reintentar",
      respBody: first.respBody,
    };
  }

  const hadShopFields =
    Boolean(String(opts.orderBody.shop_order_id ?? "").trim()) || opts.orderBody.shop_id != null;
  await logFail(first.status, first.detail, first.respBody, hadShopFields ? " (intento 1, con shop_order_id/shop_id)" : "");

  // GUARD ANTI-DUPLICADO DE DROPI (caso Yolanda 2026-07-10): "Esta orden ya fue
  // enviada a dropiX" = la compra YA fue reenviada/forwardeada dentro de Dropi y
  // existe OTRA orden viva de la misma compra (#6053850 EN TRÃNSITO). Reintentar
  // sin shop_order_id ESQUIVA ese guard y CREA UN DUPLICADO REAL (pasÃ³: se creÃ³
  // #6066531 y hubo que cancelarla â€” doble envÃ­o al cliente). NUNCA reintentar.
  const yaEnviada = /ya fue enviada/i.test(
    `${first.detail} ${JSON.stringify(first.respBody ?? {})}`,
  );
  if (yaEnviada) {
    return { ok: false, code: "orden_ya_enviada", status: first.status, detail: first.detail, respBody: first.respBody };
  }

  if (!hadShopFields) {
    return { ok: false, status: first.status, detail: first.detail, respBody: first.respBody };
  }
  // Reintento sin los campos de shop del pedido viejo (paridad con el create que funciona).
  const retryBody = { ...opts.orderBody, shop_order_id: "", shop_id: null };
  let second: Awaited<ReturnType<typeof attempt>>;
  try {
    second = await attempt(retryBody);
  } catch (e) {
    // Sin este log, un throw en el intento 2 (token/red) era INVISIBLE en
    // sync_logs (solo quedaba el intento 1) â€” pasÃ³ 3 veces el 2026-07-10 tarde.
    // Ya NO se propaga como 500: el throw pudo llegar DESPUÃ‰S de que Dropi
    // creara la orden â†’ resultado INCIERTO (el caller intenta recuperarlo por
    // listado y, si no, devuelve 'creacion_incierta' sin invitar al retry).
    const msg = e instanceof Error ? e.message : String(e);
    await logFail(0, `lanzÃ³ excepciÃ³n: ${msg}`, null, " (intento 2, sin shop_order_id/shop_id)");
    return {
      ok: false,
      code: "post_incierto",
      status: 0,
      detail: "El POST a Dropi lanzÃ³ antes de responder (intento 2) â€” resultado INCIERTO: verificÃ¡ en el panel de Dropi si la orden nueva se creÃ³ ANTES de reintentar. " + msg,
      respBody: null,
    };
  }
  if (second.ok) {
    console.log(`[${opts.label}] retry sin shop_order_id/shop_id FUNCIONÃ“ (pedido de bot/otra shop).`);
    return { ok: true, newId: String(second.rawId), status: second.status, retriedSinShop: true };
  }
  // Mismo guard que el intento 1: aceptado sin id = probablemente creada.
  if (second.accepted && second.rawId == null) {
    await logFail(second.status, `aceptado SIN id parseable: ${second.detail}`, second.respBody, " (intento 2, aceptado sin id)");
    return {
      ok: false,
      code: "created_sin_id",
      status: second.status,
      detail: "Dropi aceptÃ³ el POST pero no devolviÃ³ id de la orden nueva â€” verificÃ¡ en el panel antes de reintentar",
      respBody: second.respBody,
    };
  }
  await logFail(second.status, second.detail, second.respBody, " (intento 2, sin shop_order_id/shop_id)");
  return { ok: false, status: second.status, detail: second.detail, respBody: second.respBody };
}

/** Otras Ã³rdenes ACTIVAS del mismo cliente en Dropi. Se usa cuando Dropi
 *  bloquea un create-with-edit con "ya fue enviada": la orden hermana viva es
 *  la que la asesora debe mirar. Desde 2026-07-13 busca por TELÃ‰FONO (Ãºltimos
 *  9 dÃ­gitos â€” la llave anti-dup del CRM; los nombres tienen variantes) con
 *  fallback al nombre, vÃ­a listActiveOrdersByPhone. Nunca tira. */
async function findActiveSiblings(
  cfg: { base: string; sessionToken: string; apiKey: string; storeUrl: string },
  opts: { phone: string; clientName: string; excludeId: string },
): Promise<SiblingOrder[]> {
  try {
    const sibs = await listActiveOrdersByPhone(cfg, {
      phone: opts.phone,
      fallbackName: opts.clientName,
      excludeIds: [opts.excludeId],
    });
    return sibs.slice(0, 3);
  } catch {
    return [];
  }
}

/** Deriva el host api-v2 (detalle web del pedido) desde el host de integraciones.
 *  cfg.base = "https://api.dropi.ec" â†’ "https://api-v2.dropi.ec". */
function apiV2HostFrom(base: string): string {
  // Reemplaza el primer "//api." por "//api-v2." (respeta el TLD del paÃ­s).
  if (/\/\/api-v2\./.test(base)) return base.replace(/\/+$/, "");
  const v2 = base.replace(/\/\/api\./, "//api-v2.");
  return v2.replace(/\/+$/, "");
}

/** GET https://api-v2.dropi.ec/orders/orders/{externalId} con token de sesiÃ³n web.
 *  Devuelve el detalle rico (client{...}, rate_type, notes, shop_order_id, products).
 *  Usa session token primero (el que sirve para /api/*), api_key de respaldo. */
async function dropiGetOrderV2(
  cfg: { base: string; sessionToken: string; apiKey: string; storeUrl: string },
  externalId: string,
): Promise<DropiResult> {
  const host = apiV2HostFrom(cfg.base);
  const url = `${host}/orders/orders/${encodeURIComponent(externalId)}`;
  const token = cfg.sessionToken || cfg.apiKey;
  const headers: Record<string, string> = {
    "X-Authorization": "Bearer " + token,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
  if (cfg.storeUrl) headers["Origin"] = cfg.storeUrl;
  const res = await fetch(url, { method: "GET", headers });
  const rawText = await res.text();
  console.log("[dropi-change-carrier] v2 detail", { url, status: res.status, body: rawText.slice(0, 300) });
  let body: Record<string, unknown> = {};
  try { body = rawText ? JSON.parse(rawText) : {}; } catch { body = { raw: rawText }; }
  const ok = res.ok && body.isSuccess !== false;
  return { ok, httpStatus: res.status, body, rawText };
}

/** Extrae los campos de cliente desde el detalle v2 (data.client{...} + data.*). */
function parseV2Client(body: Record<string, unknown>): OrderClientFields | null {
  const data = (body.data ?? body.objects ?? body) as Record<string, unknown>;
  const client = (data?.client ?? {}) as Record<string, unknown>;
  const name = String(client.name ?? data?.name ?? "").trim();
  const phone = String(client.phone ?? data?.phone ?? "").trim();
  const dir = String(client.dir ?? data?.dir ?? "").trim();
  // Sin nombre/telÃ©fono/direcciÃ³n no podemos crear la orden con confianza.
  if (!name || !phone || !dir) return null;
  return {
    name,
    surname: String(client.surname ?? data?.surname ?? "").trim(),
    dir,
    phone,
    state: String(client.state ?? data?.state ?? "").trim(),
    city: String(client.city ?? data?.city ?? "").trim(),
    email: String(client.client_email ?? client.email ?? data?.client_email ?? "").trim(),
    notes: String(data?.notes ?? "").trim(),
    rateType: String(data?.rate_type ?? "CON RECAUDO").trim() || "CON RECAUDO",
    shopOrderId: data?.shop_order_id != null ? String(data.shop_order_id) : "",
    shopId: client.shop_id != null ? Number(client.shop_id) : (data?.shop_id != null ? Number(data.shop_id) : null),
  };
}

/** Extrae lÃ­neas {dropiId, quantity, price, name?} desde el cuerpo de un pedido
 *  Dropi (integration GET) â€” usado como fallback cuando el detalle v2 no estÃ¡. */
function parseOrderLines(body: Record<string, unknown>): LineDetail[] {
  // El pedido puede venir en body, body.objects, body.data o body.order.
  const order = (body.objects ?? body.data ?? body.order ?? body) as Record<string, unknown>;
  const details = (order?.orderdetails ?? order?.order_details ?? []) as Array<Record<string, unknown>>;
  const lines: LineDetail[] = [];
  for (const d of Array.isArray(details) ? details : []) {
    const product = (d.product ?? {}) as Record<string, unknown>;
    const dropiId = Number(product.id ?? d.product_id ?? d.id);
    if (!Number.isFinite(dropiId) || dropiId <= 0) continue;
    const quantity = Number(d.quantity ?? 1) || 1;
    const price = Number(d.price ?? product.sale_price ?? product.price ?? 0) || 0;
    const name = String(product.name ?? d.name ?? "").trim() || undefined;
    lines.push({ dropiId, quantity, price, ...(name ? { name } : {}) });
  }
  return lines;
}

/** Extrae lÃ­neas {dropiId, quantity, price, name?} desde el detalle v2 (data.products[]). */
function parseV2Lines(body: Record<string, unknown>): LineDetail[] {
  const data = (body.data ?? body.objects ?? body) as Record<string, unknown>;
  const products = (data?.products ?? []) as Array<Record<string, unknown>>;
  const lines: LineDetail[] = [];
  for (const p of Array.isArray(products) ? products : []) {
    const dropiId = Number(p.id ?? p.product_id);
    if (!Number.isFinite(dropiId) || dropiId <= 0) continue;
    const quantity = Number(p.quantity ?? 1) || 1;
    const price = Number(p.price ?? p.sale_price ?? 0) || 0;
    const name = String(p.name ?? "").trim() || undefined;
    lines.push({ dropiId, quantity, price, ...(name ? { name } : {}) });
  }
  return lines;
}

/** Fila Guardian mÃ­nima para el fallback de cliente. */
interface OrderRowFallback {
  nombre?: string | null;
  phone?: string | null;
  direccion?: string | null;
  ciudad?: string | null;
  departamento?: string | null;
}

type ClientLinesResult =
  | { ok: true; client: OrderClientFields; lines: LineDetail[] }
  | { ok: false; error: string; dropiBody?: Record<string, unknown> };

/** Prep compartida de los modos que recrean la orden (apply / apply_value):
 *  detalle del cliente + lÃ­neas. PRIMERO el detalle v2 (rico: client, rate_type,
 *  notes, shop_order_id, products). FALLBACK a la fila Guardian + integration GET.
 *  ExtraÃ­da 1:1 del apply original â€” no cambiar sin re-verificar en vivo. */
async function resolveClientAndLines(
  cfg: { base: string; sessionToken: string; apiKey: string; storeUrl: string },
  orderRow: OrderRowFallback,
  externalId: string,
): Promise<ClientLinesResult> {
  let client: OrderClientFields | null = null;
  let lines: LineDetail[] = [];
  try {
    const v2 = await dropiGetOrderV2(cfg, externalId);
    if (v2.ok) {
      client = parseV2Client(v2.body);
      lines = parseV2Lines(v2.body);
    }
  } catch (e) {
    // No abortamos por el v2: caemos al fallback. Logueamos para diagnÃ³stico.
    console.error("[dropi-change-carrier] v2 detail failed:", e);
  }

  // Fallback de lÃ­neas: integration GET (parseOrderLines) si v2 no trajo productos.
  let integrationBody: Record<string, unknown> | null = null;
  if (lines.length === 0) {
    const ord = await dropiGetOrder(cfg.base, cfg.apiKey, cfg.storeUrl, externalId);
    integrationBody = ord.body;
    if (ord.ok) lines = parseOrderLines(ord.body);
  }
  if (lines.length === 0) {
    return {
      ok: false,
      error: "No pude leer los productos del pedido para recrearlo (ni v2 ni integraciÃ³n).",
      dropiBody: integrationBody ?? undefined,
    };
  }

  // Fallback de cliente: la fila Guardian (nombre/phone/direccion/ciudad/departamento).
  if (!client) {
    const nombre = String(orderRow.nombre || "").trim();
    const phone = String(orderRow.phone || "").trim();
    const dir = String(orderRow.direccion || "").trim();
    if (!nombre || !phone || !dir) {
      return {
        ok: false,
        error: "No pude leer los datos del cliente (nombre/telÃ©fono/direcciÃ³n) para recrear la orden.",
      };
    }
    client = {
      name: nombre,
      surname: "",
      dir,
      phone,
      state: String(orderRow.departamento || "").trim(),
      city: String(orderRow.ciudad || "").trim(),
      email: "",
      notes: "",
      rateType: "CON RECAUDO",
      shopOrderId: "",
      shopId: null,
    };
  }
  return { ok: true, client, lines };
}

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const jsonErr = (error: string, status: number) =>
    new Response(JSON.stringify({ ok: false, error }), {
      status, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  const jsonOk = (payload: Record<string, unknown>, status = 200) =>
    new Response(JSON.stringify(payload), {
      status, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Presupuesto de wall-clock: el pipeline apila hasta ~10 llamadas a Dropi de
  // 30s c/u sin tope total â€” la plataforma puede matar la funciÃ³n DESPUÃ‰S del
  // create y ANTES del PUT REEMPLAZADA/barrido. Los pasos OPCIONALES (reintento
  // del PUT, barrido de hermanas) chequean budgetLeft() y se degradan a warning;
  // los crÃ­ticos (create, update local, tumba) nunca se saltean.
  const serveDeadline = Date.now() + 100_000;
  const budgetLeft = () => Date.now() < serveDeadline;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonErr("No autorizado", 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;

    const sbAdmin = createClient(supabaseUrl, serviceKey);
    const sbUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: authError } = await sbUser.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (authError || !userData?.user) return jsonErr("Token invÃ¡lido", 401);
    const user = userData.user;

    let body: ChangeCarrierBody;
    try { body = await req.json() as ChangeCarrierBody; } catch { return jsonErr("Body invÃ¡lido", 400); }

    const externalId = String(body.externalId || "").trim();
    const mode = body.mode === "apply"
      ? "apply"
      : body.mode === "apply_value"
        ? "apply_value"
        : body.mode === "apply_edit"
          ? "apply_edit"
          : body.mode === "cancel"
            ? "cancel"
            : "quote";
    if (!externalId) return jsonErr("Falta externalId", 400);

    // ---- Resolver pedido + tienda + membresÃ­a ----
    const { data: orderRow, error: orderErr } = await sbAdmin
      .from("orders")
      .select("id, store_id, nombre, phone, direccion, ciudad, departamento, valor, guia, transportadora, external_id, estado, locked_by, locked_at")
      .eq("external_id", externalId)
      .maybeSingle();
    if (orderErr || !orderRow) return jsonOk({ ok: false, error: `Pedido ${externalId} no encontrado` });

    const storeId = String((orderRow as { store_id: string }).store_id);
    const isMember = await isStoreMember(sbAdmin, user.id, storeId);
    if (!isMember) return jsonOk({ ok: false, error: "No perteneces a esta tienda" });

    // GuÃ­a ya generada â†’ la transportadora quedÃ³ fija al imprimir. NO aplica a
    // "cancel": una cancelaciÃ³n es vÃ¡lida aunque el pedido tenga guÃ­a (el panel
    // Dropi tambiÃ©n lo permite) â€” el fantasma que matamos puede tener guÃ­a en EC.
    if (mode !== "cancel" && String(orderRow.guia || "").trim()) {
      return jsonOk({ ok: false, code: "guia_generada", error: "El pedido ya tiene guÃ­a generada; la transportadora no se puede cambiar." });
    }

    // Gate de ESTADO server-side para los modos que ESCRIBEN (apply/apply_edit/
    // apply_value â€” NO quote ni cancel): el diÃ¡logo del cliente se abre sobre
    // snapshots viejos y sin esto podÃ­a REVIVIR un pedido muerto recreÃ¡ndolo
    // en Dropi (cancelado/reemplazado/rechazado/entregado â†’ orden nueva viva).
    if (
      (mode === "apply" || mode === "apply_edit" || mode === "apply_value") &&
      /CANCELAD|REEMPLAZAD|RECHAZAD|^ENTREGADO/i.test(String(orderRow.estado || ""))
    ) {
      return jsonOk({
        ok: false,
        code: "ya_gestionado",
        error: `El pedido estÃ¡ ${orderRow.estado} â€” no se puede editar. RefrescÃ¡ la pantalla.`,
      });
    }

    const cfg = await loadStoreConfig(sbAdmin, storeId);
    if (!cfg.apiKey) return jsonOk({ ok: false, error: "La tienda no tiene Clave API de Dropi configurada" });

    // =========================== MODE: DEBUG ===========================
    // DiagnÃ³stico A/B para CONFIRMAR el root cause del 401 del edge (2026-07-01):
    // el 401 no era WAF (403) ni token (limpio, mismo que el panel #102) â€” era el
    // header Origin. El edge mandaba Origin=cfg.storeUrl (rushmira.com) y Dropi lo
    // rechazaba; con Origin=app.dropi.ec (como el panel) da 200. Este branch prueba
    // getOriginCity con AMBOS Origins usando el MISMO token limpio â†’ un solo deploy
    // confirma cuÃ¡l Origin pasa. TambiÃ©n reporta el estado del token (comillas/len).
    if (body.mode === "debug") {
      const appOrigin = cfg.base.replace("://api.", "://app.");
      const rawTok = String(cfg.sessionToken || "");
      const cleanTok = rawTok.replace(/^"+|"+$/g, "");
      const ocFetch = async (origin: string) => {
        try {
          const r = await fetch(`${cfg.base}/api/orders/getOriginCityForCalculateShipping`, {
            method: "POST",
            headers: {
              "X-Authorization": "Bearer " + cleanTok,
              "Content-Type": "application/json",
              "Accept": "application/json, text/plain, */*",
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
              "Origin": origin,
              "Referer": `${appOrigin}/`,
              "Sec-Fetch-Dest": "empty",
              "Sec-Fetch-Mode": "cors",
              "Sec-Fetch-Site": "same-site",
            },
            body: JSON.stringify({ id: 155190, destination: "machala, el oro", type: "SIMPLE" }),
          });
          return { origin, status: r.status, body: (await r.text()).slice(0, 160) };
        } catch (e) { return { origin, status: 0, body: "throw: " + String(e) }; }
      };
      const withAppOrigin = await ocFetch(appOrigin);
      const withStoreOrigin = await ocFetch(cfg.storeUrl || appOrigin);
      // La ruta compartida (ya arreglada a Origin=appOrigin) debe coincidir con withAppOrigin.
      let sharedStatus = 0, sharedBody = "";
      try {
        const oc = await dropiWebFetch(cfg, "/api/orders/getOriginCityForCalculateShipping", {
          method: "POST", body: { id: 155190, destination: "machala, el oro", type: "SIMPLE" },
        });
        sharedStatus = oc.status; sharedBody = String(oc.text || "").slice(0, 160);
      } catch (e) { sharedBody = "throw: " + String(e); }
      return jsonOk({
        ok: true, debug: true,
        appOrigin, storeUrl: cfg.storeUrl,
        tokenLen: rawTok.length, tokenHadQuotes: rawTok !== cleanTok,
        tokenTail: cleanTok.slice(-8),
        withAppOrigin, withStoreOrigin,
        sharedPath: { status: sharedStatus, body: sharedBody },
      });
    }

    // Renovar el session token si venciÃ³ (login automÃ¡tico por tienda â€”
    // _shared/dropiSessionLogin). quote/apply/cancel dependen 100% del panel web;
    // apply_value lo renueva LAZY (su camino directo PUT+verify no lo necesita).
    if (mode === "quote" || mode === "apply" || mode === "cancel") {
      try {
        cfg.sessionToken = await ensureFreshSessionToken(sbAdmin, cfg);
      } catch (e) {
        if (e instanceof WebFallbackError) return jsonOk({ ok: false, error: e.message });
        throw e;
      }
    }

    // =========================== MODE: CANCEL ===========================
    // Cancela DE VERDAD el pedido en Dropi. El NÃšCLEO vive en
    // _shared/dropiCancelOrder.ts (cancelOrderInDropi) â€” extraÃ­do 1:1 de este
    // branch (verificado e2e 2026-07-08) para que dropi-cron pueda reintentar
    // cancelaciones fallidas con la MISMA mecÃ¡nica:
    //   (a) PUT web {status:"CANCELADO", reasonComment} â†’ CANCELADO local.
    //   (b) Fantasma (PUT falla + GET integraciÃ³n 404 "Orden no encontrada")
    //       â†’ cancel SOLO local + dropiMissing:true.
    //   (c) Existe pero rechazÃ³ â†’ ok:false + code:"dropi_rejected" (el cliente
    //       conserva su overlay local y avisa "reintentar").
    // El resultado discriminado tiene EXACTAMENTE el shape que el cliente
    // espera (canceled===true / dropiMissing / code:"dropi_rejected"), asÃ­ que
    // se devuelve tal cual.
    if (mode === "cancel") {
      const result = await cancelOrderInDropi(cfg, sbAdmin, {
        externalId,
        orderId: (orderRow as { id: string }).id,
        storeId,
        reason: String(body.reason || ""),
      });
      return jsonOk(result as unknown as Record<string, unknown>);
    }

    // =========================== MODE: QUOTE ===========================
    if (mode === "quote") {
      // 1) Leer las lÃ­neas del pedido desde Dropi (no guardamos product ids local).
      //    PRIMERO la integraciÃ³n; si da "Orden no encontrada" (pedidos de bot
      //    LucidBot/FINAL_ORDER de otra shop, INVISIBLES para /integrations pero
      //    vivos en el panel â€” caso #6053027 2026-07-10), caer al detalle v2 (web),
      //    el mismo fallback que ya usa resolveClientAndLines para los recreates.
      const ord = await dropiGetOrder(cfg.base, cfg.apiKey, cfg.storeUrl, externalId);
      let realLines: LineDetail[] = [];
      if (ord.ok) {
        realLines = parseOrderLines(ord.body);
      } else {
        try {
          cfg.sessionToken = await ensureFreshSessionToken(sbAdmin, cfg);
          const v2q = await dropiGetOrderV2(cfg, externalId);
          if (v2q.ok) realLines = parseV2Lines(v2q.body);
        } catch (e) {
          console.error("[quote] fallback v2 fallÃ³:", e);
        }
        if (realLines.length === 0) {
          return jsonOk({
            ok: false,
            error: `No pude leer el pedido en Dropi [${ord.httpStatus}].`,
            dropiHttpStatus: ord.httpStatus,
            dropiBody: ord.body,
          });
        }
      }
      if (realLines.length === 0) {
        return jsonOk({
          ok: false,
          error: "No pude leer los productos del pedido desde Dropi (sin orderdetails con id).",
          dropiBody: ord.body,
        });
      }
      // Override de lÃ­neas (botÃ³n "Recotizar" del editor unificado): permite
      // cotizar con cantidades/precios editados sin aplicar nada todavÃ­a.
      // InvÃ¡lido â†’ se ignora y se cotiza con las lÃ­neas reales.
      const overrideLines = sanitizeLinesOverride(body.lines, realLines);
      const lines = overrideLines ?? realLines;

      // 2) Ciudad destino: catÃ¡logo local + fallback vivo /api/locations (self-healing).
      //    El fallback vivo LANZA con errores reales (token vencido/red) en vez de
      //    devolver null â€” no confundir con "sin cobertura".
      const country = cfg.countryCode === "EC" ? "ECUADOR" : "COLOMBIA";
      let destCity;
      try {
        destCity = await resolveDestCity(
          sbAdmin, cfg, cfg.countryCode, String(orderRow.ciudad || ""), String(orderRow.departamento || ""),
        );
      } catch (e) {
        if (e instanceof WebFallbackError) {
          return jsonOk({ ok: false, code: "dropi_error", error: e.message });
        }
        throw e;
      }
      if (!destCity) {
        return jsonOk({
          ok: false,
          code: "sin_cobertura_dropi",
          error: noCoverageMessage(String(orderRow.ciudad || ""), String(orderRow.departamento || "")),
          city: String(orderRow.ciudad || ""), state: String(orderRow.departamento || ""),
        });
      }

      // 3) Cotizar en vivo (panel web â€” session token; destino ya resuelto del catÃ¡logo).
      const total = overrideLines
        ? roundMoney(overrideLines.reduce((s, l) => s + l.price * l.quantity, 0), cfg.countryCode)
        : Number(orderRow.valor) || lines.reduce((s, l) => s + l.price * l.quantity, 0);
      try {
        const ctx = await quoteCarriers(cfg, {
          country,
          city: String(orderRow.ciudad || ""),
          state: String(orderRow.departamento || ""),
          destCity,
          lines,
          total,
        });
        return jsonOk({
          ok: true,
          current: String(orderRow.transportadora || ""),
          options: ctx.options,
          // Editor unificado: lÃ­neas usadas para cotizar (dropiId/quantity/price/
          // name) + total â€” el diÃ¡logo pinta el editor de producto con la MISMA
          // llamada que ya hacÃ­a para cotizar. Clientes viejos las ignoran.
          lines,
          total,
        });
      } catch (e) {
        if (e instanceof WebFallbackError) {
          // Credenciales vencidas / sin opciones: mensaje accionable + body crudo de
          // Dropi (si lo hay) para diagnosticar sin ir a los logs. No rompe la card.
          return jsonOk({ ok: false, error: e.message, dropiBody: (e as WebFallbackError).body });
        }
        throw e;
      }
    }

    // ======================== MODE: APPLY_VALUE =========================
    // Cambia el VALOR a cobrar (COD) del pedido. Dos caminos, en orden:
    //  1) DIRECTO: PUT total_order con la integration-key + VERIFICACIÃ“N por GET
    //     (el PUT de Dropi ignora en silencio lo que no soporta â€” nunca creer el 200).
    //     No necesita session token â†’ funciona aunque el login automÃ¡tico no estÃ©.
    //  2) RECREAR como el panel (create-with-edit, misma mecÃ¡nica verificada del
    //     apply): cancela la vieja + crea una nueva con el total nuevo y la MISMA
    //     transportadora. Necesita session token (se renueva acÃ¡, lazy).
    // El cliente detecta funciones viejas deployadas con `valorApplied === true`.
    if (mode === "apply_value") {
      const newValor = Number(body.newValor);
      if (!Number.isFinite(newValor) || newValor <= 0) {
        return jsonOk({ ok: false, error: "Valor nuevo invÃ¡lido (debe ser un nÃºmero mayor a 0)." });
      }
      const oldValor = Number(orderRow.valor) || 0;
      if (Math.abs(newValor - oldValor) < 0.01) {
        return jsonOk({ ok: true, valorApplied: true, method: "no_change", externalId, valor: oldValor });
      }

      // ---- Camino 1: PUT directo + verificaciÃ³n ----
      let putDetail = "";
      try {
        const put = await dropiPutTotal(cfg.base, cfg.apiKey, cfg.storeUrl, externalId, newValor);
        putDetail = `PUT ${put.httpStatus}`;
        if (put.ok) {
          const after = await dropiGetOrder(cfg.base, cfg.apiKey, cfg.storeUrl, externalId);
          const t = after.ok ? parseOrderTotal(after.body) : null;
          if (t !== null && Math.abs(t - newValor) < 0.01) {
            const { error: updErr } = await sbAdmin
              .from("orders")
              .update({ valor: newValor })
              .eq("id", orderRow.id);
            if (updErr) console.error("[apply_value] local valor update failed:", updErr);
            const { error: auditErr } = await sbAdmin.from("order_results").insert({
              order_id: orderRow.id,
              phone: String(orderRow.phone || ""),
              operator_id: user.id,
              module: "confirmar",
              result: "cambio_valor",
              reason: JSON.stringify({ antes: { valor: oldValor }, despues: { valor: newValor }, via: "put" }).slice(0, 2000),
              store_id: storeId,
            });
            if (auditErr) console.error("[apply_value] audit insert failed:", auditErr);
            return jsonOk({
              ok: true, valorApplied: true, method: "put", externalId, valor: newValor,
              // Dropi SÃ tiene el valor nuevo pero la ficha local quedÃ³ vieja:
              // avisar en vez de fingir Ã©xito total (la card mostrarÃ­a el valor viejo).
              ...(updErr ? {
                warning: `El valor se aplicÃ³ en Dropi pero no pude actualizar la ficha local: ${updErr.message}. La card puede mostrar el valor viejo hasta el prÃ³ximo sync.`,
              } : {}),
            });
          }
          putDetail += t === null ? " (no pude verificar el total)" : ` (Dropi lo ignorÃ³: total sigue en ${t})`;
        }
      } catch (e) {
        console.error("[apply_value] PUT directo fallÃ³:", e);
        putDetail = "PUT fallÃ³: " + (e instanceof Error ? e.message : String(e));
      }
      console.log("[apply_value] camino directo no aplicÃ³, recreando.", { externalId, putDetail });

      // ---- Camino 2: recrear como el panel (create-with-edit) ----
      try {
        cfg.sessionToken = await ensureFreshSessionToken(sbAdmin, cfg);
      } catch (e) {
        if (e instanceof WebFallbackError) {
          return jsonOk({
            ok: false,
            error: `Dropi no aceptÃ³ el cambio directo del valor (${putDetail}) y no pude entrar al panel para recrear el pedido: ${e.message}`,
          });
        }
        throw e;
      }

      const prepV = await resolveClientAndLines(cfg, orderRow, externalId);
      if (!prepV.ok) {
        return jsonOk({ ok: false, error: prepV.error, ...(prepV.dropiBody ? { dropiBody: prepV.dropiBody } : {}) });
      }
      const clientV = prepV.client;
      // Precios de lÃ­nea escalados al valor nuevo (total_order manda para el recaudo).
      const linesV = scaleLinePrices(prepV.lines, newValor, cfg.countryCode);

      const countryV = cfg.countryCode === "EC" ? "ECUADOR" : "COLOMBIA";
      let destCityV;
      try {
        destCityV = await resolveDestCity(sbAdmin, cfg, cfg.countryCode, clientV.city, clientV.state);
      } catch (e) {
        if (e instanceof WebFallbackError) {
          return jsonOk({ ok: false, code: "dropi_error", error: e.message });
        }
        throw e;
      }
      if (!destCityV) {
        return jsonOk({
          ok: false,
          code: "sin_cobertura_dropi",
          error: noCoverageMessage(clientV.city, clientV.state),
          city: clientV.city, state: clientV.state,
        });
      }

      let ctxV;
      try {
        ctxV = await quoteCarriers(cfg, {
          country: countryV,
          city: clientV.city,
          state: clientV.state,
          destCity: destCityV,
          lines: linesV,
          total: newValor,
        });
      } catch (e) {
        if (e instanceof WebFallbackError) {
          return jsonOk({ ok: false, error: e.message, dropiBody: (e as WebFallbackError).body });
        }
        throw e;
      }

      // Mantener la transportadora ACTUAL. Si no cotiza esta ruta (o el pedido
      // no tiene una asignada), caer a la mÃ¡s barata â‰  VELOCES (criterio del push).
      const currentCarrierNorm = normUp(orderRow.transportadora || "");
      const chosen =
        (currentCarrierNorm
          ? ctxV.options.find((op) => normUp(op.name) === currentCarrierNorm)
          : undefined) ??
        ctxV.options.find((op) => normUp(op.name) !== "VELOCES") ??
        ctxV.options[0] ??
        null;
      if (!chosen) {
        return jsonOk({ ok: false, error: "Dropi no devolviÃ³ transportadoras para recrear el pedido con el valor nuevo." });
      }
      // Aviso si la transportadora ACTUAL no cotizÃ³ y caÃ­mos a otra: el pedido
      // se recrea con una carrier distinta sin que la asesora lo pidiera.
      let warningV: string | undefined;
      if (currentCarrierNorm && normUp(chosen.name) !== currentCarrierNorm) {
        warningV = `La transportadora actual ${orderRow.transportadora} no cotiza esta ruta; el pedido se recreÃ³ con ${chosen.name} â€” verificÃ¡ SLA/tracking.`;
      }

      const userIdV = decodeJwtSub(cfg.sessionToken);
      const orderBodyV: Record<string, unknown> = {
        total_order: newValor,
        notes: clientV.notes || "",
        name: clientV.name,
        surname: clientV.surname || "",
        dir: clientV.dir,
        country: countryV,
        state: ctxV.dest.stateName,
        city: ctxV.dest.cityName,
        phone: clientV.phone,
        client_email: clientV.email || "",
        payment_method_id: 1,
        user_id: userIdV,
        supplier_id: ctxV.supplierId,
        type: "FINAL_ORDER",
        rate_type: clientV.rateType || "CON RECAUDO",
        products: ctxV.products.map((p) => ({
          id: p.dropiId, uid: p.dropiId, quantity: p.quantity, price: p.price, type: p.productType,
        })),
        distributionCompany: { id: chosen.id, name: chosen.name },
        // Paridad con el create web QUE FUNCIONA (shopify-push createOrderViaWeb).
        type_service: chosen.typeService || "normal",
        shipping_amount: chosen.shippingAmount,
        zip_code: null,
        colonia: "",
        shop_id: clientV.shopId ?? null,
        dni: "",
        dni_type: null,
        insurance: false,
        shalom_data: null,
        warehouses_selected_id: ctxV.origin.warehouseId,
        // Flags de EDICIÃ“N (verificados en vivo) â€” cancelan la vieja + linkean la nueva.
        is_edit_order: true,
        id_old_order: Number(externalId),
        shop_order_id: clientV.shopOrderId || "",
        shop_order_number: "",
        reasonComment: `Esta orden reemplaza a la orden ${externalId}: cambio de valor ${oldValor} â†’ ${newValor}.`,
      };

      let newIdV: string | null = null;
      let dropiStatusV = 0;
      try {
        const postV = await postCreateWithEdit(cfg, sbAdmin, {
          orderBody: orderBodyV, userId: user.id, storeId, label: "Dropi rechazÃ³ el cambio de valor",
        });
        dropiStatusV = postV.status;
        // `=== false` (no `!ok`): narrowing robusto tambiÃ©n sin strict mode.
        if (postV.ok === false) {
          if (postV.code === "orden_ya_enviada") {
            const sibsV = await findActiveSiblings(cfg, {
              phone: String(orderRow.phone || clientV.phone || ""),
              clientName: `${clientV.name} ${clientV.surname || ""}`,
              excludeId: externalId,
            });
            const sibTxtV = sibsV.length
              ? ` Orden(es) activa(s) del cliente en Dropi: ${sibsV.map((s) => `#${s.id} (${s.status}${s.total ? `, $${s.total}` : ""})`).join(", ")}.`
              : "";
            // Auto-retiro SOLO con evidencia positiva: v2 dice muerto Y hay hermana viva.
            const retiredStubV = await retireBotStubIfGone(cfg, sbAdmin, externalId, String(orderRow.id), sibsV.length, String(orderRow.phone || clientV.phone || ""));
            return jsonOk({
              ok: false,
              code: "orden_ya_enviada",
              error: `Dropi bloqueÃ³ el cambio: esta compra ya fue reenviada dentro de Dropi y recrearla generarÃ­a un pedido DUPLICADO (doble envÃ­o al cliente).${sibTxtV} GestionÃ¡ la orden activa del cliente; acÃ¡ no se creÃ³ ni cambiÃ³ nada.${retiredStubV ? " Este pedido era el BORRADOR del bot de Dropi y se retirÃ³ de la cola automÃ¡ticamente â€” gestionÃ¡ la orden activa del cliente." : ""}`,
              dropiHttpStatus: postV.status,
              dropiBody: postV.respBody,
              ...(sibsV[0] ? { activeSibling: { externalId: sibsV[0].id, estado: sibsV[0].status, total: sibsV[0].total } } : {}),
              siblings: sibsV.map((s) => ({ externalId: s.id, estado: s.status })),
              ...(retiredStubV ? { retiredStub: true } : {}),
            });
          }
          if (postV.code === "created_sin_id" || postV.code === "post_incierto") {
            // Resultado INCIERTO: Dropi pudo haber creado la orden. Intentar
            // recuperarla por listado; si no hay UN candidato claro, devolver
            // 'creacion_incierta' â€” el "NO reintentes" viaja en el string para
            // que tambiÃ©n lo muestre un cliente viejo.
            const rec = await recoverUncertainCreate(cfg, sbAdmin, {
              phone: String(orderRow.phone || clientV.phone || ""),
              clientName: `${clientV.name} ${clientV.surname || ""}`,
              oldId: externalId,
              expectedTotal: newValor,
              storeId,
              userId: user.id,
              label: "Cambio de valor",
            });
            if (!rec) {
              return jsonOk({
                ok: false,
                code: "creacion_incierta",
                error: "Resultado INCIERTO: Dropi pudo haber creado la orden nueva pero no la pude identificar. NO reintentes la ediciÃ³n â€” verificÃ¡ en el panel de Dropi o esperÃ¡ el prÃ³ximo sync (â‰¤5 min) y refrescÃ¡.",
                dropiHttpStatus: postV.status,
                dropiBody: postV.respBody,
              });
            }
            newIdV = rec.newId;
          } else {
            return jsonOk({
              ok: false,
              error: `Dropi rechazÃ³ el cambio de valor [${postV.status}]: ${postV.detail}`,
              dropiHttpStatus: postV.status,
              dropiBody: postV.respBody,
            });
          }
        } else {
          newIdV = postV.newId;
        }
      } catch (e) {
        if (e instanceof WebFallbackError) {
          return jsonOk({ ok: false, error: e.message, dropiHttpStatus: (e as WebFallbackError).status, dropiBody: (e as WebFallbackError).body });
        }
        throw e;
      }

      // Paridad panel: soft-borrar la orden vieja (REEMPLAZADA) para que no quede
      // duplicada en Dropi ni la re-importe el cron.
      const replacedV = await markOldOrderReplaced(cfg, externalId);

      // Sincronizar la fila Guardian EN SU LUGAR (mismo dbId) â€” mismo patrÃ³n y
      // manejo de carrera 23505 que el apply de transportadora.
      let auditOrderIdV: string = String(orderRow.id);
      const { error: updErrV } = await sbAdmin
        .from("orders")
        .update({ external_id: newIdV, valor: newValor, transportadora: chosen.name })
        .eq("id", orderRow.id);
      if (updErrV) {
        console.error("[apply_value] local update failed:", updErrV);
        let updWarnV: string;
        if ((updErrV as { code?: string }).code === "23505") {
          // Carrera con el cron: la orden nueva ya existe como fila propia. La
          // vieja queda REEMPLAZADA (no CANCELADO) y la auditorÃ­a va a la nueva.
          const dupV = await absorbCronDuplicate(sbAdmin, {
            newId: String(newIdV), storeId, rowId: String(orderRow.id),
            lockedBy: (orderRow as { locked_by?: string | null }).locked_by,
            lockedAt: (orderRow as { locked_at?: string | null }).locked_at,
          });
          updWarnV = dupV.warning;
          if (dupV.auditOrderId) auditOrderIdV = dupV.auditOrderId;
        } else {
          updWarnV = `El cambio se aplicÃ³ en Dropi (nuevo id ${newIdV}) pero no pude actualizar la fila local: ${updErrV.message}. Puede aparecer un duplicado hasta el prÃ³ximo sync.`;
        }
        warningV = warningV ? `${warningV} ${updWarnV}` : updWarnV;
      }

      // VerificaciÃ³n + tumba anti-reimport (corre SIEMPRE, tambiÃ©n con PUT ok).
      const guardV = await guardReplacedOldOrder(cfg, sbAdmin, {
        replaced: replacedV, externalId, newId: String(newIdV), rowId: String(orderRow.id), storeId, userId: user.id,
        phone: String(orderRow.phone || clientV.phone || ""), budgetLeft,
      });
      if (guardV.warning) warningV = warningV ? `${warningV} ${guardV.warning}` : guardV.warning;

      // Barrido de hermanas vivas (forwarding de Dropi) â€” exactamente UNO vivo.
      const sweepV = await sweepStraySiblings(cfg, sbAdmin, {
        phone: String(orderRow.phone || clientV.phone || ""),
        clientName: `${clientV.name} ${clientV.surname || ""}`,
        newId: String(newIdV), oldId: externalId, storeId,
        knownTotals: [oldValor, newValor], budgetLeft,
      });
      const duplicatesAliveV = [
        ...(guardV.oldAlive ? [guardV.oldAlive] : []),
        ...sweepV.leftovers,
      ];
      if (sweepV.skippedByBudget) {
        warningV = `${warningV ? warningV + " " : ""}No alcancÃ© a barrer duplicados del cliente â€” revisÃ¡ el panel de Dropi.`;
      }
      if (duplicatesAliveV.length) {
        const dupTxtV = `DUPLICADO VIVO en Dropi: ${duplicatesAliveV.map((d) => `#${d.externalId} (${d.estado})`).join(", ")} â€” cancelalo para evitar doble envÃ­o.`;
        if (!warningV || !warningV.includes("DUPLICADO VIVO")) {
          warningV = warningV ? `${warningV} ${dupTxtV}` : dupTxtV;
        }
        // Persistencia del barrido (el guard ya persiste su propio oldAlive).
        if (sweepV.leftovers.length) {
          try {
            await sbAdmin.from("order_results").insert({
              order_id: auditOrderIdV, store_id: storeId, operator_id: user.id,
              phone: String(orderRow.phone || clientV.phone || ""),
              result: "edicion_orden", dropi_sync_status: "failed",
              result_notes: ("EDICIÃ“N: " + dupTxtV).slice(0, 300),
            });
            await sbAdmin.from("sync_logs").insert({
              source: "dropi-change-carrier", status: "error",
              synced_count: 0, duplicates_count: 0, total_count: 1, triggered_by: user.id,
              error_message: `Barrido post-ediciÃ³n: quedaron duplicados vivos ${sweepV.leftovers.map((d) => `#${d.externalId} (${d.estado})`).join(", ")} tras crear ${newIdV} (viejo ${externalId}).`,
              store_id: storeId,
            });
          } catch (e) { console.error("[apply_value] persistencia de duplicados vivos fallÃ³:", e); }
        }
      }

      const { error: auditErrV } = await sbAdmin.from("order_results").insert({
        order_id: auditOrderIdV,
        phone: String(orderRow.phone || clientV.phone || ""),
        operator_id: user.id,
        module: "confirmar",
        result: "cambio_valor",
        reason: JSON.stringify({
          antes: { valor: oldValor, external_id: externalId },
          despues: { valor: newValor, external_id: newIdV, transportadora: chosen.name },
          via: "recreate",
        }).slice(0, 2000),
        store_id: storeId,
      });
      if (auditErrV) console.error("[apply_value] audit insert failed:", auditErrV);

      return jsonOk({
        ok: true,
        valorApplied: true,
        method: "recreate",
        oldReplaced: replacedV.ok && !guardV.oldAlive,
        externalId: newIdV,
        oldExternalId: externalId,
        valor: newValor,
        transportadora: chosen.name,
        dropiHttpStatus: dropiStatusV,
        ...(duplicatesAliveV.length ? { duplicatesAlive: duplicatesAliveV } : {}),
        ...(warningV ? { warning: warningV } : {}),
      });
    }

    // ======================== MODE: APPLY_EDIT =========================
    // EdiciÃ³n combinada estilo panel Dropi en UNA sola recreaciÃ³n: transportadora
    // y/o lÃ­neas (cantidad/precio) y/o valor total. Reusa la mecÃ¡nica verificada
    // de apply/apply_value (create-with-edit: cancela la vieja + crea la nueva +
    // actualiza la MISMA fila local + audita). ADITIVO: no toca apply ni
    // apply_value. Si el server corre una versiÃ³n vieja, este mode cae a quote
    // (read-only, no muta) y el cliente lo detecta por la ausencia de
    // `editApplied:true` â€” seguro por construcciÃ³n.
    if (mode === "apply_edit") {
      const dcIdRaw = body.distributionCompanyId;
      const dcName = String(body.name || "").trim();
      const hasCarrier = dcIdRaw != null && dcIdRaw !== "" && !!dcName;
      const newValorE = body.newValor != null && body.newValor !== ""
        ? Number(body.newValor)
        : null;
      if (newValorE !== null && (!Number.isFinite(newValorE) || newValorE <= 0)) {
        return jsonOk({ ok: false, error: "Valor nuevo invÃ¡lido (debe ser un nÃºmero mayor a 0)." });
      }
      const wantsLines = Array.isArray(body.newLines) && body.newLines.length > 0;
      if (!hasCarrier && !wantsLines && newValorE === null) {
        return jsonOk({ ok: false, error: "Sin cambios: mandÃ¡ transportadora, lÃ­neas o valor nuevo." });
      }
      const oldValorE = Number(orderRow.valor) || 0;

      try {
        cfg.sessionToken = await ensureFreshSessionToken(sbAdmin, cfg);
      } catch (e) {
        if (e instanceof WebFallbackError) return jsonOk({ ok: false, error: e.message });
        throw e;
      }

      const prepE = await resolveClientAndLines(cfg, orderRow, externalId);
      if (!prepE.ok) {
        return jsonOk({ ok: false, error: prepE.error, ...(prepE.dropiBody ? { dropiBody: prepE.dropiBody } : {}) });
      }
      const clientE = prepE.client;

      // LÃ­neas finales: editadas (validadas: mismo set de dropiIds, sin agregar/
      // quitar) > escaladas si solo vino valor nuevo > las reales tal cual.
      let linesE: LineDetail[];
      if (wantsLines) {
        const sanitized = sanitizeLinesOverride(body.newLines, prepE.lines);
        if (!sanitized) {
          return jsonOk({
            ok: false,
            error: "Las lÃ­neas editadas no coinciden con las del pedido (mismos productos, cantidad entera 1-1000, precio â‰¥0; no se puede agregar/quitar lÃ­neas). ReabrÃ­ el editor para recargarlas.",
          });
        }
        linesE = sanitized;
      } else if (newValorE !== null) {
        linesE = scaleLinePrices(prepE.lines, newValorE, cfg.countryCode);
      } else {
        linesE = prepE.lines;
      }
      // Total final: el valor explÃ­cito manda; si no, la suma de las lÃ­neas.
      const totalE = newValorE !== null
        ? newValorE
        : roundMoney(linesE.reduce((s, l) => s + l.price * l.quantity, 0), cfg.countryCode);

      const countryE = cfg.countryCode === "EC" ? "ECUADOR" : "COLOMBIA";
      let destCityE;
      try {
        destCityE = await resolveDestCity(sbAdmin, cfg, cfg.countryCode, clientE.city, clientE.state);
      } catch (e) {
        if (e instanceof WebFallbackError) {
          return jsonOk({ ok: false, code: "dropi_error", error: e.message });
        }
        throw e;
      }
      if (!destCityE) {
        return jsonOk({
          ok: false,
          code: "sin_cobertura_dropi",
          error: noCoverageMessage(clientE.city, clientE.state),
          city: clientE.city, state: clientE.state,
        });
      }

      let ctxE;
      try {
        ctxE = await quoteCarriers(cfg, {
          country: countryE,
          city: clientE.city,
          state: clientE.state,
          destCity: destCityE,
          lines: linesE,
          total: totalE,
        });
      } catch (e) {
        if (e instanceof WebFallbackError) {
          return jsonOk({ ok: false, error: e.message, dropiBody: (e as WebFallbackError).body });
        }
        throw e;
      }

      // Transportadora: la elegida por la operadora VALIDADA contra las opciones
      // cotizadas (antes se mandaba id+name directos sin validar â†’ Dropi rechazaba
      // el create con "La ciudad no tiene habilitado el mÃ©todo de envÃ­o" o el
      // genÃ©rico "Error al crear la orden"; caso ECHEANDIA/LAARCOURIER 2026-07-09).
      // Si no vino carrier, la ACTUAL resuelta contra las options (patrÃ³n apply_value).
      let chosenE: { id: number | string; name: string; typeService: string; shippingAmount: number } | null = null;
      if (hasCarrier) {
        chosenE = findQuotedOption(ctxE.options, dcIdRaw as number | string, dcName);
        if (!chosenE) {
          return jsonOk({
            ok: false,
            code: "carrier_sin_cobertura",
            error: `${dcName} no cotiza envÃ­os a ${ctxE.dest.cityName} (${ctxE.dest.stateName}) para este pedido. Transportadoras disponibles: ${ctxE.options.map((o) => o.name).join(", ") || "ninguna"}. TocÃ¡ "Recotizar" y elegÃ­ una de la lista.`,
          });
        }
      }
      let warningE: string | undefined;
      if (!hasCarrier) {
        const currentNormE = normUp(orderRow.transportadora || "");
        chosenE =
          (currentNormE ? ctxE.options.find((op) => normUp(op.name) === currentNormE) : undefined) ??
          ctxE.options.find((op) => normUp(op.name) !== "VELOCES") ??
          ctxE.options[0] ?? null;
        // Aviso si la transportadora ACTUAL no cotizÃ³ y caÃ­mos a otra: el pedido
        // se recrea con una carrier distinta sin que la asesora lo pidiera.
        if (chosenE && currentNormE && normUp(chosenE.name) !== currentNormE) {
          warningE = `La transportadora actual ${orderRow.transportadora} no cotiza esta ruta; el pedido se recreÃ³ con ${chosenE.name} â€” verificÃ¡ SLA/tracking.`;
        }
      }
      if (!chosenE) {
        return jsonOk({ ok: false, error: "Dropi no devolviÃ³ transportadoras para recrear el pedido." });
      }

      const userIdE = decodeJwtSub(cfg.sessionToken);
      const orderBodyE: Record<string, unknown> = {
        total_order: totalE,
        notes: clientE.notes || "",
        name: clientE.name,
        surname: clientE.surname || "",
        dir: clientE.dir,
        country: countryE,
        state: ctxE.dest.stateName,
        city: ctxE.dest.cityName,
        phone: clientE.phone,
        client_email: clientE.email || "",
        payment_method_id: 1,
        user_id: userIdE,
        supplier_id: ctxE.supplierId,
        type: "FINAL_ORDER",
        rate_type: clientE.rateType || "CON RECAUDO",
        products: ctxE.products.map((p) => ({
          id: p.dropiId, uid: p.dropiId, quantity: p.quantity, price: p.price, type: p.productType,
        })),
        distributionCompany: { id: chosenE.id, name: chosenE.name },
        // Paridad con el create web QUE FUNCIONA (shopify-push createOrderViaWeb):
        // type_service real cotizado (no "normal" hardcodeado), shipping_amount de
        // la opciÃ³n elegida, y nulls donde el panel manda null (no "").
        type_service: chosenE.typeService || "normal",
        shipping_amount: chosenE.shippingAmount,
        zip_code: null,
        colonia: "",
        shop_id: clientE.shopId ?? null,
        dni: "",
        dni_type: null,
        insurance: false,
        shalom_data: null,
        warehouses_selected_id: ctxE.origin.warehouseId,
        // Flags de EDICIÃ“N (verificados en vivo) â€” cancelan la vieja + linkean la nueva.
        is_edit_order: true,
        id_old_order: Number(externalId),
        shop_order_id: clientE.shopOrderId || "",
        shop_order_number: "",
        reasonComment: `Esta orden reemplaza a la orden ${externalId}: ediciÃ³n desde el CRM (transportadora/cantidades/valor).`,
      };

      let newIdE: string | null = null;
      let dropiStatusE = 0;
      try {
        const postE = await postCreateWithEdit(cfg, sbAdmin, {
          orderBody: orderBodyE, userId: user.id, storeId, label: "Dropi rechazÃ³ la ediciÃ³n",
        });
        dropiStatusE = postE.status;
        // `=== false` (no `!ok`): narrowing robusto tambiÃ©n sin strict mode.
        if (postE.ok === false) {
          if (postE.code === "orden_ya_enviada") {
            const sibsE = await findActiveSiblings(cfg, {
              phone: String(orderRow.phone || clientE.phone || ""),
              clientName: `${clientE.name} ${clientE.surname || ""}`,
              excludeId: externalId,
            });
            const sibTxtE = sibsE.length
              ? ` Orden(es) activa(s) del cliente en Dropi: ${sibsE.map((s) => `#${s.id} (${s.status}${s.total ? `, $${s.total}` : ""})`).join(", ")}.`
              : "";
            // Auto-retiro SOLO con evidencia positiva: v2 dice muerto Y hay hermana viva.
            const retiredStubE = await retireBotStubIfGone(cfg, sbAdmin, externalId, String(orderRow.id), sibsE.length, String(orderRow.phone || clientE.phone || ""));
            return jsonOk({
              ok: false,
              code: "orden_ya_enviada",
              error: `Dropi bloqueÃ³ la ediciÃ³n: esta compra ya fue reenviada dentro de Dropi y recrearla generarÃ­a un pedido DUPLICADO (doble envÃ­o al cliente).${sibTxtE} GestionÃ¡ la orden activa del cliente; acÃ¡ no se creÃ³ ni cambiÃ³ nada.${retiredStubE ? " Este pedido era el BORRADOR del bot de Dropi y se retirÃ³ de la cola automÃ¡ticamente â€” gestionÃ¡ la orden activa del cliente." : ""}`,
              dropiHttpStatus: postE.status,
              dropiBody: postE.respBody,
              ...(sibsE[0] ? { activeSibling: { externalId: sibsE[0].id, estado: sibsE[0].status, total: sibsE[0].total } } : {}),
              siblings: sibsE.map((s) => ({ externalId: s.id, estado: s.status })),
              ...(retiredStubE ? { retiredStub: true } : {}),
            });
          }
          if (postE.code === "created_sin_id" || postE.code === "post_incierto") {
            const rec = await recoverUncertainCreate(cfg, sbAdmin, {
              phone: String(orderRow.phone || clientE.phone || ""),
              clientName: `${clientE.name} ${clientE.surname || ""}`,
              oldId: externalId,
              expectedTotal: totalE,
              storeId,
              userId: user.id,
              label: "EdiciÃ³n del pedido",
            });
            if (!rec) {
              return jsonOk({
                ok: false,
                code: "creacion_incierta",
                error: "Resultado INCIERTO: Dropi pudo haber creado la orden nueva pero no la pude identificar. NO reintentes la ediciÃ³n â€” verificÃ¡ en el panel de Dropi o esperÃ¡ el prÃ³ximo sync (â‰¤5 min) y refrescÃ¡.",
                dropiHttpStatus: postE.status,
                dropiBody: postE.respBody,
              });
            }
            newIdE = rec.newId;
          } else {
            return jsonOk({
              ok: false,
              error: `Dropi rechazÃ³ la ediciÃ³n del pedido [${postE.status}]: ${postE.detail}`,
              dropiHttpStatus: postE.status,
              dropiBody: postE.respBody,
            });
          }
        } else {
          newIdE = postE.newId;
        }
      } catch (e) {
        if (e instanceof WebFallbackError) {
          return jsonOk({ ok: false, error: e.message, dropiHttpStatus: (e as WebFallbackError).status, dropiBody: (e as WebFallbackError).body });
        }
        throw e;
      }

      // Paridad panel: soft-borrar la orden vieja (REEMPLAZADA) para que no quede
      // duplicada en Dropi ni la re-importe el cron.
      const replacedE = await markOldOrderReplaced(cfg, externalId);

      // Sincronizar la fila Guardian EN SU LUGAR (mismo dbId) â€” mismo patrÃ³n y
      // manejo de carrera 23505 que apply/apply_value.
      let auditOrderIdE: string = String(orderRow.id);
      const { error: updErrE } = await sbAdmin
        .from("orders")
        .update({
          external_id: newIdE,
          transportadora: chosenE.name,
          valor: totalE,
          cantidad: linesE.reduce((s, l) => s + (l.quantity || 1), 0),
        })
        .eq("id", orderRow.id);
      if (updErrE) {
        console.error("[apply_edit] local update failed:", updErrE);
        let updWarnE: string;
        if ((updErrE as { code?: string }).code === "23505") {
          // Carrera con el cron: la orden nueva ya existe como fila propia. La
          // vieja queda REEMPLAZADA (no CANCELADO) y la auditorÃ­a va a la nueva.
          const dupE = await absorbCronDuplicate(sbAdmin, {
            newId: String(newIdE), storeId, rowId: String(orderRow.id),
            lockedBy: (orderRow as { locked_by?: string | null }).locked_by,
            lockedAt: (orderRow as { locked_at?: string | null }).locked_at,
          });
          updWarnE = dupE.warning;
          if (dupE.auditOrderId) auditOrderIdE = dupE.auditOrderId;
        } else {
          updWarnE = `El cambio se aplicÃ³ en Dropi (nuevo id ${newIdE}) pero no pude actualizar la fila local: ${updErrE.message}. Puede aparecer un duplicado hasta el prÃ³ximo sync.`;
        }
        warningE = warningE ? `${warningE} ${updWarnE}` : updWarnE;
      }

      // VerificaciÃ³n + tumba anti-reimport (corre SIEMPRE, tambiÃ©n con PUT ok).
      const guardE = await guardReplacedOldOrder(cfg, sbAdmin, {
        replaced: replacedE, externalId, newId: String(newIdE), rowId: String(orderRow.id), storeId, userId: user.id,
        phone: String(orderRow.phone || clientE.phone || ""), budgetLeft,
      });
      if (guardE.warning) warningE = warningE ? `${warningE} ${guardE.warning}` : guardE.warning;

      // Barrido de hermanas vivas (forwarding de Dropi) â€” exactamente UNO vivo.
      const sweepE = await sweepStraySiblings(cfg, sbAdmin, {
        phone: String(orderRow.phone || clientE.phone || ""),
        clientName: `${clientE.name} ${clientE.surname || ""}`,
        newId: String(newIdE), oldId: externalId, storeId,
        knownTotals: [oldValorE, totalE], budgetLeft,
      });
      const duplicatesAliveE = [
        ...(guardE.oldAlive ? [guardE.oldAlive] : []),
        ...sweepE.leftovers,
      ];
      if (sweepE.skippedByBudget) {
        warningE = `${warningE ? warningE + " " : ""}No alcancÃ© a barrer duplicados del cliente â€” revisÃ¡ el panel de Dropi.`;
      }
      if (duplicatesAliveE.length) {
        const dupTxtE = `DUPLICADO VIVO en Dropi: ${duplicatesAliveE.map((d) => `#${d.externalId} (${d.estado})`).join(", ")} â€” cancelalo para evitar doble envÃ­o.`;
        if (!warningE || !warningE.includes("DUPLICADO VIVO")) {
          warningE = warningE ? `${warningE} ${dupTxtE}` : dupTxtE;
        }
        if (sweepE.leftovers.length) {
          try {
            await sbAdmin.from("order_results").insert({
              order_id: auditOrderIdE, store_id: storeId, operator_id: user.id,
              phone: String(orderRow.phone || clientE.phone || ""),
              result: "edicion_orden", dropi_sync_status: "failed",
              result_notes: ("EDICIÃ“N: " + dupTxtE).slice(0, 300),
            });
            await sbAdmin.from("sync_logs").insert({
              source: "dropi-change-carrier", status: "error",
              synced_count: 0, duplicates_count: 0, total_count: 1, triggered_by: user.id,
              error_message: `Barrido post-ediciÃ³n: quedaron duplicados vivos ${sweepE.leftovers.map((d) => `#${d.externalId} (${d.estado})`).join(", ")} tras crear ${newIdE} (viejo ${externalId}).`,
              store_id: storeId,
            });
          } catch (e) { console.error("[apply_edit] persistencia de duplicados vivos fallÃ³:", e); }
        }
      }

      const { error: auditErrE } = await sbAdmin.from("order_results").insert({
        order_id: auditOrderIdE,
        phone: String(orderRow.phone || clientE.phone || ""),
        operator_id: user.id,
        module: "confirmar",
        result: "edicion_completa",
        reason: JSON.stringify({
          antes: { valor: oldValorE, external_id: externalId, transportadora: orderRow.transportadora || "" },
          despues: {
            valor: totalE,
            external_id: newIdE,
            transportadora: chosenE.name,
            lines: linesE.map((l) => ({ id: l.dropiId, q: l.quantity, p: l.price })),
          },
          via: "recreate",
        }).slice(0, 2000),
        store_id: storeId,
      });
      if (auditErrE) console.error("[apply_edit] audit insert failed:", auditErrE);

      return jsonOk({
        ok: true,
        editApplied: true,
        method: "recreate",
        oldReplaced: replacedE.ok && !guardE.oldAlive,
        externalId: newIdE,
        oldExternalId: externalId,
        transportadora: chosenE.name,
        valor: totalE,
        dropiHttpStatus: dropiStatusE,
        ...(duplicatesAliveE.length ? { duplicatesAlive: duplicatesAliveE } : {}),
        ...(warningE ? { warning: warningE } : {}),
      });
    }

    // =========================== MODE: APPLY ===========================
    // Create-with-edit: cancela la orden vieja + crea una nueva (nuevo external_id)
    // con la transportadora ELEGIDA. Nunca rompe la card: cualquier fallo devuelve
    // jsonOk({ ok:false, ... }) con el body crudo de Dropi para diagnosticar.
    const distributionCompanyId = body.distributionCompanyId;
    const name = String(body.name || "").trim();
    if (distributionCompanyId == null || distributionCompanyId === "") {
      return jsonOk({ ok: false, error: "Falta distributionCompanyId" });
    }
    if (!name) {
      return jsonOk({ ok: false, error: "Falta el nombre de la transportadora elegida (name)." });
    }

    const country = cfg.countryCode === "EC" ? "ECUADOR" : "COLOMBIA";

    // 1) Detalle del cliente + lÃ­neas (prep compartida con apply_value).
    const prep = await resolveClientAndLines(cfg, orderRow, externalId);
    if (!prep.ok) {
      return jsonOk({ ok: false, error: prep.error, ...(prep.dropiBody ? { dropiBody: prep.dropiBody } : {}) });
    }
    const client = prep.client;
    const lines = prep.lines;

    // 2) Ciudad destino: catÃ¡logo local + fallback vivo (que LANZA con errores
    //    reales â€” token/red â€” en vez de devolver null "sin cobertura" falso).
    let destCity;
    try {
      destCity = await resolveDestCity(sbAdmin, cfg, cfg.countryCode, client.city, client.state);
    } catch (e) {
      if (e instanceof WebFallbackError) {
        return jsonOk({ ok: false, code: "dropi_error", error: e.message });
      }
      throw e;
    }
    if (!destCity) {
      return jsonOk({
        ok: false,
        code: "sin_cobertura_dropi",
        error: noCoverageMessage(client.city, client.state),
        city: client.city, state: client.state,
      });
    }

    // 3) Cotizar (reusa quoteCarriers) para obtener origin.warehouseId, supplierId,
    //    dest.stateName/cityName y el productType por producto. destino ya resuelto.
    const total = Number(orderRow.valor) || lines.reduce((s, l) => s + l.price * l.quantity, 0);
    let ctx;
    try {
      ctx = await quoteCarriers(cfg, {
        country,
        city: client.city,
        state: client.state,
        destCity,
        lines,
        total,
      });
    } catch (e) {
      if (e instanceof WebFallbackError) {
        return jsonOk({ ok: false, error: e.message, dropiBody: (e as WebFallbackError).body });
      }
      throw e;
    }
    const { dest, origin, products, supplierId } = ctx;

    // 3b) Validar la transportadora ELEGIDA contra las opciones cotizadas â€” si no
    //     cotiza esta ruta, Dropi rechazarÃ­a el create (a veces con el genÃ©rico
    //     "Error al crear la orden"). Error claro y accionable ANTES del POST.
    const chosenA = findQuotedOption(ctx.options, distributionCompanyId as number | string, name);
    if (!chosenA) {
      return jsonOk({
        ok: false,
        code: "carrier_sin_cobertura",
        error: `${name} no cotiza envÃ­os a ${dest.cityName} (${dest.stateName}) para este pedido. Transportadoras disponibles: ${ctx.options.map((o) => o.name).join(", ") || "ninguna"}.`,
      });
    }

    // 4) Construir el body de create-with-edit (idÃ©ntico al create + flags de ediciÃ³n).
    //    distributionCompany = la transportadora ELEGIDA (NO la mÃ¡s barata â‰  VELOCES).
    const userId = decodeJwtSub(cfg.sessionToken);
    const idOldOrder = Number(externalId);
    const orderBody: Record<string, unknown> = {
      total_order: total,
      notes: client.notes || "",
      name: client.name,
      surname: client.surname || "",
      dir: client.dir,
      country,
      state: dest.stateName,
      city: dest.cityName,
      phone: client.phone,
      client_email: client.email || "",
      payment_method_id: 1,
      user_id: userId,
      supplier_id: supplierId,
      type: "FINAL_ORDER",
      rate_type: client.rateType || "CON RECAUDO",
      products: products.map((p) => ({
        id: p.dropiId, uid: p.dropiId, quantity: p.quantity, price: p.price, type: p.productType,
      })),
      distributionCompany: { id: chosenA.id, name: chosenA.name },
      // Paridad con el create web QUE FUNCIONA (shopify-push createOrderViaWeb).
      type_service: chosenA.typeService || "normal",
      shipping_amount: chosenA.shippingAmount,
      zip_code: null,
      colonia: "",
      shop_id: client.shopId ?? null,
      dni: "",
      dni_type: null,
      insurance: false,
      shalom_data: null,
      warehouses_selected_id: origin.warehouseId,
      // Flags de EDICIÃ“N (verificados en vivo) â€” cancelan la vieja + linkean la nueva.
      is_edit_order: true,
      id_old_order: idOldOrder,
      shop_order_id: client.shopOrderId || "",
      shop_order_number: "",
      reasonComment: `Esta orden reemplaza a la orden ${externalId} que fue editada por el usuario.`,
    };

    // 5) POST /api/orders/myorders (session token vÃ­a dropiWebFetch sobre cfg.base).
    let newExternalId: string | null = null;
    let dropiHttpStatus = 0;
    try {
      const postA = await postCreateWithEdit(cfg, sbAdmin, {
        orderBody, userId: user.id, storeId, label: "Dropi rechazÃ³ el cambio",
      });
      dropiHttpStatus = postA.status;
      // `=== false` (no `!ok`): narrowing robusto tambiÃ©n sin strict mode.
      if (postA.ok === false) {
        if (postA.code === "orden_ya_enviada") {
          const sibsA = await findActiveSiblings(cfg, {
            phone: String(orderRow.phone || client.phone || ""),
            clientName: `${client.name} ${client.surname || ""}`,
            excludeId: externalId,
          });
          const sibTxtA = sibsA.length
            ? ` Orden(es) activa(s) del cliente en Dropi: ${sibsA.map((s) => `#${s.id} (${s.status}${s.total ? `, $${s.total}` : ""})`).join(", ")}.`
            : "";
          // Auto-retiro SOLO con evidencia positiva: v2 dice muerto Y hay hermana viva.
          const retiredStubA = await retireBotStubIfGone(cfg, sbAdmin, externalId, String(orderRow.id), sibsA.length, String(orderRow.phone || client.phone || ""));
          return jsonOk({
            ok: false,
            code: "orden_ya_enviada",
            error: `Dropi bloqueÃ³ el cambio: esta compra ya fue reenviada dentro de Dropi y recrearla generarÃ­a un pedido DUPLICADO (doble envÃ­o al cliente).${sibTxtA} GestionÃ¡ la orden activa del cliente; acÃ¡ no se creÃ³ ni cambiÃ³ nada.${retiredStubA ? " Este pedido era el BORRADOR del bot de Dropi y se retirÃ³ de la cola automÃ¡ticamente â€” gestionÃ¡ la orden activa del cliente." : ""}`,
            dropiHttpStatus: postA.status,
            dropiBody: postA.respBody,
            ...(sibsA[0] ? { activeSibling: { externalId: sibsA[0].id, estado: sibsA[0].status, total: sibsA[0].total } } : {}),
            siblings: sibsA.map((s) => ({ externalId: s.id, estado: s.status })),
            ...(retiredStubA ? { retiredStub: true } : {}),
          });
        }
        if (postA.code === "created_sin_id" || postA.code === "post_incierto") {
          const rec = await recoverUncertainCreate(cfg, sbAdmin, {
            phone: String(orderRow.phone || client.phone || ""),
            clientName: `${client.name} ${client.surname || ""}`,
            oldId: externalId,
            expectedTotal: total,
            storeId,
            userId: user.id,
            label: "Cambio de transportadora",
          });
          if (!rec) {
            return jsonOk({
              ok: false,
              code: "creacion_incierta",
              error: "Resultado INCIERTO: Dropi pudo haber creado la orden nueva pero no la pude identificar. NO reintentes la ediciÃ³n â€” verificÃ¡ en el panel de Dropi o esperÃ¡ el prÃ³ximo sync (â‰¤5 min) y refrescÃ¡.",
              dropiHttpStatus: postA.status,
              dropiBody: postA.respBody,
            });
          }
          newExternalId = rec.newId;
        } else {
          return jsonOk({
            ok: false,
            error: `Dropi rechazÃ³ el cambio de transportadora [${postA.status}]: ${postA.detail}`,
            dropiHttpStatus: postA.status,
            dropiBody: postA.respBody,
          });
        }
      } else {
        newExternalId = postA.newId;
      }
    } catch (e) {
      if (e instanceof WebFallbackError) {
        return jsonOk({ ok: false, error: e.message, dropiHttpStatus: (e as WebFallbackError).status, dropiBody: (e as WebFallbackError).body });
      }
      throw e;
    }

    // 4b) Paridad panel: soft-borrar la orden vieja (REEMPLAZADA) para que no quede
    //     duplicada en Dropi ni la re-importe el cron.
    const replacedA = await markOldOrderReplaced(cfg, externalId);

    // 5) Sincronizar la fila Guardian EN SU LUGAR (mismo dbId): external_id â†’ nuevo id,
    //    transportadora â†’ nuevo nombre. Sin esto, el nightly-reconcile crearÃ­a un
    //    duplicado (nuevo id como INSERT) y dejarÃ­a el viejo huÃ©rfano.
    let warning: string | undefined;
    let auditOrderIdA: string = String(orderRow.id);
    const { error: updErr } = await sbAdmin
      .from("orders")
      .update({ external_id: newExternalId, transportadora: chosenA.name })
      .eq("id", orderRow.id);
    if (updErr) {
      console.error("[dropi-change-carrier] local external_id/transportadora update failed:", updErr);
      if ((updErr as { code?: string }).code === "23505") {
        // Carrera con el cron: orders.external_id tiene UNIQUE GLOBAL y el sync ya
        // insertÃ³ la orden nueva como fila propia en los segundos entre el create en
        // Dropi y este UPDATE. La fila vieja quedÃ³ obsoleta (Dropi la cancelÃ³):
        // queda REEMPLAZADA (no CANCELADO â€” cancelaciÃ³n fantasma en mÃ©tricas) y
        // la auditorÃ­a se redirige a la fila NUEVA.
        const dupA = await absorbCronDuplicate(sbAdmin, {
          newId: String(newExternalId), storeId, rowId: String(orderRow.id),
          lockedBy: (orderRow as { locked_by?: string | null }).locked_by,
          lockedAt: (orderRow as { locked_at?: string | null }).locked_at,
        });
        warning = dupA.warning;
        if (dupA.auditOrderId) auditOrderIdA = dupA.auditOrderId;
      } else {
        warning = `El cambio se aplicÃ³ en Dropi (nuevo id ${newExternalId}) pero no pude actualizar la fila local: ${updErr.message}. Puede aparecer un duplicado hasta el prÃ³ximo sync.`;
      }
    }

    // VerificaciÃ³n + tumba anti-reimport (corre SIEMPRE, tambiÃ©n con PUT ok).
    const guardA = await guardReplacedOldOrder(cfg, sbAdmin, {
      replaced: replacedA, externalId, newId: String(newExternalId), rowId: String(orderRow.id), storeId, userId: user.id,
      phone: String(orderRow.phone || client.phone || ""), budgetLeft,
    });
    if (guardA.warning) warning = warning ? `${warning} ${guardA.warning}` : guardA.warning;

    // Barrido de hermanas vivas (forwarding de Dropi) â€” exactamente UNO vivo.
    const sweepA = await sweepStraySiblings(cfg, sbAdmin, {
      phone: String(orderRow.phone || client.phone || ""),
      clientName: `${client.name} ${client.surname || ""}`,
      newId: String(newExternalId), oldId: externalId, storeId,
      knownTotals: [Number(orderRow.valor) || 0, total], budgetLeft,
    });
    const duplicatesAliveA = [
      ...(guardA.oldAlive ? [guardA.oldAlive] : []),
      ...sweepA.leftovers,
    ];
    if (sweepA.skippedByBudget) {
      warning = `${warning ? warning + " " : ""}No alcancÃ© a barrer duplicados del cliente â€” revisÃ¡ el panel de Dropi.`;
    }
    if (duplicatesAliveA.length) {
      const dupTxtA = `DUPLICADO VIVO en Dropi: ${duplicatesAliveA.map((d) => `#${d.externalId} (${d.estado})`).join(", ")} â€” cancelalo para evitar doble envÃ­o.`;
      if (!warning || !warning.includes("DUPLICADO VIVO")) {
        warning = warning ? `${warning} ${dupTxtA}` : dupTxtA;
      }
      if (sweepA.leftovers.length) {
        try {
          await sbAdmin.from("order_results").insert({
            order_id: auditOrderIdA, store_id: storeId, operator_id: user.id,
            phone: String(orderRow.phone || client.phone || ""),
            result: "edicion_orden", dropi_sync_status: "failed",
            result_notes: ("EDICIÃ“N: " + dupTxtA).slice(0, 300),
          });
          await sbAdmin.from("sync_logs").insert({
            source: "dropi-change-carrier", status: "error",
            synced_count: 0, duplicates_count: 0, total_count: 1, triggered_by: user.id,
            error_message: `Barrido post-ediciÃ³n: quedaron duplicados vivos ${sweepA.leftovers.map((d) => `#${d.externalId} (${d.estado})`).join(", ")} tras crear ${newExternalId} (viejo ${externalId}).`,
            store_id: storeId,
          });
        } catch (e) { console.error("[apply] persistencia de duplicados vivos fallÃ³:", e); }
      }
    }

    // AuditorÃ­a del reemplazo (incluye oldâ†’new external id para trazabilidad).
    const auditPayload = {
      antes: { external_id: externalId, transportadora: orderRow.transportadora || "" },
      despues: { external_id: newExternalId, transportadora: chosenA.name },
    };
    const { error: auditErr } = await sbAdmin.from("order_results").insert({
      order_id: auditOrderIdA,
      phone: String(orderRow.phone || client.phone || ""),
      operator_id: user.id,
      module: "confirmar",
      result: "cambio_transportadora",
      reason: JSON.stringify(auditPayload).slice(0, 2000),
      store_id: storeId,
    });
    if (auditErr) console.error("[dropi-change-carrier] audit insert failed:", auditErr);

    return jsonOk({
      ok: true,
      oldReplaced: replacedA.ok && !guardA.oldAlive,
      externalId: newExternalId,
      oldExternalId: externalId,
      transportadora: chosenA.name,
      dropiHttpStatus,
      ...(duplicatesAliveA.length ? { duplicatesAlive: duplicatesAliveA } : {}),
      ...(warning ? { warning } : {}),
    });
  } catch (err) {
    console.error("dropi-change-carrier error:", err);
    const msg = err instanceof Error ? err.message : "Error interno";
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// Núcleo compartido de la CANCELACIÓN de pedidos en Dropi (FASE 3).
//
// Extraído 1:1 del branch mode:"cancel" de dropi-change-carrier (verificado
// e2e 2026-07-08) para que el cron pueda REINTENTAR cancelaciones fallidas
// con la misma mecánica exacta. Comportamiento:
//
//   (a) Orden VIVA en Dropi → PUT /api/orders/myorders/{id} {status:"CANCELADO",
//       reasonComment} (mismo request del "Cancelar orden" del panel, session
//       token web) + marca orders.estado='CANCELADO' local. → canceled:true.
//   (b) FANTASMA (el PUT falla, un GET de integración da 404 Y el canal WEB
//       confirma la muerte por teléfono): se cancela SOLO local.
//       → canceled:true + dropiMissing:true.
//   (c) Orden viva pero Dropi rechaza → ok:false + code:"dropi_rejected".
//
// FIX #6 (2026-07-14) — el 404 de integración YA NO es prueba de muerte: los
// pedidos clase-bot (LucidBot / "reenviados a dropiX") dan 404 por-id AUNQUE
// estén VIVOS en el panel (mismo criterio que guardReplacedOldOrder /
// retireBotStubIfGone ya abandonaron). Un PUT web transitorio fallido (session
// token vencido ~1h) sobre un bot VIVO marcaría CANCELADO local un FALSO
// fantasma. Por eso, antes de declarar fantasma, se confirma por el canal WEB
// (checkOrderLivenessWeb, listado por TELÉFONO): SOLO state==='dead' es
// fantasma; 'unknown'/'alive' → se devuelve el fallo real para reintentar (no
// se toca el estado local). Sesgo conservador: mejor un cancel que se reintenta
// (barato) que un falso fantasma que esconde un pedido vivo → doble envío.
//
// El caller es responsable de tener cfg.sessionToken FRESCO
// (ensureFreshSessionToken) — acá no se renueva nada.

// deno-lint-ignore-file no-explicit-any
import { dropiWebFetch } from "./dropiWebQuote.ts";
import { checkOrderLivenessWeb } from "./dropiOrderLiveness.ts";

/** Config mínima para cancelar: panel web (base+sessionToken+storeUrl) +
 *  integration-key (apiKey) para el check de existencia del fantasma.
 *  StoreDropiConfig (dropiStoreConfig.ts) satisface este shape. */
export interface CancelDropiCfg {
  base: string;
  apiKey: string;
  storeUrl: string;
  sessionToken: string;
}

export interface CancelOrderParams {
  /** external_id del pedido en Dropi. */
  externalId: string;
  /** orders.id (uuid) de la fila Guardian — para el UPDATE local CANCELADO. */
  orderId: string;
  /** Solo para logging/diagnóstico. */
  storeId: string;
  /** Motivo (va en reasonComment del PUT). Vacío → default del CRM. */
  reason?: string;
}

/** Resultado discriminado — MISMO shape que la respuesta del branch
 *  mode:"cancel" (el cliente depende de canceled===true / dropiMissing /
 *  code:"dropi_rejected"): el branch puede devolverlo tal cual vía jsonOk. */
export type CancelOrderResult =
  | { ok: true; canceled: true; externalId: string; dropiStatus: number }
  | { ok: true; canceled: true; dropiMissing: true; externalId: string; note: string }
  | { ok: false; code: "dropi_rejected"; dropiStatus: number; error: string };

/** GET de UN pedido por su id externo (integration-key) — check de existencia
 *  para distinguir fantasma de rechazo real. Copia local del helper de
 *  dropi-change-carrier (no se puede importar: es privado de ese archivo).
 *  Exportado: dropi-cron lo usa para confirmar stubs de bot (pares). */
export async function dropiGetOrder(
  base: string,
  apiKey: string,
  storeUrl: string,
  externalId: string,
): Promise<{ ok: boolean; httpStatus: number; body: Record<string, unknown> }> {
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
  return { ok, httpStatus: res.status, body };
}

/** Señal de "no existe": 404 explícito o el mensaje textual de Dropi.
 *  Variantes reales: "Orden no encontrada", "no encontrado" y "No se encontró
 *  registro" (esta última probada en vivo 2026-07-12 con un PUT a un stub — el
 *  regex viejo /no encontrada|.../ NO la matcheaba). NO usar status 400 a
 *  secas — un bad-request genérico NO es fantasma. Sigue exigiendo httpStatus
 *  404 O isSuccess:false con (status 404 o mensaje de esta clase). Exportada
 *  para el resolvedor de pares del cron. */
export function notFoundSignal(httpStatus: number, b: Record<string, unknown>): boolean {
  return httpStatus === 404 ||
    (b.isSuccess === false &&
      (Number(b.status) === 404 ||
        /no (se )?encontr|no existe|not found/i.test(String(b.message || ""))));
}

/**
 * Cancela DE VERDAD un pedido en Dropi + marca orders.estado='CANCELADO'
 * local según el caso (viva-cancelada o fantasma). NUNCA lanza por fallos de
 * Dropi (los devuelve como resultado); sí puede propagar errores inesperados
 * del entorno (p.ej. red caída en el UPDATE local no — ese se loguea).
 */
export async function cancelOrderInDropi(
  cfg: CancelDropiCfg,
  // Cliente service-role (el UPDATE local no depende de RLS).
  sbAdmin: any,
  params: CancelOrderParams,
): Promise<CancelOrderResult> {
  const { externalId, orderId, storeId } = params;
  const reasonComment = String(params.reason || "").trim() ||
    "Cancelado desde el CRM (gestión de confirmación).";

  const markLocalCanceled = async () => {
    const { error: updErr } = await sbAdmin
      .from("orders").update({ estado: "CANCELADO" }).eq("id", orderId);
    if (updErr) console.error(`[dropi-cancel] UPDATE local CANCELADO falló (store ${storeId}):`, updErr.message);
  };

  // 1) Cancelar la orden VIVA en Dropi (PUT status=CANCELADO, mismo request del
  //    "Cancelar orden" del panel). Éxito → CANCELADO local (durable, inmediato).
  let put: { status: number; body?: Record<string, unknown> } | null = null;
  let putThrew: string | null = null;
  try {
    put = await dropiWebFetch(
      cfg, `/api/orders/myorders/${encodeURIComponent(externalId)}`,
      { method: "PUT", body: { status: "CANCELADO", reasonComment } },
    );
  } catch (e) {
    putThrew = e instanceof Error ? e.message.slice(0, 300) : "error";
    console.error("[dropi-cancel] PUT CANCELADO lanzó:", e);
  }
  const putOk = !!put && put.status >= 200 && put.status < 300 && put.body?.isSuccess !== false;
  if (putOk) {
    await markLocalCanceled();
    return { ok: true, canceled: true, externalId, dropiStatus: put!.status };
  }

  // 2) El PUT falló. ¿La orden es un FANTASMA (fue borrada/reemplazada en Dropi
  //    pero quedó atascada PENDIENTE en Guardian — Guardian solo upsertea, nunca
  //    borra al sincronizar)? El 404 de la API de INTEGRACIÓN es solo un HINT:
  //    los pedidos clase-bot dan 404 por-id AUNQUE estén VIVOS (ver FIX #6 en la
  //    cabecera). Antes de cancelar local hay que CONFIRMAR la muerte por el
  //    canal WEB (listado por teléfono). Sin ese segundo veredicto 'dead',
  //    NUNCA marcar CANCELADO local: se devuelve el fallo real para reintentar.
  let intMissing = false;
  try {
    const check = await dropiGetOrder(cfg.base, cfg.apiKey, cfg.storeUrl, externalId);
    intMissing = notFoundSignal(check.httpStatus, (check.body || {}) as Record<string, unknown>);
  } catch (e) {
    console.error("[dropi-cancel] check de existencia (integración) falló:", e);
  }

  if (intMissing) {
    // Segunda opinión por el canal WEB (session token), buscando por el TELÉFONO
    // del cliente. El teléfono sale del propio order row (sbAdmin, sin tocar los
    // call-sites). SOLO state==='dead' confirma el fantasma.
    let phone = "";
    try {
      const { data: ordRow } = await sbAdmin
        .from("orders").select("phone").eq("id", orderId).maybeSingle();
      phone = String(ordRow?.phone || "").trim();
    } catch (e) {
      console.error("[dropi-cancel] lectura de phone para liveness web falló:", e);
    }

    let confirmedDead = false;
    if (phone) {
      try {
        const live = await checkOrderLivenessWeb(cfg, externalId, { phone });
        confirmedDead = live.state === "dead";
        if (!confirmedDead) {
          // 'alive' o 'unknown' (p.ej. session token vencido → el listado web
          //  también falla): NO es prueba de muerte. No tocar el estado local.
          console.warn(
            `[dropi-cancel] #${externalId}: 404 integración pero liveness web='${live.state}' ` +
            `(${live.estado ?? "s/estado"}) — posible pedido bot VIVO; NO se cancela local, se reintenta.`,
          );
        }
      } catch (e) {
        console.error("[dropi-cancel] liveness web falló:", e);
      }
    } else {
      // Sin teléfono no hay segundo veredicto confiable. ÚLTIMO RECURSO: se
      // conserva el comportamiento viejo (404 integración ⇒ fantasma) para no
      // dejar fantasmas sin teléfono atascados para siempre, PERO se loguea el
      // riesgo de falso positivo (un bot vivo sin teléfono legible).
      confirmedDead = true;
      console.warn(
        `[dropi-cancel] #${externalId}: 404 integración y SIN teléfono para confirmar por web — ` +
        `se cancela local por el 404 (último recurso, RIESGO de falso fantasma si es un bot vivo).`,
      );
    }

    if (confirmedDead) {
      await markLocalCanceled();
      return {
        ok: true, canceled: true, dropiMissing: true, externalId,
        note: "La orden no existe para Dropi — se canceló localmente. Si reaparece en unos minutos, es un pedido del panel/bot de Dropi: cancelalo desde el panel.",
      };
    }
  }

  // 3) La orden EXISTE en Dropi pero rechazó la cancelación → fallo real. NO
  //    tocar el estado local (sigue viva) → el caller conserva su overlay y
  //    avisa "reintentar". Distinguir fantasma de fallo real evita esconder un
  //    pedido vivo Y evita dejar un fantasma atascado para siempre.
  return {
    ok: false, code: "dropi_rejected", dropiStatus: put?.status ?? 0,
    error: putThrew || String(put?.body?.message || put?.body?.error || "Dropi rechazó la cancelación").slice(0, 300),
  };
}

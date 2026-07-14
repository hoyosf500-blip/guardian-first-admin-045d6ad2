// Edge Function: dropi-update-order-full
//
// Update editable customer fields on a Dropi order (multi-tenant: resolves
// store from the order's external_id, uses that store's API key + país host).
//
// Contrato de errores (mismo patrón que dropi-change-carrier): los errores de
// DOMINIO (rechazo de Dropi, pedido no encontrado, tienda sin api key, fallo
// del UPDATE local con dropiAccepted) responden HTTP 200 con {ok:false, code?,
// error, ...} — con non-2xx, supabase-js v2 deja data=null y el motivo real
// quedaba enterrado en error.context (el cliente ahora también lo rescata vía
// parseInvoke, doble cobertura). Non-2xx queda SOLO para auth/CORS/malformed
// (401/403/400 tempranos).
//
// La auditoría en order_results ('edicion_orden') la inserta el CLIENTE
// (OrderEditorDialog) con dropi_sync_status 'pending' — y desde 2026-07-13
// (W1) el settle a 'synced'/'failed' lo hace ESTA función con service role en
// CADA outcome terminal, vía `auditId` del body: el UPDATE por JWT del
// cliente era un no-op silencioso (order_results sin política RLS de UPDATE)
// y toda edición quedaba 'pending' eterna → "Edición no aplicada" falso
// positivo en el panel. El cliente queda como respaldo solo para los 400/401
// tempranos (ahí la fila de auditoría ni siquiera existe todavía).
//
// FALLBACK WEB clase-bot (W3, 2026-07-13): si la integración responde
// "no encontrado" al PUT Y también al GET, el pedido es clase-bot (LucidBot /
// compra forwardeada): se intenta el PUT del panel web sobre el MISMO id y,
// si ese canal delata un STUB ("Error SQL desconocido"/no encontrado), se
// resuelve la hermana VIVA de la misma compra (shop_order_id) y se escriben
// los datos ahí + retarget de la fila local — el mismo rescate que la
// confirmación (_shared/dropiConfirmOrder.ts).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { loadStoreConfig, isStoreMember } from "../_shared/dropiStoreConfig.ts";
import { settleAuditRow, deriveSettleFromPayload } from "../_shared/settleAudit.ts";
import { notFoundSignal, dropiGetOrder } from "../_shared/dropiCancelOrder.ts";
import { resolveLiveSibling, retargetLocalOrder } from "../_shared/dropiConfirmOrder.ts";
import { ensureFreshSessionToken } from "../_shared/dropiSessionLogin.ts";
import { dropiWebFetch, WebFallbackError, normUp } from "../_shared/dropiWebQuote.ts";
import { dropiGetOrderV2Detail } from "../_shared/dropiOrderLiveness.ts";

interface EditPayload {
  externalId: string;
  nombre?: string;
  apellido?: string;
  phone?: string;
  ciudad?: string;
  departamento?: string;
  direccion?: string;
  email?: string;
  /** W1: id de la fila 'pending' de order_results que insertó el cliente —
   *  esta función la settlea server-side en cada outcome terminal. */
  auditId?: string;
  /** Diagnóstico crudo SOLO admin (mismo patrón que dropi-update-order):
   *  PUTs reales + detalle v2 antes/después, SIN update local, SIN settle
   *  y SIN sync_logs. */
  probe?: boolean;
}

function sanitizePhone(p: string): string {
  return (p || "").replace(/\D/g, "");
}
function isValidEmail(e: string): boolean {
  if (!e) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

interface DropiResult { ok: boolean; httpStatus: number; body: Record<string, unknown>; rawText: string; }

async function dropiPutCustomer(
  base: string,
  apiKey: string,
  storeUrl: string,
  externalId: string,
  payload: Record<string, unknown>,
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
      body: JSON.stringify(payload),
    },
  );
  const rawText = await res.text();
  let body: Record<string, unknown> = {};
  try { body = rawText ? JSON.parse(rawText) : {}; } catch { body = { raw: rawText }; }
  const ok = res.ok && body.isSuccess !== false;
  return { ok, httpStatus: res.status, body, rawText };
}

// Señal de STUB del canal WEB (distinta de notFoundSignal, que es de la
// integración — importada, NO duplicada): el PUT web a un stub forwardeado
// responde "Error SQL desconocido" o un no-encontrado (probado en vivo
// 2026-07-12, #6110807).
const STUB_SIGNAL_RE = /error sql desconocido|no (se )?encontr/i;

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);

  // W1 — settle server-authoritative: hoisted para que jsonOk y el catch
  // global los vean. Se asignan apenas se conocen user + auditId.
  // deno-lint-ignore no-explicit-any
  let sbAdmin: any = null;
  let settleId: string | null = null;
  let settleUserId = "";
  let probeMode = false;

  const jsonErr = (error: string, status: number) =>
    new Response(JSON.stringify({ ok: false, error }), {
      status, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  // Errores de dominio: HTTP 200 con ok:false para que invoke() entregue el
  // body en `data` (con non-2xx llega data=null y el motivo real se pierde).
  // W1: además, ANTES de responder, promueve la fila de auditoría 'pending'
  // con la MISMA semántica que el cliente (deriveSettleFromPayload) — cubre
  // not_found, noChange, no_api_key, dropi_rejected, db_update_failed y éxito.
  const jsonOk = async (payload: Record<string, unknown>): Promise<Response> => {
    if (!probeMode && settleId && sbAdmin) {
      const d = deriveSettleFromPayload(payload);
      await settleAuditRow(sbAdmin, settleId, settleUserId, d.status, d.notes);
    }
    return new Response(JSON.stringify(payload), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  };

  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonErr("No autorizado", 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;

    sbAdmin = createClient(supabaseUrl, serviceKey);
    const sbUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: authError } = await sbUser.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (authError || !userData?.user) return jsonErr("Token inválido", 401);
    const user = userData.user;

    let body: EditPayload;
    try { body = await req.json() as EditPayload; } catch { return jsonErr("Body inválido", 400); }

    probeMode = body.probe === true;

    // W1: apenas se conocen user + auditId queda armado el settle — cualquier
    // outcome terminal (jsonOk / 403 / catch global) promueve la fila
    // 'pending'. El probe NUNCA settlea (es una radiografía, no una gestión).
    const auditId = String(body.auditId || "").trim();
    if (auditId && !probeMode) {
      settleId = auditId;
      settleUserId = user.id;
    }

    const externalId = String(body.externalId || "").trim();
    if (!externalId) return jsonErr("Falta externalId", 400);

    const nombre = String(body.nombre || "").trim();
    const apellido = String(body.apellido || "").trim();
    const phone = sanitizePhone(String(body.phone || ""));
    const ciudad = String(body.ciudad || "").trim();
    const departamento = String(body.departamento || "").trim();
    const direccion = String(body.direccion || "").trim();
    const email = String(body.email || "").trim();

    if (!nombre) return jsonErr("Nombre obligatorio", 400);
    if (!direccion) return jsonErr("Dirección obligatoria", 400);
    if (!ciudad) return jsonErr("Ciudad obligatoria", 400);
    if (!departamento) return jsonErr("Departamento obligatorio", 400);
    if (phone && (phone.length < 7 || phone.length > 15)) return jsonErr("Teléfono inválido (7-15 dígitos)", 400);
    if (email && !isValidEmail(email)) return jsonErr("Email inválido", 400);

    const { data: orderRow, error: orderErr } = await sbAdmin
      .from("orders")
      .select("id, store_id, assigned_to, nombre, phone, ciudad, departamento, direccion, email, external_id")
      .eq("external_id", externalId)
      .maybeSingle();
    if (orderErr || !orderRow) {
      return jsonOk({ ok: false, code: "not_found", error: `Pedido ${externalId} no encontrado` });
    }

    const storeId = String((orderRow as { store_id: string }).store_id);
    const isMember = await isStoreMember(sbAdmin, user.id, storeId);
    if (!isMember) {
      // W1: acá ya se conocen settleId/user — settle explícito porque jsonErr
      // no settlea (queda reservado para los 400/401 tempranos sin fila).
      if (settleId) {
        await settleAuditRow(sbAdmin, settleId, settleUserId, "failed", "EDICIÓN falló: No perteneces a esta tienda");
      }
      return jsonErr("No perteneces a esta tienda", 403);
    }

    const fullName = apellido ? `${nombre} ${apellido}`.trim() : nombre;

    // Payload de la API de INTEGRACIÓN (PUT /integrations/orders/myorders/{id}).
    const dropiPayload: Record<string, unknown> = {
      name: nombre,
      surname: apellido || "",
      dir: direccion,
      city: ciudad,
      state: departamento,
    };
    if (phone) dropiPayload.phone = phone;
    if (email) dropiPayload.email = email;

    // Payload del canal WEB del panel (PUT /api/orders/myorders/{id}) — misma
    // data, pero el email viaja como client_email en ese canal.
    const webPayload: Record<string, unknown> = {
      name: nombre,
      surname: apellido || "",
      dir: direccion,
      city: ciudad,
      state: departamento,
      ...(phone ? { phone } : {}),
      ...(email ? { client_email: email } : {}),
    };

    // ---- PROBE (solo admin, mismo patrón que dropi-update-order): diagnóstico
    // crudo del camino de edición sobre UN pedido — detalle v2 antes, PUT
    // integración, PUT web, detalle v2 después. Va ANTES del no-op
    // nothingChanged para poder probar sin cambiar datos. Ejecuta los PUTs DE
    // VERDAD pero SIN update local, SIN settle (probeMode) y SIN sync_logs.
    if (probeMode) {
      const { data: roles } = await sbAdmin
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id);
      const isAdmin = (roles || []).some((r: { role: string }) => r.role === "admin");
      if (!isAdmin) return jsonErr("probe es solo para admin", 403);

      const probeCfg = await loadStoreConfig(sbAdmin, storeId);
      const trunc = (v: unknown): string => {
        try {
          return (typeof v === "string" ? v : JSON.stringify(v ?? null) || "").slice(0, 2000);
        } catch {
          return String(v).slice(0, 2000);
        }
      };
      let sessionError: string | null = null;
      try {
        probeCfg.sessionToken = await ensureFreshSessionToken(sbAdmin, probeCfg);
      } catch (e) {
        sessionError = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      }
      const readV2 = async (): Promise<Record<string, unknown>> => {
        try {
          const v2 = await dropiGetOrderV2Detail(probeCfg, externalId);
          return { status: v2.httpStatus, body: trunc(v2.body) };
        } catch (e) {
          return { error: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
        }
      };
      const v2Before = await readV2();
      let integrationPut: Record<string, unknown>;
      if (!probeCfg.apiKey) {
        integrationPut = { skipped: "la tienda no tiene Clave API de Dropi" };
      } else {
        try {
          const r = await dropiPutCustomer(probeCfg.base, probeCfg.apiKey, probeCfg.storeUrl, externalId, dropiPayload);
          integrationPut = { status: r.httpStatus, body: trunc(r.rawText || r.body) };
        } catch (e) {
          integrationPut = { error: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
        }
      }
      let webPut: Record<string, unknown>;
      try {
        const r = await dropiWebFetch(
          probeCfg,
          `/api/orders/myorders/${encodeURIComponent(externalId)}`,
          { method: "PUT", body: webPayload },
        );
        webPut = { status: r.status, body: trunc(r.text || r.body) };
      } catch (e) {
        webPut = { error: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
      }
      const v2After = await readV2();
      return jsonOk({
        ok: true, probe: true, externalId,
        ...(sessionError ? { sessionError } : {}),
        integrationPut, webPut, v2Before, v2After,
      });
    }

    const nothingChanged =
      orderRow.nombre === fullName &&
      orderRow.phone === phone &&
      (orderRow.ciudad || "") === ciudad &&
      (orderRow.departamento || "") === departamento &&
      (orderRow.direccion || "") === direccion &&
      (orderRow.email || "") === email;
    if (nothingChanged) {
      return jsonOk({ ok: true, noChange: true });
    }

    const cfg = await loadStoreConfig(sbAdmin, storeId);
    if (!cfg.apiKey) {
      return jsonOk({ ok: false, code: "no_api_key", error: "La tienda no tiene Clave API de Dropi configurada" });
    }

    const dropi = await dropiPutCustomer(cfg.base, cfg.apiKey, cfg.storeUrl, externalId, dropiPayload);

    // Resultado del fallback web (W3): si algún canal alternativo aceptó los
    // datos, seguimos al UPDATE local en vez de rechazar la edición.
    let fallbackVia: "web" | "web_sibling" | null = null;
    let fallbackStatus = 0;
    let liveExternalId = externalId;

    if (!dropi.ok) {
      const detail = String(dropi.body.message || dropi.body.error || dropi.rawText || "error").slice(0, 500);
      let fallbackDetail = "";

      // ---- FALLBACK WEB clase-bot (W3) — solo si la integración dice "no
      // existe": para esta clase el 404 NO es prueba de muerte, es ceguera
      // del canal (ver _shared/dropiOrderLiveness.ts).
      if (notFoundSignal(dropi.httpStatus, dropi.body)) {
        // 1) Confirmar la clase con el GET de integración (mismo endpoint):
        //    si el GET también da no-encontrado, es clase-bot; si el GET SÍ
        //    lo ve, el PUT falló por otra cosa → rechazo real, sin fallback.
        let botClass = false;
        try {
          const check = await dropiGetOrder(cfg.base, cfg.apiKey, cfg.storeUrl, externalId);
          botClass = notFoundSignal(check.httpStatus, check.body);
          if (!botClass) fallbackDetail = "el GET de integración SÍ ve el pedido — rechazo real, sin fallback";
        } catch (e) {
          fallbackDetail = `check de existencia lanzó: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
        }

        if (botClass) {
          // 2) Sesión web (auto-login si venció). Sin sesión no hay fallback.
          let sessionOk = false;
          try {
            cfg.sessionToken = await ensureFreshSessionToken(sbAdmin, cfg);
            sessionOk = true;
          } catch (e) {
            const m = e instanceof WebFallbackError ? e.message : (e instanceof Error ? e.message : String(e));
            fallbackDetail = `(fallback web sin sesión: ${m})`.slice(0, 300);
          }

          if (sessionOk) {
            // 3) PUT WEB de los campos cliente sobre el MISMO id (el canal
            //    del panel SÍ escribe las órdenes vivas clase-bot).
            let putStatus = 0;
            let putBody: Record<string, unknown> = {};
            let putText = "";
            let putThrew: string | null = null;
            try {
              const put = await dropiWebFetch(
                cfg,
                `/api/orders/myorders/${encodeURIComponent(externalId)}`,
                { method: "PUT", body: webPayload },
              );
              putStatus = put.status;
              putBody = (put.body || {}) as Record<string, unknown>;
              putText = put.text;
            } catch (e) {
              putThrew = (e instanceof Error ? e.message : String(e)).slice(0, 200);
            }
            const putOk = !putThrew && putStatus >= 200 && putStatus < 300 && putBody.isSuccess !== false;
            const stubSignal = STUB_SIGNAL_RE.test(String(putBody.message || putBody.error || putText || ""));

            if (putOk && !stubSignal) {
              // 5) PUT web aceptado directo: verificación best-effort por el
              //    detalle v2 (SÍ trae campos de cliente aunque no status).
              //    Si se lee la dirección y NO coincide, el PUT no aplicó de
              //    verdad; si no se puede leer, criterio leniente.
              let v2Mismatch = false;
              try {
                const v2 = await dropiGetOrderV2Detail(cfg, externalId);
                if (v2.ok) {
                  const data = (v2.body.data ?? v2.body.objects ?? v2.body) as Record<string, unknown>;
                  const client = (data?.client ?? {}) as Record<string, unknown>;
                  const v2dir = String(data?.dir || client?.dir || "").trim();
                  if (v2dir && normUp(v2dir) !== normUp(direccion)) v2Mismatch = true;
                }
              } catch (e) {
                console.error("[dropi-update-order-full] verify v2 del fallback web lanzó:", e);
              }
              if (!v2Mismatch) {
                fallbackVia = "web";
                fallbackStatus = putStatus;
              } else {
                fallbackDetail = `PUT web [${putStatus}] aceptado pero el detalle v2 sigue mostrando la dirección vieja`;
              }
            } else if (stubSignal) {
              // 4) El canal web delata un STUB (la compra fue forwardeada a
              //    otra orden viva): resolver la hermana INEQUÍVOCA de la
              //    misma compra y escribir los datos ahí. Para edición de
              //    datos cualquier viva sirve → statusFilter: null.
              const sibling = await resolveLiveSibling(cfg, {
                stubId: externalId,
                phone: String(orderRow.phone || ""),
                nombre: String(orderRow.nombre || ""),
                statusFilter: null,
              });
              if (!sibling) {
                fallbackDetail = "stub sin hermana viva inequívoca (listado + shop_order_id)";
              } else {
                let acceptedStatus = 0;
                let sibDetail = "";
                // (a) Primero la integración sobre la hermana (las importadas
                //     por el cron SÍ suelen existir para /integrations).
                try {
                  const sibInt = await dropiPutCustomer(cfg.base, cfg.apiKey, cfg.storeUrl, sibling.id, dropiPayload);
                  if (sibInt.ok) {
                    acceptedStatus = sibInt.httpStatus;
                  } else if (notFoundSignal(sibInt.httpStatus, sibInt.body)) {
                    // (b) La hermana también es invisible para la integración
                    //     → PUT web de los mismos campos sobre la hermana.
                    try {
                      const sibWeb = await dropiWebFetch(
                        cfg,
                        `/api/orders/myorders/${encodeURIComponent(sibling.id)}`,
                        { method: "PUT", body: webPayload },
                      );
                      const sibBody = (sibWeb.body || {}) as Record<string, unknown>;
                      const sibOk = sibWeb.status >= 200 && sibWeb.status < 300 &&
                        sibBody.isSuccess !== false &&
                        !STUB_SIGNAL_RE.test(String(sibBody.message || sibBody.error || sibWeb.text || ""));
                      if (sibOk) acceptedStatus = sibWeb.status;
                      else sibDetail = `PUT web a la hermana #${sibling.id} falló [${sibWeb.status}]: ${String(sibBody.message || sibBody.error || "error").slice(0, 150)}`;
                    } catch (e) {
                      sibDetail = `PUT web a la hermana #${sibling.id} lanzó: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
                    }
                  } else {
                    sibDetail = `PUT integración a la hermana #${sibling.id} rechazado [${sibInt.httpStatus}]: ${String(sibInt.body.message || sibInt.body.error || "error").slice(0, 150)}`;
                  }
                } catch (e) {
                  sibDetail = `PUT integración a la hermana #${sibling.id} lanzó: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
                }

                if (acceptedStatus) {
                  // (c) Algún canal aceptó → la fila Guardian pasa a apuntar
                  //     a la viva (o queda REEMPLAZADA si el cron ya la trajo)
                  //     + rastro warn en sync_logs.
                  const retarget = await retargetLocalOrder(sbAdmin, { orderRowId: orderRow.id, siblingId: sibling.id });
                  await sbAdmin.from("sync_logs").insert({
                    source: "dropi-update-order-full",
                    status: "warn", synced_count: 1, duplicates_count: 0, total_count: 1,
                    triggered_by: user.id, store_id: storeId,
                    error_message: `Stub del bot #${externalId} sin superficie de escritura — datos del cliente aplicados a la orden VIVA #${sibling.id} de la misma compra; fila local ${retarget === "retargeted" ? "retargeteada" : "marcada REEMPLAZADA"}.`,
                  });
                  fallbackVia = "web_sibling";
                  fallbackStatus = acceptedStatus;
                  liveExternalId = sibling.id;
                } else {
                  fallbackDetail = sibDetail || `la hermana #${sibling.id} no aceptó los datos por ningún canal`;
                }
              }
            } else {
              fallbackDetail = putThrew
                ? `PUT web lanzó: ${putThrew}`
                : `PUT web falló [${putStatus}]: ${String(putBody.message || putBody.error || "error").slice(0, 150)}`;
            }
          }
        }
      }

      // 6) Todo falló → rechazo con el detalle del fallback anexado, para que
      //    la nota del panel explique por qué re-aplicar no ayuda.
      if (!fallbackVia) {
        const errorMsg = `Dropi rechazó el cambio [${dropi.httpStatus}]: ${detail}` +
          (fallbackDetail ? ` | fallback web: ${fallbackDetail}` : "");
        await sbAdmin.from("sync_logs").insert({
          source: "dropi-update-order-full",
          status: "error", synced_count: 0, duplicates_count: 0, total_count: 1,
          triggered_by: user.id, error_message: errorMsg, store_id: storeId,
        });
        return jsonOk({
          ok: false, code: "dropi_rejected", error: errorMsg,
          dropiHttpStatus: dropi.httpStatus, dropiBody: dropi.body,
        });
      }
    }

    // Usar sbAdmin: la membresía ya se validó arriba (línea ~115) y Dropi YA
    // aceptó el cambio. Si RLS con sbUser bloquea, queda Dropi actualizado y
    // DB local desincronizado — bug peor que el riesgo de bypass.
    const { error: updateErr } = await sbAdmin
      .from("orders")
      .update({
        nombre: fullName,
        phone, ciudad, departamento, direccion,
        email: email || null,
        last_edit_sync_at: new Date().toISOString(),
        last_edited_by: user.id,
      })
      .eq("id", orderRow.id);

    if (updateErr) {
      // OJO: dropiAccepted:true — Dropi SÍ guardó los datos; lo que falló fue
      // la ficha local. El cliente bifurca el toast con este flag para no
      // hacer que la asesora re-dicte datos que ya están en Dropi.
      return jsonOk({
        ok: false, code: "db_update_failed", dropiAccepted: true, dbError: updateErr.message,
        error: `Dropi aceptó el cambio pero la base de datos lo rechazó: ${updateErr.message}`,
      });
    }

    // (El insert de auditoría 'edicion_orden' se movió al cliente — ver
    //  cabecera. Insertarlo también acá duplicaba la fila en cada edición.)

    if (fallbackVia) {
      // Campos aditivos: los clientes viejos siguen leyendo ok/externalId/
      // dropiHttpStatus como siempre.
      return jsonOk({
        ok: true,
        via: fallbackVia,
        externalId: liveExternalId,
        ...(fallbackVia === "web_sibling"
          ? {
            oldExternalId: externalId,
            warning: `stub #${externalId} sin superficie de escritura — datos aplicados a la orden viva #${liveExternalId}`,
          }
          : {}),
        dropiHttpStatus: fallbackStatus,
      });
    }

    return jsonOk({ ok: true, externalId, dropiHttpStatus: dropi.httpStatus });
  } catch (err) {
    console.error("dropi-update-order-full error:", err);
    const msg = err instanceof Error ? err.message : "Error interno";
    // W1 best-effort: que un 500 no deje la auditoría 'pending' eterna.
    try {
      if (!probeMode && settleId && sbAdmin) {
        await settleAuditRow(sbAdmin, settleId, settleUserId, "failed", `EDICIÓN falló: ${msg}`);
      }
    } catch { /* el settle nunca es fatal */ }
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

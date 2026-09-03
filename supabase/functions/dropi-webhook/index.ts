// dropi-webhook: recibe las notificaciones de cambio de estado de Dropi por la
// API OFICIAL de Integraciones.
//
// QUÉ ES: Dropi hace POST a esta URL cada vez que un pedido creado a través de
// NUESTRA integración (shop_type "Guardian") cambia de estado. Reemplaza el
// polling para esos pedidos (tiempo real, sin esperar al cron ni gastar cuota).
// Estructura del payload: PDF "CORE DROPI" sección WEB HOOK (verificado 2026-07-15).
//   { id, status, shipping_guide, shipping_company, shop_id, phone, city, state,
//     name, surname, dir, total_order, orderdetails:[...], shop:{...}, ... }
// OJO: el payload es PARCIAL (no trae shipping_amount ni supplier_price), por eso
// para pedidos existentes hacemos UPDATE DIRIGIDO (estado/guía/transportadora) y
// NUNCA pisamos valor/flete/costo_prod con ceros.
//
// SEGURIDAD: público al TCP (Dropi lo llama sin JWT — verify_jwt=false en config.toml),
// pero exige el secreto compartido DROPI_WEBHOOK_SECRET (fail-closed, igual que
// wa-webhook): header x-dropi-secret (preferido) o ?secret=. Sin secreto configurado,
// o si no coincide, devuelve 401 a TODO — nunca procesa un POST anónimo (los external_id
// de Dropi son enumerables; un tercero podría sobrescribir estados de pedidos reales).
//
// IDEMPOTENTE: re-procesar la misma notificación deja el mismo estado.
// SIEMPRE responde 200 (ack) salvo secreto inválido — un webhook que devuelve
// error hace que Dropi reintente en loop.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { mapDropiOrderToRow } from "../_shared/dropiOrderMapper.ts";
// FUNNEL_RANK/normalizeStatus: el mismo orden del funnel que usa
// dropi-update-order para verificar PUTs — acá alimenta el guard anti-retroceso.
import { FUNNEL_RANK, normalizeStatus } from "../_shared/dropiConfirmOrder.ts";
import { respuestaPing } from "../_shared/versionEdge.ts";

// Marca de versión (3-sep-2026): esta función es pública (verify_jwt=false) y
// hasta hoy no decía qué código corre. Ver _shared/versionEdge.ts.
const VERSION = "dropi-webhook 2026-09-04.1 lo-que-no-entra-queda-en-sync-logs";

/**
 * Lo que el webhook NO pudo escribir queda en `sync_logs` (3-sep-2026).
 *
 * Se sigue contestando 200: Dropi reintenta en loop ante un 5xx y no hay
 * garantía de que el reintento sirva (el UPDATE falló por la base, no por el
 * payload). Pero antes el fallo solo iba a `console.error`, que nadie mira:
 * el pedido quedaba con el estado viejo hasta que el cron (cada ~10 min)
 * lo trajera de nuevo, y nadie sabía que el webhook estaba perdiendo. Ahora
 * aparece en el "Historial de sincronizaciones" de Admin como `warn`, con el
 * pedido. Best-effort: si tampoco se puede escribir esto, se loguea y ya.
 */
// deno-lint-ignore no-explicit-any
async function anotarPerdida(sbAdmin: any, storeId: string | null, accion: string, externalId: string, detalle: string) {
  try {
    const fila: Record<string, unknown> = {
      source: "dropi-webhook", status: "warn", synced_count: 0,
      error_message: `${accion} #${externalId}: ${detalle}`.slice(0, 500),
    };
    if (storeId) fila.store_id = storeId;
    const { error } = await sbAdmin.from("sync_logs").insert(fila);
    if (error) console.error("[dropi-webhook] no pude anotar la pérdida en sync_logs:", error.message);
  } catch (e) {
    console.error("[dropi-webhook] no pude anotar la pérdida en sync_logs:", e instanceof Error ? e.message : String(e));
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

/** Fecha de hoy en Bogotá (YYYY-MM-DD). Los estados de Dropi son hora Colombia. */
function bogotaToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Bogota" });
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  // Health-check legible para verificar que la función está desplegada.
  if (req.method === "GET") {
    return json({ ok: true, service: "dropi-webhook", ts: new Date().toISOString() }, 200, corsHeaders);
  }
  if (req.method !== "POST") {
    return json({ ok: false, error: "POST only" }, 405, corsHeaders);
  }
  { const p = respuestaPing(req, VERSION, corsHeaders); if (p) return p; }

  // ---- Secreto OBLIGATORIO (fail-closed) ----
  // Preferimos el header sobre ?secret= (el query string se filtra a access-logs/proxies).
  // Configurar con: supabase secrets set DROPI_WEBHOOK_SECRET=<uuid>
  const url = new URL(req.url);
  const expected = Deno.env.get("DROPI_WEBHOOK_SECRET") || "";
  const provided = req.headers.get("x-dropi-secret") || url.searchParams.get("secret") || "";
  if (!expected || provided !== expected) {
    return json({ ok: false, error: "unauthorized" }, 401, corsHeaders);
  }

  // ---- Payload ----
  let payload: Record<string, unknown>;
  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "JSON inválido" }, 400, corsHeaders);
  }

  // Dropi puede envolver en { objects: {...} } o mandar el objeto directo.
  const o = ((payload.objects ?? payload.object ?? payload) as Record<string, unknown>) || {};
  const externalId = String(o.id ?? "").trim();
  if (!externalId) {
    console.warn("[dropi-webhook] payload sin id", JSON.stringify(payload).slice(0, 200));
    return json({ ok: true, action: "ignored_no_id" }, 200, corsHeaders);
  }

  const status = String(o.status ?? "").trim().toUpperCase() || null;
  const guia = o.shipping_guide != null ? String(o.shipping_guide).trim() : "";
  const transportadora = o.shipping_company != null ? String(o.shipping_company).trim() : "";
  const nowIso = new Date().toISOString();

  const sbAdmin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    // 0) Resolver PRIMERO la TIENDA del payload (shop_id → store_dropi_config.
    //    dropi_integration_shop_id). CRÍTICO (auditoría 2026-08-13): los ids de
    //    pedido de Dropi son POR PLATAFORMA de país y PUEDEN CHOCAR entre
    //    tiendas (una cuenta GT joven arranca en ids bajos, mismo rango que el
    //    backfill viejo y que EC). El match viejo por external_id a secas podía
    //    pisar estado/guía/transportadora del pedido de OTRA tienda — mezcla de
    //    países, lo prohibido #1 de esta operación. FAIL-CLOSED: sin tienda
    //    resoluble no se toca nada (activar el webhook exige configurar
    //    dropi_integration_shop_id en la tienda; hoy el webhook está inactivo).
    const shopId = o.shop_id ?? (o.shop as Record<string, unknown> | null)?.id ?? null;
    let storeId: string | null = null;
    if (shopId != null) {
      try {
        const { data: cfg } = await sbAdmin
          .from("store_dropi_config")
          .select("store_id")
          .eq("dropi_integration_shop_id", Number(shopId))
          .maybeSingle();
        storeId = cfg?.store_id ?? null;
      } catch (e) {
        console.warn("[dropi-webhook] no se pudo resolver tienda por shop_id (¿migración pendiente?)", String(e));
      }
    }
    if (!storeId) {
      console.warn("[dropi-webhook] sin tienda resoluble para el shop_id — fail-closed, no se toca nada", { externalId, shopId });
      return json({ ok: true, action: "ignored_no_store", external_id: externalId }, 200, corsHeaders);
    }

    // 1) ¿Ya existe el pedido EN ESTA TIENDA? (lo normal: Guardian lo creó por
    //    la integración, así que ya está por external_id + store_id).
    const { data: existing } = await sbAdmin
      .from("orders")
      .select("id, store_id, estado, guia, transportadora, fecha_conf")
      .eq("external_id", externalId)
      .eq("store_id", storeId)
      .maybeSingle();

    if (existing) {
      // ── Guard anti-retroceso (auditoría 2026-07-31) ──────────────────────
      // Dropi reintenta webhooks ante errores y los reintentos pueden llegar
      // FUERA DE ORDEN. Dos protecciones ANTES del UPDATE:
      //
      // (a) REEMPLAZADA / ARCHIVADO GHOST son soft-deletes de GUARDIAN (pair-
      //     resolver / nightly-reconcile), no estados de Dropi: una notificación
      //     tardía sobre el stub NO debe resucitarlo a la cola ni contaminar las
      //     métricas. Se ackea 200 para que Dropi no reintente en loop.
      const curNorm = normalizeStatus(String(existing.estado ?? ""));
      if (curNorm === "REEMPLAZADA" || curNorm === "ARCHIVADO GHOST") {
        console.log("[dropi-webhook] ignorado: pedido soft-borrado en Guardian", externalId, curNorm);
        return json({ ok: true, action: "ignored_soft_deleted", external_id: externalId }, 200, corsHeaders);
      }
      // (b) Un estado TERMINAL (ENTREGADO / DEVOLUCION, rank 8) no retrocede:
      //     una notificación vieja re-encolada (GUIA GENERADA llegando 2h
      //     después de ENTREGADO) regresaría el pedido en Seguimiento y lo
      //     sacaría de entregados hasta el próximo cron — flapping intermitente.
      //     OJO: solo se protege el rank terminal — un CANCELADO legítimo sobre
      //     un pedido en curso SÍ aplica (su rank -1 en FUNNEL_RANK es un
      //     artefacto de la verificación de PUTs, no un orden temporal).
      if (status) {
        const rankCur = FUNNEL_RANK[curNorm];
        const rankNew = FUNNEL_RANK[normalizeStatus(status)];
        if (
          rankCur !== undefined && rankCur >= FUNNEL_RANK["ENTREGADO"] &&
          rankNew !== undefined && rankNew < rankCur
        ) {
          console.log("[dropi-webhook] ignorado: notificación tardía", externalId, `${existing.estado} <- ${status}`);
          return json({ ok: true, action: "ignored_stale_status", external_id: externalId, estado: existing.estado }, 200, corsHeaders);
        }
      }

      // UPDATE DIRIGIDO — solo lo que la notificación es autoridad de cambiar.
      // No tocamos valor/flete/costo_prod (el payload es parcial → serían 0).
      const patch: Record<string, unknown> = { last_movement_at: nowIso };
      if (status) patch.estado = status;
      if (guia) patch.guia = guia;
      if (transportadora) patch.transportadora = transportadora;
      // Sellar fecha_conf cuando el pedido deja la cola de confirmación (idempotente:
      // solo si aún no está sellada). Antes solo sellaba si HABÍAMOS visto el estado
      // previo "PENDIENTE CONFIRMACION"; si un sync lo adelantaba, nunca sellaba. Ahora
      // sella con cualquier estado post-cola, excepto cancelaciones (nunca se confirmaron).
      const CANCEL_STATES = new Set(["CANCELADO", "RECHAZADO", "ANULADO"]);
      if (status && !existing.fecha_conf && status !== "PENDIENTE CONFIRMACION" && !CANCEL_STATES.has(status)) {
        patch.fecha_conf = bogotaToday();
        patch.dias_conf = 0;
      }

      const { error: updErr } = await sbAdmin.from("orders").update(patch).eq("id", existing.id);
      if (updErr) {
        console.error("[dropi-webhook] update falló", externalId, updErr.message);
        await anotarPerdida(sbAdmin, storeId, "webhook no pudo actualizar", externalId, `${status || "sin estado"} — ${updErr.message}. El cron lo trae en la próxima corrida.`);
        return json({ ok: false, action: "update_failed", external_id: externalId }, 200, corsHeaders);
      }
      console.log("[dropi-webhook] actualizado", externalId, "->", status, guia ? `guía ${guia}` : "");
      return json({ ok: true, action: "updated", external_id: externalId, estado: status }, 200, corsHeaders);
    }

    // 2) No existe EN ESTA TIENDA → best-effort: INSERTAR el pedido completo.
    //    Caso borde (webhook antes de que Guardian lo inserte, o pedido creado
    //    fuera de Guardian). La tienda ya quedó resuelta en el paso 0.
    // uploaded_by tiene FK a auth.users → usamos el dueño de la tienda.
    const { data: owner } = await sbAdmin
      .from("store_members")
      .select("user_id")
      .eq("store_id", storeId)
      .eq("role", "owner")
      .limit(1)
      .maybeSingle();
    const uploadedBy = owner?.user_id;
    if (!uploadedBy) {
      console.warn("[dropi-webhook] tienda sin dueño para uploaded_by — se ignora", storeId);
      return json({ ok: true, action: "ignored_no_owner", external_id: externalId }, 200, corsHeaders);
    }

    // Inyectar updated_at=now para que last_movement_at quede con la hora de la
    // notificación (el payload del webhook no trae updated_at).
    const enriched = { ...o, updated_at: nowIso };
    const row = mapDropiOrderToRow(enriched, uploadedBy, bogotaToday(), storeId);
    // insert-only (ignoreDuplicates): si el pedido ya existe (carrera con el sync o
    // con Guardian entre el SELECT y este upsert), NO lo pisamos con el payload PARCIAL
    // del webhook — traería flete=0 y costo_prod=0 y violaría el invariante del header.
    // Colisión entre plataformas: la llave ya es (store_id, external_id)
    // —migración 20260820140000— porque el mismo número de pedido puede existir
    // en GT y en CO siendo clientes distintos. Con la UNIQUE global anterior,
    // un id que ya viviera en OTRA tienda hacía que este insert se descartara en
    // silencio: el webhook perdía el pedido y nadie se enteraba.
    // ⚠️ Este onConflict EXIGE esa migración aplicada: sin ella PostgREST no
    // encuentra un unique que matchee y el insert falla (queda en el log de
    // arriba). Desplegar esta función DESPUÉS de correr el SQL, no antes.
    const { data: insData, error: insErr } = await sbAdmin
      .from("orders")
      .upsert(row, { onConflict: "store_id,external_id", ignoreDuplicates: true })
      .select("id");
    if (insErr) {
      console.error("[dropi-webhook] insert falló", externalId, insErr.message);
      await anotarPerdida(sbAdmin, storeId, "webhook no pudo insertar el pedido nuevo", externalId, `${insErr.message}. El cron lo trae en la próxima corrida.`);
      return json({ ok: false, action: "insert_failed", external_id: externalId }, 200, corsHeaders);
    }
    // ignoreDuplicates puede DESCARTAR el insert en silencio: ahora el único
    // motivo posible es una carrera con el sync sobre el MISMO pedido de la
    // MISMA tienda (antes también lo causaba un id que vivía en otra tienda).
    // Reportarlo como "inserted" era un log falso (revisión adversarial
    // 2026-08-13): sin fila devuelta, no se insertó nada.
    if (!insData || insData.length === 0) {
      console.warn("[dropi-webhook] insert descartado por conflicto (carrera con el sync sobre el mismo pedido)", externalId, "tienda", storeId);
      return json({ ok: true, action: "insert_ignored_conflict", external_id: externalId }, 200, corsHeaders);
    }
    console.log("[dropi-webhook] insertado nuevo", externalId, "tienda", storeId);
    return json({ ok: true, action: "inserted", external_id: externalId, estado: status }, 200, corsHeaders);
  } catch (err) {
    // Nunca devolvemos 5xx: Dropi reintentaría en loop. Log + ack, y la
    // pérdida queda anotada donde el dueño la ve.
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[dropi-webhook] error inesperado", externalId, msg);
    try {
      const sbAdmin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      await anotarPerdida(sbAdmin, null, "webhook falló", externalId, `${msg}. El cron lo trae en la próxima corrida.`);
    } catch { /* ya se logueó arriba */ }
    return json({ ok: false, action: "error_acked", external_id: externalId }, 200, corsHeaders);
  }
});

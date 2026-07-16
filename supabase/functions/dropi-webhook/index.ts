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
    // 1) ¿Ya existe el pedido en Guardian? (lo normal: Guardian lo creó por la
    //    integración, así que ya está por external_id).
    const { data: existing } = await sbAdmin
      .from("orders")
      .select("id, store_id, estado, guia, transportadora, fecha_conf")
      .eq("external_id", externalId)
      .maybeSingle();

    if (existing) {
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
        return json({ ok: false, action: "update_failed", external_id: externalId }, 200, corsHeaders);
      }
      console.log("[dropi-webhook] actualizado", externalId, "->", status, guia ? `guía ${guia}` : "");
      return json({ ok: true, action: "updated", external_id: externalId, estado: status }, 200, corsHeaders);
    }

    // 2) No existe → best-effort: resolver la tienda por shop_id e INSERTAR el
    //    pedido completo. Caso borde (webhook antes de que Guardian lo inserte,
    //    o pedido creado fuera de Guardian). Defensivo: si la columna nueva aún
    //    no está migrada o no hay dueño, simplemente ack sin romper.
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
      console.warn("[dropi-webhook] pedido nuevo sin tienda resoluble — se ignora", { externalId, shopId });
      return json({ ok: true, action: "ignored_no_store", external_id: externalId }, 200, corsHeaders);
    }

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
    const { error: insErr } = await sbAdmin
      .from("orders")
      .upsert(row, { onConflict: "external_id", ignoreDuplicates: true });
    if (insErr) {
      console.error("[dropi-webhook] insert falló", externalId, insErr.message);
      return json({ ok: false, action: "insert_failed", external_id: externalId }, 200, corsHeaders);
    }
    console.log("[dropi-webhook] insertado nuevo", externalId, "tienda", storeId);
    return json({ ok: true, action: "inserted", external_id: externalId, estado: status }, 200, corsHeaders);
  } catch (err) {
    // Nunca devolvemos 5xx: Dropi reintentaría en loop. Log + ack.
    console.error("[dropi-webhook] error inesperado", externalId, err instanceof Error ? err.message : String(err));
    return json({ ok: false, action: "error_acked", external_id: externalId }, 200, corsHeaders);
  }
});

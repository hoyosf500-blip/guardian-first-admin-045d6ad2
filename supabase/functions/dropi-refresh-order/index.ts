// dropi-refresh-order: refresca UN pedido desde la API Dropi y upsertea en
// la tabla `orders`. Disparado por el botón "Refrescar desde Dropi" en
// CrmCallView/OrderCard de Seguimiento. Da parity en tiempo real para los
// pedidos que la asesora está mirando AHORA, sin esperar al cron (que cada
// 5 min puede ser throttleado por la cuenta EC).
//
// Auth: JWT del usuario (header Authorization). Valida membresía de la
// tienda antes de hacer cualquier cosa.
//
// Side effect: UPSERT en la tabla orders por `external_id`. Realtime envía
// la actualización a todos los clientes conectados (incluyendo el que pidió
// el refresh — su UI ve los datos nuevos sin recargar).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { loadStoreConfig, isStoreMember } from "../_shared/dropiStoreConfig.ts";
import { mapDropiOrderToRow, extractStatusHistoryRows } from "../_shared/dropiOrderMapper.ts";
import { respuestaPing } from "../_shared/versionEdge.ts";

// Marca de versión (4-sep-2026): esta función cambió el `onConflict` del
// historial a (store_id, dropi_history_id) y el índice viejo se BORRÓ en la
// base. Si el deploy no entra, cada refresh pierde el historial en silencio
// (el upsert falla dentro de un try/catch con warn). Sin ping no había forma
// de saber desde afuera qué versión corre — ver _shared/versionEdge.ts.
const VERSION = "dropi-refresh-order 2026-09-04.1 historial-por-tienda";

interface RefreshBody {
  store_id?: string;
  external_id?: string | number;
}

function jsonResp(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResp({ error: "POST only" }, 405, corsHeaders);
  }
  { const p = respuestaPing(req, VERSION, corsHeaders); if (p) return p; }

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) {
      return jsonResp({ error: "Falta Authorization header" }, 401, corsHeaders);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return jsonResp({ error: "no auth" }, 401, corsHeaders);
    }

    const body = (await req.json().catch(() => ({}))) as RefreshBody;
    const storeId = String(body.store_id || "").trim();
    const externalId = String(body.external_id || "").trim();
    if (!storeId || !externalId) {
      return jsonResp({ error: "store_id y external_id requeridos" }, 400, corsHeaders);
    }

    // Service role para validaciones y upsert — evita los choques con RLS de
    // store_dropi_config (admin-only) y orders (membership-scoped).
    const sbAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const isMember = await isStoreMember(sbAdmin, user.id, storeId);
    if (!isMember) {
      return jsonResp({ error: "no sos miembro de esa tienda" }, 403, corsHeaders);
    }

    const cfg = await loadStoreConfig(sbAdmin, storeId);
    if (!cfg.apiKey) {
      return jsonResp({ error: "tienda sin dropi_api_key configurada" }, 400, corsHeaders);
    }

    // GET /integrations/orders/myorders/{external_id}. Endpoint correcto
    // (verificado en dropi-change-carrier:45 — el path es `myorders/{id}`,
    // no `/{id}` directo. La primera versión causaba 404 sobre TODOS los
    // pedidos en la auditoría EC del 2026-05-28).
    const origin = cfg.storeUrl || "";
    const url = `${cfg.base}/integrations/orders/myorders/${encodeURIComponent(externalId)}`;
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "dropi-integration-key": cfg.apiKey,
        ...(origin ? { Origin: origin, Referer: origin.endsWith("/") ? origin : `${origin}/` } : {}),
      },
    });

    if (res.status === 429) {
      const txt = await res.text().catch(() => "");
      return jsonResp({
        error: "Dropi está limitando las peticiones (rate limit). Esperá ~1 minuto y reintentá.",
        rateLimited: true,
        dropiStatus: 429,
        dropiBody: txt.slice(0, 200),
      }, 429, corsHeaders);
    }
    if (res.status === 404) {
      return jsonResp({
        error: "Dropi no encontró ese pedido. Puede haber sido eliminado o reemplazado por otra orden.",
        dropiStatus: 404,
      }, 404, corsHeaders);
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return jsonResp({
        error: `Dropi devolvió ${res.status}`,
        dropiStatus: res.status,
        dropiBody: txt.slice(0, 200),
      }, 502, corsHeaders);
    }

    const data = await res.json();
    // El response puede venir como { objects: {OBJETO} } (objeto suelto — caso real
    // verificado 2026-06-24), { object: {...} }, { objects: [{...}] }, o directo.
    // Cubrimos los 4 (antes NO manejaba `objects` objeto-suelto → 502 "sin objeto
    // pedido" sobre TODOS los refresh).
    const objects = (data as Record<string, unknown>)?.objects;
    const raw =
      (data as Record<string, unknown>)?.object ??
      (Array.isArray(objects) ? objects[0] : objects) ??
      data;
    const orderObj = raw as Record<string, unknown>;

    if (!orderObj || (!orderObj.id && !orderObj.external_id)) {
      return jsonResp({
        error: "Respuesta Dropi sin objeto pedido",
        rawSample: JSON.stringify(data).slice(0, 200),
      }, 502, corsHeaders);
    }

    const today = new Date().toISOString().split("T")[0];
    const dbRow = mapDropiOrderToRow(orderObj, user.id, today, storeId);

    // Fila local ANTES del upsert: hace falta para preservar fecha_conf (abajo) y
    // para ingerir el historial sin un segundo select. Siempre por tienda —
    // external_id es único global pero leer sin store_id cruzaría países.
    const { data: localRow } = await sbAdmin
      .from("orders")
      .select("id, fecha_conf")
      .eq("store_id", storeId)
      .eq("external_id", String(dbRow.external_id))
      .maybeSingle();

    // El GET de DETALLE puede venir SIN `history[]`; en ese caso deriveFechaConf
    // cae al fallback updated_at y el próximo cron (que sí trae historial) la
    // devuelve a la fecha real: la "Fecha confirmación" y los días de SLA saltan
    // ida y vuelta bajo los pies de la asesora, con un evento realtime por flap.
    // Si ya hay un sello guardado y este refresh no puede derivarlo del historial,
    // se conserva el de la DB (la RPC escribe fecha_conf sin COALESCE).
    const trajoHistorial = Array.isArray((orderObj as Record<string, unknown>).history)
      && ((orderObj as { history: unknown[] }).history).length > 0;
    const fechaConfLocal = (localRow as { fecha_conf?: string | null } | null)?.fecha_conf ?? null;
    if (!trajoHistorial && fechaConfLocal) {
      dbRow.fecha_conf = fechaConfLocal;
    }

    // RPC en vez de .upsert() crudo (mismo camino que dropi-refresh-batch): el
    // crudo se salta las guardas de la RPC — UPDATE incondicional (evento
    // realtime aunque nada cambió), re-estampa uploaded_by/upload_date, pisa el
    // phone editado localmente y escribe productos_detalle=NULL borrando
    // talla/color cuando el detalle viene sin orderdetails.
    const { error: upsertErr } = await sbAdmin.rpc("upsert_orders_from_dropi", {
      p_orders: [dbRow],
    });

    if (upsertErr) {
      return jsonResp({
        error: `No se pudo guardar en DB: ${upsertErr.message}`,
        dbError: upsertErr.message,
      }, 500, corsHeaders);
    }

    // Historial real de Dropi → order_status_history (idempotente por
    // dropi_history_id). Un fallo acá NO invalida el refresh del estado.
    if (trajoHistorial) {
      try {
        let orderUuid = (localRow as { id?: string } | null)?.id ?? "";
        if (!orderUuid) {
          const { data: created } = await sbAdmin
            .from("orders")
            .select("id")
            .eq("store_id", storeId)
            .eq("external_id", String(dbRow.external_id))
            .maybeSingle();
          orderUuid = (created as { id?: string } | null)?.id ?? "";
        }
        const histRows = orderUuid ? extractStatusHistoryRows(orderObj, orderUuid, storeId) : [];
        if (histRows.length > 0) {
          // ⛔ POR TIENDA (4-sep-2026) — ver dropi-refresh-batch. Exige el índice
          // `uq_osh_store_history` (20260904130000) aplicado ANTES del deploy.
          const { error: histErr } = await sbAdmin
            .from("order_status_history")
            .upsert(histRows, { onConflict: "store_id,dropi_history_id", ignoreDuplicates: true });
          if (histErr) console.warn(`dropi-refresh-order: historial no ingerido (${histErr.message})`);
        }
      } catch (hErr) {
        console.warn(`dropi-refresh-order: error ingiriendo historial: ${hErr instanceof Error ? hErr.message : String(hErr)}`);
      }
    }

    return jsonResp({
      ok: true,
      external_id: dbRow.external_id,
      estado: dbRow.estado,
      guia: dbRow.guia,
      transportadora: dbRow.transportadora,
      novedad: dbRow.novedad,
      synced_at: new Date().toISOString(),
    }, 200, corsHeaders);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResp({ error: msg }, 500, corsHeaders);
  }
});

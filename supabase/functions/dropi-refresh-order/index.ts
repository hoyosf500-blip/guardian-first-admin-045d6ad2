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
import { mapDropiOrderToRow } from "../_shared/dropiOrderMapper.ts";

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
    // El response puede venir como { object: {...} } o { objects: [{...}] } o
    // directamente el objeto. Cubrimos los 3.
    const raw =
      (data as Record<string, unknown>)?.object ??
      ((data as Record<string, unknown>)?.objects as Array<Record<string, unknown>> | undefined)?.[0] ??
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

    const { error: upsertErr } = await sbAdmin
      .from("orders")
      .upsert(dbRow, { onConflict: "external_id", ignoreDuplicates: false });

    if (upsertErr) {
      return jsonResp({
        error: `No se pudo guardar en DB: ${upsertErr.message}`,
        dbError: upsertErr.message,
      }, 500, corsHeaders);
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

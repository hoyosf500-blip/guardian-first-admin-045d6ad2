// dropi-refresh-batch: refresca VARIOS pedidos desde la API Dropi y los upsertea
// en la tabla `orders` en una sola invocación. Es la versión por lotes de
// dropi-refresh-order: el botón "Sincronizar con Dropi" / el auto-trigger de
// Seguimiento manda los external_id VISIBLES y esta function trae su estado REAL
// de Dropi AHORA (sin esperar al cron de 5 min, que con volumen se corta).
//
// Auth: JWT del usuario (Authorization). Valida membresía de la tienda.
//
// Side effect: UPSERT por `external_id` → el realtime ya existente sobre `orders`
// mueve las tarjetas del tablero en todos los clientes conectados.
//
// Anti-baneo / rate-limit: cap de ids por llamada, espaciado entre pedidos, un
// reintento con backoff ante 429 y corte parcial (`partial`) si Dropi sigue
// throttleando o si se agota el presupuesto de tiempo del edge. Un 429 en un
// pedido NUNCA mata el lote entero.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { loadStoreConfig, isStoreMember } from "../_shared/dropiStoreConfig.ts";
import { mapDropiOrderToRow } from "../_shared/dropiOrderMapper.ts";

interface BatchBody {
  store_id?: string;
  external_ids?: Array<string | number>;
}

const MAX_IDS = 40;            // cap defensivo por llamada
const SPACING_MS = 250;        // espaciado entre pedidos (anti rate-limit)
const TIME_BUDGET_MS = 50_000; // corte de seguridad antes del techo del edge
const RL_BACKOFF_MS = 2_000;   // espera tras un 429 antes del único reintento

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function jsonResp(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

/** Extrae el objeto pedido del response Dropi ({object} | {objects:[...]} | obj). */
function pickOrderObj(data: unknown): Record<string, unknown> | null {
  const d = data as Record<string, unknown>;
  const raw =
    d?.object ??
    (d?.objects as Array<Record<string, unknown>> | undefined)?.[0] ??
    data;
  const obj = raw as Record<string, unknown>;
  if (!obj || (!obj.id && !obj.external_id)) return null;
  return obj;
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResp({ error: "POST only" }, 405, corsHeaders);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return jsonResp({ error: "Falta Authorization header" }, 401, corsHeaders);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return jsonResp({ error: "no auth" }, 401, corsHeaders);

    const body = (await req.json().catch(() => ({}))) as BatchBody;
    const storeId = String(body.store_id || "").trim();
    const rawIds = Array.isArray(body.external_ids) ? body.external_ids : [];
    // Normaliza, dedup y capea.
    const ids = [...new Set(rawIds.map((x) => String(x || "").trim()).filter(Boolean))].slice(0, MAX_IDS);
    if (!storeId) return jsonResp({ error: "store_id requerido" }, 400, corsHeaders);
    if (ids.length === 0) return jsonResp({ ok: true, refreshed: 0, changed: 0, total: 0, partial: false }, 200, corsHeaders);

    const sbAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const isMember = await isStoreMember(sbAdmin, user.id, storeId);
    if (!isMember) return jsonResp({ error: "no sos miembro de esa tienda" }, 403, corsHeaders);

    const cfg = await loadStoreConfig(sbAdmin, storeId);
    if (!cfg.apiKey) return jsonResp({ error: "tienda sin dropi_api_key configurada" }, 400, corsHeaders);

    // Estados actuales para reportar cuántos CAMBIARON (1 query, no N).
    const { data: existing } = await sbAdmin
      .from("orders")
      .select("external_id, estado")
      .eq("store_id", storeId)
      .in("external_id", ids);
    const prevEstado = new Map(
      (existing || []).map((r) => [String((r as { external_id: unknown }).external_id), String((r as { estado: unknown }).estado || "")]),
    );

    const origin = cfg.storeUrl || "";
    const headers: Record<string, string> = {
      "Accept": "application/json",
      "dropi-integration-key": cfg.apiKey,
      ...(origin ? { Origin: origin, Referer: origin.endsWith("/") ? origin : `${origin}/` } : {}),
    };
    const today = new Date().toISOString().split("T")[0];

    const rows: Record<string, unknown>[] = [];
    let changed = 0;
    let rateLimited = false;
    let partial = false;
    let processed = 0;
    const started = Date.now();

    for (const extId of ids) {
      if (Date.now() - started > TIME_BUDGET_MS) { partial = true; break; }
      if (processed > 0) await sleep(SPACING_MS);
      processed++;

      const url = `${cfg.base}/integrations/orders/myorders/${encodeURIComponent(extId)}`;
      try {
        let res = await fetch(url, { method: "GET", headers });
        if (res.status === 429) {
          // Único reintento con backoff. Si vuelve a 429, cortamos parcial.
          await sleep(RL_BACKOFF_MS);
          res = await fetch(url, { method: "GET", headers });
          if (res.status === 429) { rateLimited = true; partial = true; break; }
        }
        if (!res.ok) continue; // 404 u otro → saltar ese pedido, seguir el lote

        const obj = pickOrderObj(await res.json().catch(() => null));
        if (!obj) continue;

        const dbRow = mapDropiOrderToRow(obj, user.id, today, storeId);
        if (String(dbRow.estado || "") !== (prevEstado.get(extId) ?? "")) changed++;
        rows.push(dbRow);
      } catch (_e) {
        // Falla de red de un pedido → no romper el lote.
        continue;
      }
    }

    // Si quedaron ids sin procesar (corte por tiempo/throttle), es parcial.
    if (processed < ids.length) partial = true;

    if (rows.length > 0) {
      const { error: upErr } = await sbAdmin
        .from("orders")
        .upsert(rows, { onConflict: "external_id", ignoreDuplicates: false });
      if (upErr) {
        return jsonResp({ error: `No se pudo guardar en DB: ${upErr.message}`, refreshed: 0, changed: 0, total: ids.length }, 500, corsHeaders);
      }
    }

    return jsonResp({
      ok: true,
      refreshed: rows.length,
      changed,
      total: ids.length,
      rateLimited,
      partial,
      synced_at: new Date().toISOString(),
    }, 200, corsHeaders);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResp({ error: msg }, 500, corsHeaders);
  }
});

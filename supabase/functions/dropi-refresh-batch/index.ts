// dropi-refresh-batch: sincroniza EN VIVO los pedidos recientes de una tienda
// contra Dropi, on-demand (botón "Sincronizar Dropi" de Seguimiento).
//
// IMPORTANTE — estrategia anti rate-limit (corregido 2026-06-23): la primera
// versión pedía UN request por pedido (40 requests) → Dropi tiraba 429 al toque
// y sincronizaba 0. Ahora usa el endpoint de LISTA (igual que dropi-cron /
// dropi-snapshot): ~1 request por cada 200 pedidos, con backoff exponencial.
// Muchísimos menos requests = Dropi nos aguanta. Hace UPSERT (snapshot solo lee)
// → el realtime ya existente mueve el tablero.
//
// Auth: JWT del usuario (Authorization) + isStoreMember (cualquier miembro).
//
// Body: { store_id, days? } — ventana de días hacia atrás (default 10). Filtra
// por "FECHA DE CAMBIO DE ESTATUS" (el winning filter) → trae lo que se MOVIÓ.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { loadStoreConfig, isStoreMember } from "../_shared/dropiStoreConfig.ts";
import { mapDropiOrderToRow, extractStatusHistoryRows } from "../_shared/dropiOrderMapper.ts";

interface BatchBody {
  store_id?: string;
  days?: number;
}

const PAGE_SIZE = 100;                // máx por página (menos requests = menos 429)
const RATE_LIMIT_MS = 1500;            // espera entre páginas OK (igual que cron/snapshot)
const MAX_PAGES = 20;                  // cap: 20 × 100 = 2000 pedidos recientes
const TIME_BUDGET_MS = 60_000;         // corte de seguridad < techo del edge
const RL_BACKOFF_MS = [2000, 4000, 8000, 16000]; // backoff exponencial ante 429
const DEFAULT_DAYS = 10;
const FALLBACK_FILTER = "FECHA DE CAMBIO DE ESTATUS";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function jsonResp(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

/** YYYY-MM-DD para una fecha desplazada `daysBack` días respecto a hoy (UTC). */
function ymd(daysBack: number): string {
  const d = new Date(Date.now() - daysBack * 86_400_000);
  return d.toISOString().split("T")[0];
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
    if (!storeId) return jsonResp({ error: "store_id requerido" }, 400, corsHeaders);
    const days = Number.isFinite(body.days) && (body.days as number) > 0
      ? Math.min(Math.floor(body.days as number), 60)
      : DEFAULT_DAYS;

    const sbAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const isMember = await isStoreMember(sbAdmin, user.id, storeId);
    if (!isMember) return jsonResp({ error: "no sos miembro de esa tienda" }, 403, corsHeaders);

    const cfg = await loadStoreConfig(sbAdmin, storeId);
    if (!cfg.apiKey) return jsonResp({ error: "tienda sin dropi_api_key configurada" }, 400, corsHeaders);

    // Filtro dinámico — mismo patrón que cron/snapshot/health.
    const { data: filterRow } = await sbAdmin.from("app_settings")
      .select("value").eq("key", "dropi_winning_status_filter").maybeSingle();
    const filterDateBy = (filterRow?.value as string) || FALLBACK_FILTER;

    const from = ymd(days);
    const to = ymd(0);
    const headers: Record<string, string> = {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "dropi-integration-key": cfg.apiKey,
      ...(cfg.storeUrl ? { Origin: cfg.storeUrl } : {}),
    };
    const today = ymd(0);

    let refreshed = 0;
    let pages = 0;
    let pagesFetched = 0;
    let start = 0;
    let partial = false;
    let rateLimited = false;
    let historyIngested = 0; // filas de order_status_history ingeridas desde Dropi
    const started = Date.now();

    pageLoop: while (pages < MAX_PAGES) {
      if (Date.now() - started > TIME_BUDGET_MS) { partial = true; break; }

      const params = new URLSearchParams({
        result_number: String(PAGE_SIZE),
        start: String(start),
        date_from: from,
        date_to: to,
        filter_date_by: filterDateBy,
        orderBy: "id",
        orderDirection: "desc",
      });
      const url = `${cfg.base}/integrations/orders/myorders?${params.toString()}`;

      // Backoff exponencial ante 429 antes de cortar parcial.
      let res: Response | null = null;
      let throttled = false;
      for (let attempt = 0; attempt <= RL_BACKOFF_MS.length; attempt++) {
        res = await fetch(url, { method: "GET", headers });
        if (res.status !== 429) { throttled = false; break; }
        throttled = true;
        if (attempt < RL_BACKOFF_MS.length) await sleep(RL_BACKOFF_MS[attempt]);
      }

      if (throttled) {
        rateLimited = true;
        partial = true;
        console.warn(`dropi-refresh-batch: 429 sostenido en página ${pages}, devolviendo ${refreshed} parciales`);
        break pageLoop;
      }
      if (!res || !res.ok) {
        const txt = res ? await res.text().catch(() => "") : "no-response";
        // Si ya trajimos algo, devolvemos parcial en vez de fallar todo.
        if (refreshed > 0) { partial = true; break; }
        return jsonResp({ error: `Dropi HTTP ${res?.status ?? "?"}`, dropiBody: txt.slice(0, 200) }, 502, corsHeaders);
      }

      const data = await res.json().catch(() => ({}));
      // Dropi puede responder 200 con isSuccess=false + objects vacío ante un
      // error de su lado — tratarlo como error, no como fin de paginación (igual
      // que dropi-cron). Si ya trajimos algo, devolvemos parcial.
      if ((data as Record<string, unknown>)?.isSuccess === false) {
        if (refreshed > 0) { partial = true; break; }
        return jsonResp({ error: "Dropi respondió isSuccess=false", dropiBody: JSON.stringify(data).slice(0, 200) }, 502, corsHeaders);
      }
      const objs = Array.isArray((data as Record<string, unknown>)?.objects)
        ? (data as { objects: Record<string, unknown>[] }).objects
        : [];
      if (objs.length === 0) break;

      const rows = objs.map((o) => mapDropiOrderToRow(o, user.id, today, storeId));
      const { data: upData, error: upErr } = await sbAdmin
        .from("orders")
        .upsert(rows, { onConflict: "external_id", ignoreDuplicates: false })
        .select("id, external_id");
      if (upErr) {
        if (refreshed > 0) { partial = true; break; }
        return jsonResp({ error: `No se pudo guardar en DB: ${upErr.message}`, refreshed }, 500, corsHeaders);
      }
      refreshed += rows.length;
      pagesFetched++;

      // Ingerir el historial REAL de Dropi (o.history[]) en order_status_history.
      // Reconstruye el timeline completo del pedido. Necesita el uuid de orders.id
      // → lo resolvemos del resultado del upsert (map external_id → id). Idempotente
      // por dropi_history_id. Un fallo acá NO debe abortar el sync de estados.
      try {
        const idByExt = new Map<string, string>();
        for (const r of (upData ?? []) as Array<{ id: string; external_id: string }>) {
          idByExt.set(String(r.external_id), r.id);
        }
        const histRows = [] as ReturnType<typeof extractStatusHistoryRows>;
        for (const o of objs) {
          const uuid = idByExt.get(String((o as Record<string, unknown>).id ?? ""));
          if (!uuid) continue;
          for (const hr of extractStatusHistoryRows(o, uuid, storeId)) histRows.push(hr);
        }
        if (histRows.length > 0) {
          const { error: histErr } = await sbAdmin
            .from("order_status_history")
            .upsert(histRows, { onConflict: "dropi_history_id", ignoreDuplicates: true });
          if (histErr) {
            console.warn(`dropi-refresh-batch: historial no ingerido (${histErr.message})`);
          } else {
            historyIngested += histRows.length;
          }
        }
      } catch (hErr) {
        console.warn(`dropi-refresh-batch: error ingiriendo historial: ${hErr instanceof Error ? hErr.message : String(hErr)}`);
      }

      if (objs.length < PAGE_SIZE) break; // última página
      start += PAGE_SIZE;
      pages++;
      if (pages >= MAX_PAGES) { partial = true; break; }
      await sleep(RATE_LIMIT_MS);
    }

    return jsonResp({
      ok: true,
      refreshed,
      total: refreshed,
      pages: pagesFetched,
      partial,
      rateLimited,
      historyIngested, // >0 confirma que Dropi devolvió history vía la API de integraciones
      synced_at: new Date().toISOString(),
    }, 200, corsHeaders);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResp({ error: msg }, 500, corsHeaders);
  }
});

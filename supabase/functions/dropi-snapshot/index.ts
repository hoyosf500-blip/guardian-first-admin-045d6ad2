// dropi-snapshot: proxy server-side al endpoint integrations de Dropi para
// que el cliente pueda auditar paridad SIN choque de CORS.
//
// Por qué: el browser no puede pegarle directo a api.dropi.ec /api.dropi.co
// (Dropi no expone Access-Control-Allow-Origin para dominios externos). El
// audit de Capa 3 falla con "Failed to fetch". Esta function corre del lado
// servidor, usa la integration-key permanente de la tienda y devuelve el
// snapshot mapeado al shape que dropiAudit.ts espera.
//
// Auth: JWT del usuario (header Authorization). Valida membresía manager
// (owner/supervisor) de la tienda antes de exponer datos Dropi.
//
// Reutiliza el patrón del nightly-reconcile: filter_date_by leído de
// app_settings.dropi_winning_status_filter, paginado seguro con rate limit.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { loadStoreConfig } from "../_shared/dropiStoreConfig.ts";

interface SnapshotBody {
  store_id?: string;
  from?: string; // YYYY-MM-DD
  to?: string;   // YYYY-MM-DD
}

interface SnapshotOrder {
  id: string;
  status: string;
  guia: string;
  trans: string;
  name: string;
}

// 100 es el máximo que acepta Dropi. Más requests = más chance de 429,
// pero Dropi ahora rechaza pageSize > 100 con isSuccess=false.
const PAGE_SIZE = 100;
const RATE_LIMIT_MS = 1500;
// Hard cap por seguridad: 60 páginas × 100 = 6000 órdenes. Una tienda grande
// con 14d de actividad suele estar en 500-2000, así que es holgado.
const MAX_PAGES = 60;
// Backoff exponencial cuando Dropi tira 429: 2s, 4s, 8s. Después de 3 intentos
// cortamos y devolvemos lo parcial. Antes (sin backoff) cortábamos inmediato
// → cobertura baja, el modal mostraba "paridad perfecta" engañoso.
const RL_BACKOFF_MS = [2000, 4000, 8000];
const FALLBACK_FILTER = "FECHA DE CAMBIO DE ESTATUS";

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function jsonResp(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  const CORS = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return jsonResp({ error: "POST only" }, 405, CORS);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return jsonResp({ error: "Falta Authorization header" }, 401, CORS);

    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return jsonResp({ error: "no auth" }, 401, CORS);

    const body = (await req.json().catch(() => ({}))) as SnapshotBody;
    const storeId = String(body.store_id || "").trim();
    const from = String(body.from || "").trim();
    const to = String(body.to || "").trim();
    if (!storeId || !from || !to) {
      return jsonResp({ error: "store_id, from y to (YYYY-MM-DD) requeridos" }, 400, CORS);
    }

    // Service-role para validaciones y lectura de config (evita RLS).
    const sbAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Gate: solo manager (owner/supervisor) — los operadores no auditan.
    const { data: membership } = await sbAdmin
      .from("store_members")
      .select("role")
      .eq("user_id", user.id)
      .eq("store_id", storeId)
      .in("role", ["owner", "supervisor"])
      .maybeSingle();
    if (!membership) {
      return jsonResp({ error: "Solo managers (owner/supervisor) pueden auditar" }, 403, CORS);
    }

    const cfg = await loadStoreConfig(sbAdmin, storeId);
    if (!cfg.apiKey) {
      return jsonResp({ error: "Tienda sin dropi_api_key configurada" }, 400, CORS);
    }

    // Filter dinámico — mismo patrón que health/nightly-reconcile.
    const { data: filterRow } = await sbAdmin.from("app_settings")
      .select("value").eq("key", "dropi_winning_status_filter").maybeSingle();
    const filterDateBy = (filterRow?.value as string) || FALLBACK_FILTER;

    const orders: SnapshotOrder[] = [];
    let start = 0;
    let page = 0;
    let partial = false;
    let partialReason: string | null = null;
    const deadline = Date.now() + 120_000;

    pageLoop: while (page < MAX_PAGES) {
      if (Date.now() > deadline) { partial = true; partialReason = `Time budget (120s) agotado en página ${page}`; break; }
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

      // Backoff exponencial: 3 intentos antes de cortar parcial.
      let res: Response | null = null;
      let rateLimited = false;
      for (let attempt = 0; attempt < RL_BACKOFF_MS.length + 1; attempt++) {
        res = await fetch(url, {
          method: "GET",
          headers: {
            "Accept": "application/json",
            "dropi-integration-key": cfg.apiKey,
            ...(cfg.storeUrl ? { Origin: cfg.storeUrl } : {}),
          },
        });
        if (res.status !== 429) { rateLimited = false; break; }
        rateLimited = true;
        if (attempt < RL_BACKOFF_MS.length) {
          console.warn(`dropi-snapshot: 429 página ${page}, attempt ${attempt + 1}, backoff ${RL_BACKOFF_MS[attempt]}ms`);
          await sleep(RL_BACKOFF_MS[attempt]);
        }
      }

      if (rateLimited) {
        // Después del backoff sigue throttled → corto y devuelvo parcial.
        partial = true;
        partialReason = `Dropi limitó (429) en página ${page} tras ${RL_BACKOFF_MS.length} reintentos`;
        console.warn(`dropi-snapshot: throttle sostenido, devolviendo ${orders.length} órdenes parciales`);
        break pageLoop;
      }
      if (!res || !res.ok) {
        const txt = res ? await res.text().catch(() => "") : "no-response";
        return jsonResp({
          error: `Dropi HTTP ${res?.status ?? "?"}`,
          dropiBody: txt.slice(0, 200),
        }, 502, CORS);
      }

      const data = await res.json().catch(() => ({}));
      const objs = Array.isArray((data as Record<string, unknown>)?.objects)
        ? (data as { objects: Record<string, unknown>[] }).objects
        : [];
      if (objs.length === 0) break;
      for (const o of objs) {
        const dist = (o as Record<string, unknown>).distribution_company as Record<string, unknown> | null;
        orders.push({
          id: String((o as Record<string, unknown>).id ?? ""),
          status: String((o as Record<string, unknown>).status ?? ""),
          guia: String((o as Record<string, unknown>).shipping_guide ?? ""),
          trans: String(dist?.name ?? (o as Record<string, unknown>).shipping_company ?? ""),
          name: (String((o as Record<string, unknown>).name ?? "") + " " +
                 String((o as Record<string, unknown>).surname ?? "")).trim(),
        });
      }
      if (objs.length < PAGE_SIZE) break;
      start += PAGE_SIZE;
      page++;
      // Si llegamos al hard cap, marcar parcial.
      if (page >= MAX_PAGES) {
        partial = true;
        partialReason = `Hard cap alcanzado: ${MAX_PAGES} páginas × ${PAGE_SIZE} = ${MAX_PAGES * PAGE_SIZE} órdenes`;
        break;
      }
      await sleep(RATE_LIMIT_MS);
    }

    return jsonResp({
      orders,
      count: orders.length,
      filter: filterDateBy,
      partial,
      message: partialReason,
    }, 200, CORS);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("dropi-snapshot error:", msg);
    return jsonResp({ error: msg }, 500, getCorsHeaders(req));
  }
});

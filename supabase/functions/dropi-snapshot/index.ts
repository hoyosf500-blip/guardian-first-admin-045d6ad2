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

const PAGE_SIZE = 100;
const RATE_LIMIT_MS = 1500;
const MAX_PAGES = 50; // 5000 órdenes máximo, hard cap
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
    while (page < MAX_PAGES) {
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
      const res = await fetch(url, {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "dropi-integration-key": cfg.apiKey,
          ...(cfg.storeUrl ? { Origin: cfg.storeUrl } : {}),
        },
      });

      if (res.status === 429) {
        // Throttle parcial — devolvemos lo que tengamos.
        console.warn(`dropi-snapshot: 429 en página ${page} start=${start}`);
        return jsonResp({
          orders, partial: true, throttled: true,
          message: `Dropi limitó (429) en página ${page}. Devolviendo ${orders.length} órdenes parciales.`,
        }, 200, CORS);
      }
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        return jsonResp({
          error: `Dropi HTTP ${res.status}`,
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
      await sleep(RATE_LIMIT_MS);
    }

    return jsonResp({ orders, count: orders.length, filter: filterDateBy }, 200, CORS);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("dropi-snapshot error:", msg);
    return jsonResp({ error: msg }, 500, getCorsHeaders(req));
  }
});

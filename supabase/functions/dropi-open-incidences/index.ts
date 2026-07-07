// dropi-open-incidences: devuelve los external_ids de los pedidos con
// INCIDENCIA ABIERTA (por solucionar) — la MISMA consulta que usa el panel de
// Dropi en /dashboard/novelties, capturada en vivo el 2026-07-06:
//
//   GET /api/orders/myorders?orderBy=id&orderDirection=desc&result_number=N
//       &start=0&textToSearch=&status=EN PROCESAMIENTO&supplier_id=null
//       &user_id=null&from_date_last_incidence=<hoy-30d>
//       &until_date_last_incidence=<hoy>&haveIncidenceProcesamiento=true
//       &issue_solved_by_parent_order=false
//
// Por qué existe: un pedido puede estar en ESTADO "NOVEDAD" sin incidencia
// abierta (la transportadora la cerró o la dejó vencer) — Dropi NO lo lista en
// su panel de novedades y ni siquiera acepta resolverlo. El tab Novedades usa
// esta lista para separar "Por gestionar" (incidencia viva) de "Esperando
// transportadora" (estado congelado, sin gestión posible). Ver el 19-vs-9 del
// 2026-07-06.
//
// Auth: JWT del usuario + membresía de la tienda. Usa el token de SESIÓN web
// (auto-login vía ensureFreshSessionToken) porque /api/* no acepta la
// integration-key. Respuestas siempre HTTP 200 con { ok } — el cliente cae a
// "sin separación" (lista única, como antes) ante cualquier fallo.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { loadStoreConfig, isStoreMember } from "../_shared/dropiStoreConfig.ts";
import { ensureFreshSessionToken } from "../_shared/dropiSessionLogin.ts";
import { dropiWebFetch, WebFallbackError } from "../_shared/dropiWebQuote.ts";

// Dropi rechaza result_number > 100 (400 isSuccess=false — ver bug dropi-snapshot).
const PAGE_SIZE = 100;
const MAX_PAGES = 3; // 300 incidencias abiertas es ya un escenario irreal.
const INCIDENCE_WINDOW_DAYS = 30; // misma ventana que el panel de Dropi.

function jsonResp(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

function ymd(d: Date): string {
  return d.toISOString().split("T")[0];
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResp({ ok: false, error: "POST only" }, 405, corsHeaders);
  }

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) {
      return jsonResp({ ok: false, error: "Falta Authorization header" }, 401, corsHeaders);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return jsonResp({ ok: false, error: "no auth" }, 401, corsHeaders);
    }

    const body = (await req.json().catch(() => ({}))) as { store_id?: string };
    const storeId = String(body.store_id || "").trim();
    if (!storeId) {
      return jsonResp({ ok: false, error: "store_id requerido" }, 400, corsHeaders);
    }

    const sbAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const isMember = await isStoreMember(sbAdmin, user.id, storeId);
    if (!isMember) {
      return jsonResp({ ok: false, error: "no sos miembro de esa tienda" }, 403, corsHeaders);
    }

    const cfg = await loadStoreConfig(sbAdmin, storeId);
    try {
      cfg.sessionToken = await ensureFreshSessionToken(sbAdmin, cfg);
    } catch (e) {
      if (e instanceof WebFallbackError) {
        return jsonResp({ ok: false, error: e.message }, 200, corsHeaders);
      }
      throw e;
    }
    if (!cfg.sessionToken) {
      return jsonResp({
        ok: false,
        error: "La tienda no tiene token de sesión Dropi ni login automático configurado (Admin → Credenciales Dropi).",
      }, 200, corsHeaders);
    }

    const until = new Date();
    const from = new Date(until.getTime() - INCIDENCE_WINDOW_DAYS * 86400000);

    const ids: string[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({
        orderBy: "id",
        orderDirection: "desc",
        result_number: String(PAGE_SIZE),
        start: String(page * PAGE_SIZE),
        textToSearch: "",
        // "EN PROCESAMIENTO" acá es el estado de la INCIDENCIA, no del pedido —
        // literal del panel; los pedidos devueltos vienen en estado NOVEDAD.
        status: "EN PROCESAMIENTO",
        supplier_id: "null",
        user_id: "null",
        from_date_last_incidence: ymd(from),
        until_date_last_incidence: ymd(until),
        haveIncidenceProcesamiento: "true",
        issue_solved_by_parent_order: "false",
      });
      const { status, body: resp } = await dropiWebFetch(
        cfg,
        `/api/orders/myorders?${params.toString()}`,
        // logBody:false — el listado trae nombre/teléfono/dirección de clientes.
        { method: "GET", logBody: false },
      );
      if (status < 200 || status >= 300 || resp?.isSuccess === false) {
        const detail = String(resp?.message || resp?.error || "").slice(0, 300);
        return jsonResp({
          ok: false,
          error: `Dropi respondió ${status} al listar novedades abiertas${detail ? `: ${detail}` : ""}`,
          dropiHttpStatus: status,
        }, 200, corsHeaders);
      }
      const rows: unknown[] = Array.isArray(resp?.objects) ? resp.objects : [];
      for (const r of rows) {
        const id = (r as Record<string, unknown>)?.id;
        if (id != null) ids.push(String(id));
      }
      if (rows.length < PAGE_SIZE) break;
    }

    return jsonResp({
      ok: true,
      ids,
      count: ids.length,
      windowDays: INCIDENCE_WINDOW_DAYS,
      asOf: new Date().toISOString(),
    }, 200, corsHeaders);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResp({ ok: false, error: msg }, 200, corsHeaders);
  }
});

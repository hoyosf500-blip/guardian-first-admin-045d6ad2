// Edge Function: dropi-resolve-incidence
//
// Purpose
// -------
// Resolve (or return) a Dropi order that is currently in a NOVEDAD state,
// using the undocumented endpoint `POST /api/orders/saveincidencesolution`
// that Dropi's own web dashboard uses internally. Accepts the same
// `dropi-integration-key` header that `dropi-sync` and `dropi-update-order`
// already use for reads and writes.
//
// Two actions are supported, with two different body templates:
//
// 1) action = "reoffer"
//    Reports a solution (free-text) to Dropi and asks them to re-attempt
//    delivery. Pre-fills nombreConfirma/telefonoBaseConfirma/direccionConfirma
//    with the local order's data so carriers that require those fields
//    (like VELOCES) receive complete data automatically.
//
// 2) action = "return"
//    Tells Dropi to return the package to the sender. No solution text
//    required.
//
// Why integration-key instead of Bearer login
// --------------------------------------------
// Same reason as dropi-update-order: the user's Dropi account has 2FA on,
// so /api/login returns 403. The integration-key is a service token that
// works for both /integrations reads and this incidence endpoint.
//
// Invocation from frontend
// ------------------------
//   supabase.functions.invoke('dropi-resolve-incidence', {
//     body: { externalId, action: 'reoffer', solution: '...' }
//   })
//   supabase.functions.invoke('dropi-resolve-incidence', {
//     body: { externalId, action: 'return' }
//   })
//   supabase.functions.invoke('dropi-resolve-incidence', {
//     body: { dryRun: true }   // connectivity test only
//   })

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { loadStoreConfig, isStoreMember } from "../_shared/dropiStoreConfig.ts";

const DROPI_INCIDENCE_PATH = "/api/orders/saveincidencesolution";
const MAX_SOLUTION_LEN = 500;

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
type SB = SupabaseClient;

type ResolveAction = "reoffer" | "return";

interface LocalOrder {
  id: string;
  storeId: string;
  nombre: string;
  phone: string;
  direccion: string;
}

async function loadLocalOrder(
  sb: SB,
  externalId: string,
): Promise<LocalOrder | null> {
  const { data, error } = await sb
    .from("orders")
    .select("id, store_id, external_id, nombre, phone, direccion")
    .eq("external_id", externalId)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn("loadLocalOrder error:", error.message);
    return null;
  }
  if (!data) return null;

  return {
    id: String(data.id || ""),
    storeId: String((data as { store_id: string }).store_id || ""),
    nombre: String(data.nombre || ""),
    phone: String(data.phone || ""),
    direccion: String(data.direccion || ""),
  };
}

function buildReofferBody(
  externalId: string,
  solution: string,
  local: LocalOrder | null,
): Record<string, unknown> {
  return {
    data: [
      {
        order_id: Number(externalId),
        solution: solution,
        essolucion: 1,
        tipocategoria: 0,
        selectValueConfirma: "1",
        nombreConfirma: local?.nombre ?? "",
        telefonoBaseConfirma: local?.phone ?? "",
        direccionConfirma: local?.direccion ?? "",
        datosAdicionalDir: "",
        fechaConfirma: "",
        timeStart: "",
        timeEnd: "",
        location_url: null,
      },
    ],
  };
}

function buildReturnBody(externalId: string): Record<string, unknown> {
  return {
    data: [
      {
        order_id: Number(externalId),
        CLIENTE_CANCELA_ENTREGA_ENVIO: true,
        solution: "DEVOLVER AL REMITENTE",
        essolucion: 1,
        tipocategoria: 1,
      },
    ],
  };
}

interface DropiResult {
  ok: boolean;
  httpStatus: number;
  body: Record<string, unknown>;
  rawText: string;
}

async function dropiPostIncidence(
  base: string,
  apiKey: string,
  storeUrl: string,
  payload: Record<string, unknown>,
): Promise<DropiResult> {
  const res = await fetch(`${base}${DROPI_INCIDENCE_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "dropi-integration-key": apiKey,
      "Origin": storeUrl,
    },
    body: JSON.stringify(payload),
  });

  const rawText = await res.text();
  let body: Record<string, unknown> = {};
  try { body = rawText ? JSON.parse(rawText) : {}; } catch { body = { raw: rawText }; }
  const ok = res.ok && body.isSuccess !== false;
  return { ok, httpStatus: res.status, body, rawText };
}

async function dropiSanityCheck(
  base: string,
  apiKey: string,
  storeUrl: string,
): Promise<{ ok: boolean; httpStatus: number; message?: string }> {
  const url =
    `${base}/integrations/orders/myorders?result_number=1&start=0` +
    `&date_from=2020-01-01&date_to=2020-01-01` +
    `&filter_date_by=FECHA%20DE%20CREADO&orderBy=id&orderDirection=desc`;

  const res = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "dropi-integration-key": apiKey,
      "Origin": storeUrl,
    },
  });
  const rawText = await res.text();
  let body: Record<string, unknown> = {};
  try { body = rawText ? JSON.parse(rawText) : {}; } catch { body = {}; }
  const ok = res.ok && body.isSuccess !== false;
  const message = ok ? "Conexión OK" : String(body.message || `HTTP ${res.status}`);
  return { ok, httpStatus: res.status, message };
}

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ---- Auth: require a Supabase-authenticated caller ----
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "No autorizado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, supabaseServiceKey);

    const anonKey =
      Deno.env.get("SUPABASE_ANON_KEY") ||
      Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
    const anonClient = createClient(supabaseUrl, anonKey);
    const {
      data: { user },
      error: authError,
    } = await anonClient.auth.getUser(authHeader.replace("Bearer ", ""));
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Token inválido" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // H11: role check. Antes cualquier usuario autenticado (incluso
    // cuentas recién creadas sin rol asignado, o cuentas deprovisioneadas
    // pero todavía con sesión activa) podía empujar incidencias a Dropi.
    const { data: roles } = await sb
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id);
    const allowed = (roles || []).some((r: { role: string }) => r.role === "admin" || r.role === "operator");
    if (!allowed) {
      return new Response(
        JSON.stringify({ error: "No tienes permiso para resolver novedades en Dropi" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ---- Parse body ----
    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      /* no body */
    }

    const dryRun = body.dryRun === true;
    const externalId =
      typeof body.externalId === "string" ? body.externalId.trim() : "";
    const actionRaw =
      typeof body.action === "string" ? body.action.trim() : "";
    const action: ResolveAction | "" =
      actionRaw === "reoffer" || actionRaw === "return" ? actionRaw : "";
    const solutionRaw =
      typeof body.solution === "string" ? body.solution : "";
    const solution = solutionRaw.trim().slice(0, MAX_SOLUTION_LEN);

    // ---- DryRun: connectivity check only (requires storeId in body) ----
    if (dryRun) {
      const storeId = typeof body.storeId === "string" ? body.storeId.trim() : "";
      if (!storeId) {
        return new Response(JSON.stringify({ error: "Falta storeId para dryRun" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const cfg = await loadStoreConfig(sb, storeId);
      if (!cfg.apiKey) {
        return new Response(JSON.stringify({ error: "La tienda no tiene Clave API de Dropi" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const check = await dropiSanityCheck(cfg.base, cfg.apiKey, cfg.storeUrl);
      return new Response(
        JSON.stringify({ ok: check.ok, dryRun: true, dropiHttpStatus: check.httpStatus, message: check.message }),
        { status: check.ok ? 200 : 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ---- Validations for real call ----
    if (!externalId) {
      return new Response(
        JSON.stringify({ error: "Falta externalId en el body" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (!action) {
      return new Response(
        JSON.stringify({ error: "Acción inválida. Usa 'reoffer' o 'return'." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (action === "reoffer" && solution.length < 3) {
      return new Response(
        JSON.stringify({ error: "Solución requerida y con al menos 3 caracteres cuando la acción es 'reoffer'." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ---- Load local order for store + pre-fill ----
    const local = await loadLocalOrder(sb, externalId);
    if (!local) {
      return new Response(
        JSON.stringify({ error: `Pedido ${externalId} no encontrado` }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const isMember = await isStoreMember(sb, user.id, local.storeId);
    if (!isMember) {
      return new Response(
        JSON.stringify({ error: "No perteneces a esta tienda" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const cfg = await loadStoreConfig(sb, local.storeId);
    if (!cfg.apiKey) {
      return new Response(
        JSON.stringify({ error: "La tienda no tiene Clave API de Dropi configurada" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ---- Build body per action ----
    const payload =
      action === "reoffer"
        ? buildReofferBody(externalId, solution, local)
        : buildReturnBody(externalId);

    // ---- Call Dropi ----
    const res = await dropiPostIncidence(cfg.base, cfg.apiKey, cfg.storeUrl, payload);

    if (!res.ok) {
      const errorMsg = `Dropi POST [${res.httpStatus}]: ${String(
        res.body.message || res.body.error || res.rawText || "error",
      ).slice(0, 500)}`;

      await sb.from("sync_logs").insert({
        source: "dropi-resolve-incidence",
        status: "error",
        synced_count: 0,
        duplicates_count: 0,
        total_count: 1,
        triggered_by: user.id,
        error_message: errorMsg,
      });

      return new Response(
        JSON.stringify({
          ok: false,
          error: errorMsg,
          externalId,
          action,
          dropiHttpStatus: res.httpStatus,
        }),
        {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // ---- Success ----
    await sb.from("sync_logs").insert({
      source: "dropi-resolve-incidence",
      status: "success",
      synced_count: 1,
      duplicates_count: 0,
      total_count: 1,
      triggered_by: user.id,
    });

    return new Response(
      JSON.stringify({
        ok: true,
        externalId,
        action,
        dropiHttpStatus: res.httpStatus,
        message: String(res.body.message || "Novedad reportada"),
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    console.error("dropi-resolve-incidence error:", err);
    const msg = err instanceof Error ? err.message : "Error interno";

    // Best-effort error log
    try {
      const sb = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      await sb.from("sync_logs").insert({
        source: "dropi-resolve-incidence",
        status: "error",
        synced_count: 0,
        duplicates_count: 0,
        total_count: 0,
        error_message: msg.slice(0, 500),
      });
    } catch {
      /* ignore */
    }

    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

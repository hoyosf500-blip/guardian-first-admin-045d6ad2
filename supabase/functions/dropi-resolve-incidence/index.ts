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
// Credenciales (actualizado 2026-07-31)
// --------------------------------------------
// Cadena session token → re-login forzado → api_key (ver
// dropiPostIncidenceChain): el endpoint es del plano /api/*, la misma clase
// que el 29-jul dejó de aceptar la api_key en el wallet de un día para otro.
// La api_key sigue funcionando acá HOY y queda como fallback probado (clave
// para la cuenta CO, que tiene 2FA y no siempre tiene session token fresco).
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
import { loadStoreConfig, isStoreMember, type StoreDropiConfig } from "../_shared/dropiStoreConfig.ts";
import { ensureFreshSessionToken } from "../_shared/dropiSessionLogin.ts";
import { dropiWebFetch, WebFallbackError } from "../_shared/dropiWebQuote.ts";

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

// Cadena de credenciales para /api/* (patrón del wallet-sync, auditoría
// 2026-07-31): saveincidencesolution vive en el plano /api/* — la MISMA clase
// de endpoint que el 29-jul empezó a rechazar la api_key de un día para otro
// ("Token not issued to this api", las dos cuentas a la misma hora). Hoy la
// api_key todavía funciona acá, pero si Dropi extiende esa política el botón
// de resolver novedades moriría sin aviso. Orden de intentos:
//   1. session token web (auto-renovado por exp vía ensureFreshSessionToken —
//      es el token que usa el propio panel de Dropi contra este endpoint),
//   2. si Dropi rechaza un session "vigente" (puede revocar antes del exp),
//      UN re-login forzado,
//   3. api_key con dropi-integration-key (el camino probado que funciona hoy).
// Solo un rechazo de AUTH (401/403) avanza la cadena: cualquier otro fallo es
// la respuesta real de Dropi sobre la incidencia y se devuelve tal cual
// (probar otra credencial no cambia nada y suma requests al throttle).
// Sin session token configurado, va DIRECTO a la api_key — cero requests extra
// (el caso CO con 2FA queda idéntico a como venía funcionando).
async function dropiPostIncidenceChain(
  sb: SB,
  cfg: StoreDropiConfig,
  payload: Record<string, unknown>,
): Promise<DropiResult> {
  let sessionToken = "";
  try {
    sessionToken = await ensureFreshSessionToken(sb, cfg);
  } catch (e) {
    console.warn("dropi-resolve-incidence: auto-login falló:", e instanceof Error ? e.message : String(e));
  }

  let renewedOnce = false;
  let tok = sessionToken;
  while (tok) {
    try {
      const { status, body, text } = await dropiWebFetch(
        { base: cfg.base, sessionToken: tok, storeUrl: cfg.storeUrl },
        DROPI_INCIDENCE_PATH,
        { method: "POST", body: payload },
      );
      const bodyObj = (body ?? {}) as Record<string, unknown>;
      const ok = status >= 200 && status < 300 && bodyObj.isSuccess !== false;
      if (ok) return { ok: true, httpStatus: status, body: bodyObj, rawText: text };
      if (status !== 401 && status !== 403) {
        // Respuesta real de Dropi (incidencia ya cerrada, validación, etc.).
        return { ok: false, httpStatus: status, body: bodyObj, rawText: text };
      }
      console.warn(`dropi-resolve-incidence: session token rechazado [${status}]`);
    } catch (e) {
      // dropiWebFetch convierte el 401 típico de token vencido (y el timeout)
      // en WebFallbackError — mismo tratamiento que un rechazo de auth crudo.
      if (!(e instanceof WebFallbackError)) throw e;
      console.warn("dropi-resolve-incidence: session token inválido:", e.message);
    }
    if (renewedOnce) break;
    renewedOnce = true;
    try {
      const forced = await ensureFreshSessionToken(sb, cfg, { force: true });
      if (forced && forced !== tok) { tok = forced; continue; }
    } catch (e) {
      console.warn("dropi-resolve-incidence: re-login forzado falló:", e instanceof Error ? e.message : String(e));
    }
    break;
  }

  if (cfg.apiKey) {
    return await dropiPostIncidence(cfg.base, cfg.apiKey, cfg.storeUrl, payload);
  }
  return {
    ok: false,
    httpStatus: 401,
    body: { message: "Dropi rechazó el token de sesión y la tienda no tiene api_key de respaldo" },
    rawText: "",
  };
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

    // El viejo gate H11 por user_roles (capa GLOBAL de plataforma) se quitó
    // (auditoría 2026-07-31): bloqueaba con 403 a owners/supervisors de tiendas
    // invitadas por el flujo multitienda —que no tienen fila en user_roles—
    // sobre SU propia tienda. El gate real es la MEMBRESÍA de la tienda del
    // pedido (isStoreMember, abajo en cada camino), el mismo patrón que
    // dropi-open-incidences y el resto de las edge multi-tienda. Una cuenta
    // sin ninguna membresía sigue sin poder empujar nada.

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
      // Sin el gate global de user_roles, la membresía es el ÚNICO gate: sin
      // esto cualquier autenticado podría sondear credenciales de tiendas ajenas.
      const isDryMember = await isStoreMember(sb, user.id, storeId);
      if (!isDryMember) {
        return new Response(JSON.stringify({ error: "No perteneces a esta tienda" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
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
    // Con la cadena de credenciales alcanza CUALQUIERA de las dos: session
    // token (camino del panel) o api_key (fallback probado).
    if (!cfg.apiKey && !cfg.sessionToken) {
      return new Response(
        JSON.stringify({ error: "La tienda no tiene credenciales Dropi configuradas (Clave API o token de sesión)" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ---- Build body per action ----
    const payload =
      action === "reoffer"
        ? buildReofferBody(externalId, solution, local)
        : buildReturnBody(externalId);

    // ---- Call Dropi (cadena session → re-login → api_key) ----
    const res = await dropiPostIncidenceChain(sb, cfg, payload);

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
        // store_id: sin esto el log no se puede atribuir en multi-tienda
        // (eran los únicos inserts del área sin tienda).
        store_id: local.storeId,
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
      store_id: local.storeId,
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

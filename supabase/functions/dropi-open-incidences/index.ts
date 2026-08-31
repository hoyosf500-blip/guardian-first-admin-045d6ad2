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
import { respuestaPing } from "../_shared/versionEdge.ts";
import { loadStoreConfig, isStoreMember } from "../_shared/dropiStoreConfig.ts";
import { ensureFreshSessionToken } from "../_shared/dropiSessionLogin.ts";
import { dropiWebFetch, WebFallbackError } from "../_shared/dropiWebQuote.ts";

// Dropi rechaza result_number > 100 (400 isSuccess=false — ver bug dropi-snapshot).
const PAGE_SIZE = 100;
// ⛔ El tope no puede ser SILENCIOSO (auditoría 30-ago-2026). Cuando se agotan
// las páginas con la última llena, lo que falta se archivaba en el bloque
// plegado "Esperando transportadora", bajo el cartel que AFIRMA "su incidencia
// ya no está abierta en Dropi… intentar solucionarlas va a ser rechazado" —
// mientras arriba la pantalla podía mostrar el check verde "No hay novedades
// por gestionar". Trabajo real escondido detrás de un panel cerrado.
// Ahora se devuelve `partial` y el cliente lo trata igual que "no se pudo
// leer": no separa, todo visible como pendiente. Subir el tope sin la bandera
// solo mueve el problema al siguiente número.
const MAX_PAGES = 6;
// 60 y no 30 (H2, auditoría 14-ago-2026): la cola de Novedades del CRM muestra
// 60 días, y con la ventana en 30 una novedad cuya ÚLTIMA incidencia quedó
// registrada hace 31-59 días —pero sigue ABIERTA en Dropi— no aparecía en esta
// lista → el CRM la mandaba a "Esperando transportadora" con calma falsa.
// (El panel de Dropi usa 30; nosotros pedimos lo que nuestra cola necesita.)
const INCIDENCE_WINDOW_DAYS = 60;

function jsonResp(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

function ymd(d: Date): string {
  return d.toISOString().split("T")[0];
}

/**
 * Marca de versión desplegada. Se contesta con `?ping=1` y NO toca la base.
 * ⛔ Subila en TODO commit que cambie esta función o algo que importa: es lo
 *    único que distingue "Lovable dijo que desplegó" de "está desplegado".
 *    El guardián `src/test/edgeVersionPing.test.ts` exige que exista y que el
 *    ping se conteste ANTES de cualquier auth.
 */
const VERSION = "dropi-open-incidences 2026-08-30.1 auditoria-44";

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Antes de auth y sin tocar la base: "¿qué versión está desplegada?".
  { const p = respuestaPing(req, VERSION, corsHeaders); if (p) return p; }
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
    // Se pone en true SOLO si una página vino corta: es la única prueba de que
    // se leyó todo. Salir por agotar MAX_PAGES lo deja en false.
    let completo = false;
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
      if (rows.length < PAGE_SIZE) { completo = true; break; }
    }

    return jsonResp({
      ok: true,
      ids,
      count: ids.length,
      // `partial:true` = se agotaron las páginas con la última LLENA, o sea que
      // hay incidencias abiertas que no entraron. Mismo contrato que
      // dropi-snapshot, que ya devolvía {partial, message}.
      partial: !completo,
      message: completo
        ? undefined
        : `Se leyeron las primeras ${ids.length} incidencias abiertas y puede haber más. Mientras tanto no se separa "esperando transportadora": todo queda visible como pendiente.`,
      windowDays: INCIDENCE_WINDOW_DAYS,
      asOf: new Date().toISOString(),
    }, 200, corsHeaders);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResp({ ok: false, error: msg }, 200, corsHeaders);
  }
});

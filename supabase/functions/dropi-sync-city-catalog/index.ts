// dropi-sync-city-catalog: trae el catálogo COMPLETO de provincias/ciudades de
// Dropi (POST /api/locations) y lo vuelca en `dropi_city_catalog`, agregando SOLO
// lo que falte. Es la fuente de los desplegables del editor de orden — así el
// operador elige de la lista real de Dropi en vez de escribir.
//
// Por qué existe: el catálogo se sembró a mano (410 ciudades EC) y crecía de a
// una por el self-heal de las cotizaciones. El dueño pidió AUDITAR que estén
// TODAS las ciudades de Dropi — esto lo hace de una, contra la API, y es
// re-ejecutable cuando Dropi agregue destinos nuevos.
//
// Seguro por diseño: upsert con ignoreDuplicates=true → NUNCA pisa una fila
// existente (respeta las cargadas a mano con cod_dane real); solo INSERTA las
// que faltan. Devuelve el conteo antes/después para que el resultado sea auditable.
//
// Auth: JWT de miembro de la tienda. /api/locations necesita el token de sesión
// web (se refresca solo en EC vía ensureFreshSessionToken).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { loadStoreConfig, isStoreMember } from "../_shared/dropiStoreConfig.ts";
import { ensureFreshSessionToken } from "../_shared/dropiSessionLogin.ts";
import { dropiWebFetch, normUp } from "../_shared/dropiWebQuote.ts";

function jsonResp(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResp({ error: "POST only" }, 405, corsHeaders);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return jsonResp({ error: "Falta Authorization" }, 401, corsHeaders);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return jsonResp({ error: "no auth" }, 401, corsHeaders);

    const body = (await req.json().catch(() => ({}))) as { store_id?: string };
    const storeId = String(body.store_id || "").trim();
    if (!storeId) return jsonResp({ error: "store_id requerido" }, 400, corsHeaders);

    const sbAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    if (!(await isStoreMember(sbAdmin, user.id, storeId))) {
      return jsonResp({ error: "no sos miembro de esa tienda" }, 403, corsHeaders);
    }

    const cfg = await loadStoreConfig(sbAdmin, storeId);
    // /api/locations va con token de SESIÓN web (no la api_key). En EC se refresca solo.
    cfg.sessionToken = await ensureFreshSessionToken(sbAdmin, cfg);
    if (!cfg.sessionToken) {
      return jsonResp({ error: "La tienda no tiene token de sesión Dropi para leer el catálogo." }, 400, corsHeaders);
    }

    const countryParam = cfg.countryCode === "EC" ? "ECUADOR" : "COLOMBIA";
    const { status, body: locBody } = await dropiWebFetch(cfg, "/api/locations", {
      method: "POST",
      body: { country: countryParam },
      logBody: false,
    });
    if (status < 200 || status >= 300) {
      return jsonResp({ error: `Dropi /api/locations respondió ${status}`, dropiStatus: status }, 502, corsHeaders);
    }

    // Shape: { data: [{ label, id_state, items: [{ label, id_city }] }] }
    const states = Array.isArray((locBody as Record<string, unknown>)?.data)
      ? ((locBody as { data: Record<string, unknown>[] }).data)
      : [];
    const rows: Array<Record<string, unknown>> = [];
    for (const st of states) {
      const deptLabel = String((st as Record<string, unknown>)?.label || "").trim();
      const deptId = Number((st as Record<string, unknown>)?.id_state) || null;
      const items = Array.isArray((st as Record<string, unknown>)?.items)
        ? ((st as { items: Record<string, unknown>[] }).items) : [];
      for (const it of items) {
        const cityLabel = String(it?.label || "").trim();
        const cityId = Number(it?.id_city);
        if (!cityLabel || !deptLabel || !Number.isFinite(cityId)) continue;
        rows.push({
          country_code: cfg.countryCode,
          city_norm: normUp(cityLabel),
          dept_norm: normUp(deptLabel),
          city_id: cityId,
          name: cityLabel,
          department_id: deptId,
          cod_dane: "",
        });
      }
    }

    if (rows.length === 0) {
      return jsonResp({ error: "Dropi no devolvió ciudades", dropiSample: JSON.stringify(locBody).slice(0, 200) }, 502, corsHeaders);
    }

    const countCatalog = async () => {
      const { count } = await sbAdmin
        .from("dropi_city_catalog")
        .select("id", { count: "exact", head: true })
        .eq("country_code", cfg.countryCode);
      return count ?? 0;
    };
    const before = await countCatalog();

    // ignoreDuplicates: NUNCA pisa una fila existente (respeta cod_dane cargado a
    // mano). Solo INSERTA las ciudades que faltan.
    let upsertError: string | null = null;
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      const { error } = await sbAdmin
        .from("dropi_city_catalog")
        .upsert(batch, { onConflict: "country_code,city_norm,dept_norm", ignoreDuplicates: true });
      if (error) { upsertError = error.message; break; }
    }
    if (upsertError) return jsonResp({ error: `No se pudo guardar el catálogo: ${upsertError}` }, 500, corsHeaders);

    const after = await countCatalog();
    const provincias = [...new Set(rows.map((r) => r.dept_norm))].sort();

    return jsonResp({
      ok: true,
      country: cfg.countryCode,
      dropi_ciudades: rows.length,
      dropi_provincias: provincias.length,
      catalogo_antes: before,
      catalogo_despues: after,
      agregadas: after - before,
      provincias,
    }, 200, corsHeaders);
  } catch (e) {
    return jsonResp({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

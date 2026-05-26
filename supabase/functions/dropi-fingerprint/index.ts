import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { loadStoreConfig, storeIdFromExternalId, isStoreMember } from "../_shared/dropiStoreConfig.ts";

// api-v2.dropi.{tld} — el fingerprint vive en un host por país. Antes estaba
// hardcoded a .co y para tiendas EC devolvía 401 "Invalid token" porque el
// token EC no es válido en el tenant CO.
const FINGERPRINT_TLD: Record<string, string> = {
  CO: "co", MX: "mx", EC: "ec", CL: "cl", PE: "pe", PA: "pa",
  AR: "ar", GT: "gt", PY: "com.py", VE: "com.ve", BO: "bo", CR: "cr",
};
function fingerprintBase(cc: string): string {
  const tld = FINGERPRINT_TLD[String(cc || "CO").toUpperCase()] || "co";
  return `https://api-v2.dropi.${tld}/bff/customers/fingerprint/v2`;
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "No autorizado" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const sbUrlAuth = Deno.env.get("SUPABASE_URL")!;
  const anonKeyAuth = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
  const anonClientAuth = createClient(sbUrlAuth, anonKeyAuth);
  const { data: { user: userAuth }, error: authErrorFp } = await anonClientAuth.auth.getUser(
    authHeader.replace("Bearer ", ""),
  );
  if (authErrorFp || !userAuth) {
    return new Response(JSON.stringify({ error: "Token inválido" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const sbUrl = Deno.env.get("SUPABASE_URL")!;
    const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(sbUrl, sbKey);

    const body = await req.json();
    const { phone, storeId: storeIdRaw, externalId } = body as { phone: string; storeId?: string; externalId?: string };

    if (!phone || typeof phone !== "string") {
      return new Response(
        JSON.stringify({ ok: false, error: "Falta el teléfono del cliente." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Resolver storeId: explícito > derivado de externalId
    let storeId = typeof storeIdRaw === "string" && storeIdRaw.trim() ? storeIdRaw.trim() : "";
    if (!storeId && typeof externalId === "string" && externalId.trim()) {
      storeId = (await storeIdFromExternalId(sb, externalId.trim())) || "";
    }
    if (!storeId) {
      return new Response(JSON.stringify({ ok: false, error: "Falta storeId o externalId" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const isMember = await isStoreMember(sb, userAuth.id, storeId);
    if (!isMember) {
      return new Response(JSON.stringify({ ok: false, error: "No perteneces a esta tienda" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const cfg = await loadStoreConfig(sb, storeId);
    // 2026-05-22: usar INTEGRATIONS api_key (permanente). Verificado con curl real:
    // /bff/customers/fingerprint/v2 con session_token devuelve 401 "Invalid token",
    // con api_key devuelve 200 con data completa. El api_key es el correcto.
    const authToken = cfg.apiKey || cfg.sessionToken;
    if (!authToken) {
      return new Response(JSON.stringify({
        ok: false,
        error: "Credencial Dropi no configurada para esta tienda. Configúrala en Ajustes → Tienda.",
      }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Decode user_id from the JWT (payload.sub) — presente en ambos tokens
    let dropiUserId: number;
    try {
      const parts = authToken.split(".");
      const payload = JSON.parse(atob(parts[1]));
      dropiUserId = payload.sub;
      if (!dropiUserId) throw new Error("No sub in token");
    } catch {
      return new Response(JSON.stringify({
        ok: false, error: "Token Dropi inválido — no se pudo decodificar.",
      }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Normalización country-aware: CO usa prefijo 57, EC usa 593 (+ a veces un
    // 0 inicial estilo local "0991234567"). Antes hardcodeaba /^57/ y para EC
    // mandaba "59398..." sin limpiar → Dropi devolvía fingerprint vacío o 4xx.
    const stripped = phone.replace(/[\s\-+]/g, "");
    const cleanPhone = (cfg.countryCode === "EC")
      ? stripped.replace(/^593/, "").replace(/^0/, "")
      : stripped.replace(/^57/, "");

    const url = `${FINGERPRINT_URL}?country_code=${encodeURIComponent(cfg.countryCode)}&user_id=${dropiUserId}&phone=${encodeURIComponent(cleanPhone)}&months=0`;
    const apiRes = await fetch(url, {
      headers: { Authorization: `Bearer ${authToken}` },
    });


    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error("Dropi fingerprint error:", apiRes.status, errText);

      if (apiRes.status === 401) {
        return new Response(
          JSON.stringify({
            ok: false,
            error:
              "Token de sesión Dropi expirado. Actualízalo en Admin → Token sesión Dropi.",
            expired: true,
          }),
          {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      return new Response(
        JSON.stringify({
          ok: false,
          error: `Error Dropi (${apiRes.status})`,
        }),
        {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const apiData = await apiRes.json();

    if (!apiData.is_successful || !apiData.data) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: apiData.status_reason || "Dropi no devolvió datos",
        }),
        {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Return the fingerprint data
    return new Response(
      JSON.stringify({
        ok: true,
        fingerprint: apiData.data,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("dropi-fingerprint error:", msg);
    return new Response(
      JSON.stringify({ ok: false, error: msg }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";

const FINGERPRINT_URL =
  "https://api-v2.dropi.co/bff/customers/fingerprint/v2";

// ─── Handler ──────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const sbUrl = Deno.env.get("SUPABASE_URL")!;
    const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(sbUrl, sbKey);

    // Read Dropi session token from app_settings
    const { data: tokenRow } = await sb
      .from("app_settings")
      .select("value")
      .eq("key", "dropi_session_token")
      .maybeSingle();

    const sessionToken = tokenRow?.value || "";
    if (!sessionToken) {
      return new Response(
        JSON.stringify({
          ok: false,
          error:
            "Token de sesión Dropi no configurado. Ve a Admin → Token sesión Dropi.",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Decode user_id from the JWT (payload.sub)
    let userId: number;
    try {
      const parts = sessionToken.split(".");
      const payload = JSON.parse(atob(parts[1]));
      userId = payload.sub;
      if (!userId) throw new Error("No sub in token");
    } catch {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "Token de sesión Dropi inválido — no se pudo decodificar.",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Parse request body
    const body = await req.json();
    const { phone } = body as { phone: string };

    if (!phone || typeof phone !== "string") {
      return new Response(
        JSON.stringify({ ok: false, error: "Falta el teléfono del cliente." }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Clean phone — strip +57, spaces, dashes
    const cleanPhone = phone.replace(/[\s\-+]/g, "").replace(/^57/, "");

    // Call Dropi fingerprint API
    const url = `${FINGERPRINT_URL}?country_code=CO&user_id=${userId}&phone=${encodeURIComponent(cleanPhone)}&months=0`;
    const apiRes = await fetch(url, {
      headers: { Authorization: `Bearer ${sessionToken}` },
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

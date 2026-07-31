// google-places-proxy — Proxy autenticado para Google Places API.
// Permite usar Autocomplete + Place Details desde el browser sin
// exponer GOOGLE_MAPS_API_KEY en el bundle del cliente.
//
// Usa la Places API (New) — endpoints REST en places.googleapis.com.
//
// Input (POST body):
//   { op: "autocomplete", input: string, ciudad?: string, sessionToken?: string,
//     store_id?: string, country_code?: "CO" | "EC" }
//   { op: "details",      place_id: string, sessionToken?: string, store_id?: string }
//
// `country_code` (o el país de `store_id`) decide la región de Google: sin él
// una tienda de Ecuador buscaría direcciones dentro de Colombia. Default 'CO'.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { isStoreMember } from "../_shared/dropiStoreConfig.ts";

interface AutocompletePrediction {
  description: string;
  place_id: string;
  structured_formatting?: { main_text: string; secondary_text: string };
}

interface PlaceDetailsResult {
  place_id: string;
  formatted_address: string;
  geometry?: { location?: { lat: number; lng: number } };
  address_components?: Array<{ long_name: string; short_name: string; types: string[] }>;
}

async function autocomplete(
  apiKey: string,
  input: string,
  ciudad: string | undefined,
  sessionToken: string | undefined,
  countryCode: string,
): Promise<AutocompletePrediction[]> {
  const url = "https://places.googleapis.com/v1/places:autocomplete";
  const body: Record<string, unknown> = {
    input,
    languageCode: "es",
    regionCode: countryCode,
    includedRegionCodes: [countryCode],
  };
  if (sessionToken) body.sessionToken = sessionToken;
  if (ciudad) body.locationBias = undefined; // No biasing por ciudad (ya restringimos al país)

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error("[autocomplete] HTTP", res.status, await res.text());
    return [];
  }
  const data = await res.json();
  const suggestions = Array.isArray(data?.suggestions) ? data.suggestions : [];
  return suggestions
    .filter((s: { placePrediction?: unknown }) => s.placePrediction)
    .map((s: { placePrediction: { placeId: string; text?: { text?: string }; structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } } } }) => {
      const p = s.placePrediction;
      return {
        place_id: p.placeId,
        description: p.text?.text ?? "",
        structured_formatting: {
          main_text: p.structuredFormat?.mainText?.text ?? "",
          secondary_text: p.structuredFormat?.secondaryText?.text ?? "",
        },
      } as AutocompletePrediction;
    });
}

async function getDetails(
  apiKey: string,
  placeId: string,
  sessionToken: string | undefined,
): Promise<PlaceDetailsResult | null> {
  const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}${sessionToken ? `?sessionToken=${encodeURIComponent(sessionToken)}` : ""}`;
  const res = await fetch(url, {
    headers: {
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "id,formattedAddress,location,addressComponents",
    },
  });
  if (!res.ok) {
    console.error("[details] HTTP", res.status, await res.text());
    return null;
  }
  const data = await res.json();
  if (!data?.id) return null;
  return {
    place_id: data.id,
    formatted_address: data.formattedAddress ?? "",
    geometry: data.location
      ? { location: { lat: data.location.latitude, lng: data.location.longitude } }
      : undefined,
    address_components: Array.isArray(data.addressComponents)
      ? data.addressComponents.map((c: { longText?: string; shortText?: string; types?: string[] }) => ({
          long_name: c.longText ?? "",
          short_name: c.shortText ?? "",
          types: c.types ?? [],
        }))
      : undefined,
  };
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // JWT auth
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "No autorizado" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const sbUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
  const anonClient = createClient(sbUrl, anonKey);
  const { data: { user }, error: authErr } = await anonClient.auth.getUser(
    authHeader.replace("Bearer ", ""),
  );
  if (authErr || !user) {
    return new Response(JSON.stringify({ error: "Token inválido" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const apiKey = Deno.env.get("GOOGLE_MAPS_API_KEY");
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "GOOGLE_MAPS_API_KEY no configurada" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: { op?: string; input?: string; ciudad?: string; place_id?: string; sessionToken?: string; store_id?: string; country_code?: string; country?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "JSON inválido" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // La cuota de Google es UNA sola para toda la plataforma: estar logueado no
  // alcanza para quemarla. Con store_id se exige membresía de ESA tienda; sin él
  // (callers viejos) al menos pertenecer a alguna tienda.
  const sbAdmin = createClient(sbUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const storeId = typeof body.store_id === "string" ? body.store_id.trim() : "";
  if (storeId) {
    if (!(await isStoreMember(sbAdmin, user.id, storeId))) {
      return new Response(JSON.stringify({ error: "No sos miembro de esta tienda" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  } else {
    const { data: memberships } = await sbAdmin
      .from("store_members")
      .select("store_id")
      .eq("user_id", user.id)
      .limit(1);
    if (!memberships || memberships.length === 0) {
      return new Response(JSON.stringify({ error: "Sin tiendas asignadas" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  // País de la búsqueda: explícito > el de la tienda > CO.
  let countryCode = String(body.country_code || body.country || "").trim().toUpperCase();
  if (!countryCode && storeId) {
    const { data: store } = await sbAdmin
      .from("stores")
      .select("country_code")
      .eq("id", storeId)
      .maybeSingle();
    countryCode = String(store?.country_code || "").trim().toUpperCase();
  }
  if (countryCode !== "CO" && countryCode !== "EC") countryCode = "CO";

  try {
    if (body.op === "autocomplete") {
      const input = (body.input || "").trim();
      if (input.length < 3) {
        return new Response(JSON.stringify({ predictions: [] }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      // Cap diario: cada autocomplete cuesta ~$0.00283.
      const { data: quotaOK } = await sbAdmin.rpc("consume_google_quota", { p_amount_usd: 0.003 });
      if (!quotaOK) {
        return new Response(JSON.stringify({ predictions: [], cap_exceeded: true }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const predictions = await autocomplete(apiKey, input, body.ciudad, body.sessionToken, countryCode);
      return new Response(JSON.stringify({ predictions }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (body.op === "details") {
      const placeId = (body.place_id || "").trim();
      if (!placeId) {
        return new Response(JSON.stringify({ error: "place_id requerido" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { data: quotaOK } = await sbAdmin.rpc("consume_google_quota", { p_amount_usd: 0.005 });
      if (!quotaOK) {
        return new Response(JSON.stringify({ result: null, cap_exceeded: true }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const result = await getDetails(apiKey, placeId, body.sessionToken);
      return new Response(JSON.stringify({ result }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "op inválida (usa 'autocomplete' o 'details')" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[google-places-proxy] error", e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

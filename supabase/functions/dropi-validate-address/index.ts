// dropi-validate-address — Valida que una dirección esté bien escrita
// y exista en el mundo real. Combina dos checks:
//
//   1. Heurística regex (Colombia): tipo de vía + números + longitud.
//   2. Geocoding via Nominatim (OpenStreetMap): confirma existencia.
//
// Cachea el resultado 24h en la tabla `address_validations` para no
// quemar el rate limit de Nominatim (1 req/seg, ToS).
//
// Input (POST body):  { direccion, ciudad?, departamento? }
// Output:             { status, score, issues, geocoded?, cached }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { mapAddressKind } from "./_addressKind.ts";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const NOMINATIM_USER_AGENT = "guardian-first-admin/1.0 (admin@guardianfirst.app)";
const CACHE_TTL_HOURS = 24;

interface ValidationResult {
  status: "valid" | "suspicious" | "invalid";
  score: number;
  issues: string[];
  geocoded?: { lat: number; lng: number; display: string };
  cached: boolean;
}

// ── Normalización para cache_key ───────────────────────────────
function normalizeForCache(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // sin acentos
    .replace(/[^\w\s]/g, " ")                         // sin puntuación
    .replace(/\s+/g, " ")
    .trim();
}

function buildCacheKey(direccion: string, ciudad: string, departamento: string): string {
  return [
    normalizeForCache(direccion),
    normalizeForCache(ciudad),
    normalizeForCache(departamento),
  ].join("|");
}

// ── Heurística regex para direcciones colombianas ─────────────
//
// Tipos de vía: CALLE/CL/CLL, CARRERA/CR/KR/CRA, AVENIDA/AV/AVDA,
// DIAGONAL/DG, TRANSVERSAL/TV, MANZANA/MZ, CIRCULAR, AUTOPISTA.
// Números: #X-XX, X-XX, "MZ X CASA Y", "MANZANA X LOTE Y".
const VIA_TYPE_REGEX = new RegExp(
  "\\b(?:calle|cl|cll|carrera|cr|kr|cra|avenida|av|avda|diagonal|dg|diag|" +
  "transversal|tv|trv|manzana|mz|mza|circular|circ|autopista|autop)\\d*\\b",
  "i"
);
const NUMBERS_REGEX = /\d+[\s\-#]+\d+/;

function heuristicValidate(direccion: string): { score: number; issues: string[] } {
  const issues: string[] = [];
  let score = 0;
  const dir = (direccion || "").trim();

  if (!dir) {
    return { score: 0, issues: ["empty"] };
  }
  if (dir.length < 8) {
    issues.push("too_short");
    return { score: 10, issues };
  }

  if (VIA_TYPE_REGEX.test(dir)) {
    score += 40;
  } else {
    issues.push("no_via_type");
  }

  if (NUMBERS_REGEX.test(dir)) {
    score += 35;
  } else {
    issues.push("no_numbers");
  }

  if (dir.length >= 12) {
    score += 15;
  } else {
    issues.push("short_length");
  }

  // Bonus: referencias adicionales (barrio, casa, apto)
  if (/\b(barrio|brrio|brr|casa|cs|apto|apartamento|edificio|edif|torre|piso|interior|int)\b/i.test(dir)) {
    score += 10;
  }

  // Penalización: caracteres repetidos o solo números
  if (/(.)\1{4,}/.test(dir)) {
    score = Math.max(0, score - 30);
    issues.push("repeated_chars");
  }
  if (/^[\d\s\-#]+$/.test(dir)) {
    score = Math.max(0, score - 30);
    issues.push("no_letters");
  }

  return { score: Math.min(100, score), issues };
}

// ── Google Maps Address Validation API ────────────────────────
interface GoogleValidationResult {
  status: "valid" | "suspicious";
  score: number;
  geocoded: { lat: number; lng: number; display: string } | null;
}

async function googleValidateAddress(
  direccion: string,
  ciudad: string,
  departamento: string,
): Promise<GoogleValidationResult | null> {
  const apiKey = Deno.env.get("GOOGLE_MAPS_API_KEY");
  if (!apiKey) return null;

  const url = `https://addressvalidation.googleapis.com/v1:validateAddress?key=${apiKey}`;
  const cityRegion = [ciudad, departamento].filter(Boolean).join(", ");
  const addressLines = [direccion];
  if (cityRegion) addressLines.push(cityRegion);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address: { regionCode: "CO", addressLines },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data?.result;
    if (!result) return null;

    const verdict = result.verdict ?? {};
    const addressComplete = verdict.addressComplete === true;
    const hasUnconfirmed = verdict.hasUnconfirmedComponents === true;
    const hasInferred = verdict.hasInferredComponents === true;
    const hasReplaced = verdict.hasReplacedComponents === true;

    const loc = result.geocode?.location;
    const formatted = result.address?.formattedAddress ?? "";
    const geocoded = (loc && typeof loc.latitude === "number" && typeof loc.longitude === "number")
      ? { lat: loc.latitude, lng: loc.longitude, display: formatted }
      : null;

    if (hasUnconfirmed) {
      return { status: "suspicious", score: 60, geocoded };
    }
    if (addressComplete) {
      return { status: "valid", score: 100, geocoded };
    }
    if (hasInferred || hasReplaced) {
      return { status: "valid", score: 85, geocoded };
    }
    // Sin verdict claro: tratamos como sospechosa si hay geocoded, sino null para fallback
    if (geocoded) {
      return { status: "suspicious", score: 55, geocoded };
    }
    return null;
  } catch (_e) {
    return null;
  }
}

// ── Geocoding via Nominatim (fallback) ─────────────────────────
async function nominatimGeocode(
  direccion: string,
  ciudad: string,
  departamento: string,
): Promise<{ lat: number; lng: number; display: string } | null> {
  const parts = [direccion, ciudad, departamento, "Colombia"].filter(Boolean);
  const q = parts.join(", ");
  const url = `${NOMINATIM_URL}?q=${encodeURIComponent(q)}&format=json&countrycodes=co&limit=1&addressdetails=0`;

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": NOMINATIM_USER_AGENT,
        "Accept": "application/json",
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    const hit = data[0];
    if (!hit.lat || !hit.lon) return null;
    return {
      lat: parseFloat(hit.lat),
      lng: parseFloat(hit.lon),
      display: hit.display_name ?? "",
    };
  } catch (_e) {
    // Si Nominatim falla, no rompemos: el resultado queda en
    // "suspicious" si la heurística pasaba.
    return null;
  }
}

function decideStatus(
  heuristicScore: number,
  geocoded: { lat: number; lng: number; display: string } | null,
): "valid" | "suspicious" | "invalid" {
  if (heuristicScore < 40) return "invalid";
  if (geocoded) return "valid";
  return "suspicious";
}

function combineScore(heuristicScore: number, geocoded: unknown): number {
  return Math.min(100, heuristicScore + (geocoded ? 20 : 0));
}

// ── Handler ────────────────────────────────────────────────────
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

  let body: { direccion?: string; ciudad?: string; departamento?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Body JSON inválido" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const direccion = (body.direccion || "").trim();
  const ciudad = (body.ciudad || "").trim();
  const departamento = (body.departamento || "").trim();

  if (!direccion) {
    const result: ValidationResult = {
      status: "invalid",
      score: 0,
      issues: ["empty"],
      cached: false,
    };
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const cacheKey = buildCacheKey(direccion, ciudad, departamento);

  const sbServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(sbUrl, sbServiceKey);

  // ── Address kind detection (pickup / rural / urban / unknown) ──
  const kind = mapAddressKind(direccion);

  // Pickup-office: no requiere validación Google ni dirección detallada.
  if (kind === "pickup_office") {
    return new Response(JSON.stringify({
      ok: true,
      decision: "green",
      address_kind: "pickup_office",
      missing_fields: [],
      suggested_customer_message: "",
      suggested_address: null,
      // Mantener compatibilidad con el shape ValidationResult original
      status: "valid",
      score: 100,
      issues: [],
      cached: false,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // ── Lookup de cache ──────────────────────────────────────────
  const { data: cached } = await sb
    .from("address_validations")
    .select("*")
    .eq("cache_key", cacheKey)
    .maybeSingle();

  if (cached) {
    const ageMs = Date.now() - new Date(cached.validated_at).getTime();
    const ttlMs = CACHE_TTL_HOURS * 3600 * 1000;
    if (ageMs < ttlMs) {
      const result: ValidationResult = {
        status: cached.status,
        score: cached.score,
        issues: cached.issues ?? [],
        geocoded: cached.geocoded_lat !== null && cached.geocoded_lng !== null
          ? {
              lat: Number(cached.geocoded_lat),
              lng: Number(cached.geocoded_lng),
              display: cached.geocoded_display ?? "",
            }
          : undefined,
        cached: true,
      };
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  // ── Validación nueva ─────────────────────────────────────────
  // PASO A: Heurística regex local
  const { score: heuristicScore, issues } = heuristicValidate(direccion);

  // Si la heurística falla rotundamente, no llamamos APIs externas
  if (heuristicScore < 40) {
    const invalidStatus: "invalid" = "invalid";
    await sb
      .from("address_validations")
      .upsert({
        cache_key: cacheKey,
        direccion,
        ciudad: ciudad || null,
        departamento: departamento || null,
        status: invalidStatus,
        score: heuristicScore,
        issues,
        geocoded_lat: null,
        geocoded_lng: null,
        geocoded_display: null,
        validated_at: new Date().toISOString(),
      }, { onConflict: "cache_key" });
    return new Response(
      JSON.stringify({ status: invalidStatus, score: heuristicScore, issues, cached: false } as ValidationResult),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // PASO B: Google Maps Address Validation
  let geocoded: { lat: number; lng: number; display: string } | null = null;
  let status: "valid" | "suspicious" | "invalid";
  let finalScore: number;
  let decision: "green" | "yellow" | "red" | null = null;
  let missing_fields: string[] = [];
  let suggested_customer_message = "";
  let suggested_address: string | null = null;

  // Cap diario server-side: gate antes del fetch a Google.
  const { data: quotaOK } = await sb.rpc("consume_google_quota", { p_amount_usd: 0.005 });
  if (!quotaOK) {
    return new Response(JSON.stringify({
      ok: true,
      decision: "yellow",
      address_kind: kind,
      missing_fields: [],
      suggested_customer_message: "",
      suggested_address: null,
      localOnly: true,
      fallback_reason: "cap_exceeded",
      // Compatibilidad con shape ValidationResult original
      status: "suspicious",
      score: heuristicScore,
      issues,
      cached: false,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const googleResult = await googleValidateAddress(direccion, ciudad, departamento);

  if (googleResult) {
    status = googleResult.status;
    finalScore = googleResult.score;
    geocoded = googleResult.geocoded;
    // Cuando Google devuelve un formattedAddress (geocoded.display), lo
    // usamos como sugerencia para el badge "¿Quisiste decir?".
    suggested_address = googleResult.geocoded?.display ?? null;
  } else {
    // PASO C: Fallback a Nominatim/OSM
    geocoded = await nominatimGeocode(direccion, ciudad, departamento);
    status = decideStatus(heuristicScore, geocoded);
    finalScore = combineScore(heuristicScore, geocoded);
  }

  // PASO D: Capa Haiku 4.5 sólo para casos ambiguos.
  // Aproxima `googleResult.suspicious || hasUnconfirmedComponents` con status==="suspicious".
  if (googleResult && googleResult.status === "suspicious") {
    const haikuQuotaRes = await sb.rpc("consume_google_quota", { p_amount_usd: 0.0005 });
    const haikuQuotaOK = haikuQuotaRes?.data === true;
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");

    if (haikuQuotaOK && anthropicKey) {
      try {
        const haikuRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": anthropicKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 200,
            messages: [{
              role: "user",
              content: `Eres un analista de logística COD en Colombia. Analiza esta dirección y decide si es entregable.\n\nDirección: ${direccion}\nCiudad: ${ciudad}\nDepartamento: ${departamento}\n\nResponde SOLO con JSON:\n{\n  "decision": "green" | "yellow" | "red",\n  "address_kind": "urban" | "rural" | "pickup_office" | "unknown",\n  "missing_fields": [...],\n  "suggested_customer_message": "Hola, ...",\n  "suggested_address": "<dirección corregida si podés sugerirla, en formato 'Calle X # Y-Z, Barrio, Ciudad' — null si no podés sugerir>"\n}`,
            }],
          }),
        });

        if (haikuRes.ok) {
          const haikuData = await haikuRes.json();
          const text = haikuData?.content?.[0]?.text || "";
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            decision = (parsed.decision ?? null) as typeof decision;
            missing_fields = Array.isArray(parsed.missing_fields) ? parsed.missing_fields : [];
            suggested_customer_message = typeof parsed.suggested_customer_message === "string"
              ? parsed.suggested_customer_message
              : "";
            // Haiku puede sobreescribir la sugerencia de Google si tiene una
            // mejor (formato más limpio). Si Haiku no devuelve nada, mantenemos
            // la de Google (suggested_address ya fue seteado arriba).
            if (typeof parsed.suggested_address === "string" && parsed.suggested_address.trim()) {
              suggested_address = parsed.suggested_address.trim();
            }
          }
        }
      } catch (_e) {
        // Si Haiku falla por cualquier razón, no rompemos: seguimos con el resultado de Google.
      }
    }
  }

  await sb
    .from("address_validations")
    .upsert({
      cache_key: cacheKey,
      direccion,
      ciudad: ciudad || null,
      departamento: departamento || null,
      status,
      score: finalScore,
      issues,
      geocoded_lat: geocoded?.lat ?? null,
      geocoded_lng: geocoded?.lng ?? null,
      geocoded_display: geocoded?.display ?? null,
      validated_at: new Date().toISOString(),
    }, { onConflict: "cache_key" });

  const result: ValidationResult = {
    status,
    score: finalScore,
    issues,
    geocoded: geocoded ?? undefined,
    cached: false,
  };

  // Anexar campos del nuevo contrato (decision/address_kind/...) sin romper el shape original.
  const responseBody = {
    ...result,
    ok: true,
    decision,
    address_kind: kind,
    missing_fields,
    suggested_customer_message,
    suggested_address,
  };

  return new Response(JSON.stringify(responseBody), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});

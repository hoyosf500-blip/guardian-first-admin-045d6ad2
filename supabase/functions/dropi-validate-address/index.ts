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
  "\\b(calle|cl|cll|carrera|cr|kr|cra|avenida|av|avda|diagonal|dg|diag|" +
  "transversal|tv|trv|manzana|mz|mza|circular|circ|autopista|autop)\\b",
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

// ── Geocoding via Nominatim ────────────────────────────────────
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
  const { score: heuristicScore, issues } = heuristicValidate(direccion);

  // Solo geocoding si la heurística pasó el threshold mínimo.
  let geocoded: { lat: number; lng: number; display: string } | null = null;
  if (heuristicScore >= 40) {
    geocoded = await nominatimGeocode(direccion, ciudad, departamento);
  }

  const status = decideStatus(heuristicScore, geocoded);
  const finalScore = combineScore(heuristicScore, geocoded);

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

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});

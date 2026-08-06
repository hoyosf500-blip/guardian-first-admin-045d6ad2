// dropi-validate-address — Valida que una dirección esté bien escrita
// y exista en el mundo real. Combina dos checks:
//
//   1. Heurística regex (Colombia): tipo de vía + números + longitud.
//   2. Geocoding via Nominatim (OpenStreetMap): confirma existencia.
//
// Cachea el resultado 24h en la tabla `address_validations` para no
// quemar el rate limit de Nominatim (1 req/seg, ToS).
//
// Input (POST body):  { direccion, ciudad?, departamento?, country?, store_id? }
// Output:             { status, score, issues, geocoded?, cached }
//
// `country` ('CO' | 'EC') decide contra qué país se geocodifica y entra al
// cache_key: la misma dirección en Colombia y Ecuador NO puede compartir
// veredicto cacheado. Default 'CO'.

// ⛔ ACÁ NO SE GASTA UN CENTAVO. NO HAY LLAMADAS PAGAS — 6-ago-2026.
//
// Esta función tenía dos: Google Address Validation y Haiku para los casos
// ambiguos. Las dos se ELIMINARON por decisión del dueño ("quitala ya").
//
// Por qué se borraron en vez de dejarlas apagadas: el 22-may se "apagó" Google
// con un flag de cliente y se siguió pagando MÁS DE DOS MESES — el flag cortaba
// `CallView` y `CrmCallView` pero no `useAddressValidation`, el hook del badge
// que va DENTRO de esas mismas pantallas. Después se agregó un candado
// server-side (`GOOGLE_ENABLED`) y una prueba guardiana, y aun así quedaba un
// camino: un secreto mal puesto y la canilla se abre sola. La factura de Google
// llega un mes tarde, así que para cuando se nota ya se pagó.
//
// Un interruptor es un PEDIDO; la única defensa que no depende de que el código
// esté bien es que el código NO EXISTA. Si algún día se quiere volver a prender,
// se escribe de nuevo a conciencia — no se destapa por accidente.
//
// Lo que queda es gratis: heurística local + Nominatim (OpenStreetMap, sin clave).
// El semáforo verde/amarillo/rojo NO cambia: viene corriendo sobre la heurística
// desde mayo.
//
// La prueba `src/test/googleApagado.test.ts` falla si alguien vuelve a meter una
// llamada a Google acá.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders } from "../_shared/cors.ts";
import { isStoreMember } from "../_shared/dropiStoreConfig.ts";
import { mapAddressKind } from "./_addressKind.ts";

/** Nombre del país para el query de texto libre de Nominatim. */
const COUNTRY_NAME: Record<string, string> = { CO: "Colombia", EC: "Ecuador" };

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

function buildCacheKey(direccion: string, ciudad: string, departamento: string, countryCode: string): string {
  return [
    normalizeForCache(direccion),
    normalizeForCache(ciudad),
    normalizeForCache(departamento),
    countryCode.toLowerCase(),
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

  // Normalizamos antes de aplicar regex de tipo de vía / referencias para que
  // typos comunes con tildes ("Callé", "Cárrera", "Avénida") matcheen igual.
  // Espejo de src/lib/addressHeuristic.ts — mantener sincronizado.
  const normalized = dir.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  if (VIA_TYPE_REGEX.test(normalized)) {
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
  if (/\b(barrio|brrio|brr|casa|cs|apto|apartamento|edificio|edif|torre|piso|interior|int)\b/i.test(normalized)) {
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

// ── Geocoding via Nominatim (fallback) ─────────────────────────
async function nominatimGeocode(
  direccion: string,
  ciudad: string,
  departamento: string,
  countryCode: string,
): Promise<{ lat: number; lng: number; display: string } | null> {
  const parts = [direccion, ciudad, departamento, COUNTRY_NAME[countryCode] ?? "Colombia"].filter(Boolean);
  const q = parts.join(", ");
  const url = `${NOMINATIM_URL}?q=${encodeURIComponent(q)}&format=json&countrycodes=${countryCode.toLowerCase()}&limit=1&addressdetails=0`;

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

  let body: { direccion?: string; ciudad?: string; departamento?: string; country?: string; country_code?: string; store_id?: string };
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

  const sbServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(sbUrl, sbServiceKey);

  // El rate limit de Nominatim es de la plataforma: estar logueado no
  // alcanza. Con store_id se exige membresía de ESA tienda; sin él (callers
  // viejos) al menos pertenecer a alguna tienda.
  const storeId = typeof body.store_id === "string" ? body.store_id.trim() : "";
  if (storeId) {
    if (!(await isStoreMember(sb, user.id, storeId))) {
      return new Response(JSON.stringify({ error: "No sos miembro de esta tienda" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  } else {
    const { data: memberships } = await sb
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

  // País: explícito (el cliente ya manda `country`) > el de la tienda > CO.
  let countryCode = String(body.country || body.country_code || "").trim().toUpperCase();
  if (!countryCode && storeId) {
    const { data: store } = await sb
      .from("stores")
      .select("country_code")
      .eq("id", storeId)
      .maybeSingle();
    countryCode = String(store?.country_code || "").trim().toUpperCase();
  }
  if (countryCode !== "CO" && countryCode !== "EC") countryCode = "CO";

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

  const cacheKey = buildCacheKey(direccion, ciudad, departamento, countryCode);

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
    const invalidStatus = "invalid" as const;
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

  // Estos cuatro los llenaba Haiku. Sin la capa de IA quedan en su valor neutro
  // y la respuesta los sigue devolviendo: el cliente lee el contrato completo y
  // no hay que tocar `CallView`/`CrmCallView` (las pantallas frágiles) para que
  // no explote un campo faltante. La sugerencia de dirección la arma el cliente
  // por su cuenta con `buildAddressSuggestion`, que nunca inventó datos.
  const decision: "green" | "yellow" | "red" | null = null;
  const missing_fields: string[] = [];
  const suggested_customer_message = "";
  const suggested_address: string | null = null;

  // ── Validación: heurística local + Nominatim (OSM). GRATIS. ──────────────
  //
  // Acá vivían dos llamadas PAGAS: Google Address Validation y Haiku para los
  // casos ambiguos. Se ELIMINARON el 2026-08-06 por decisión del dueño.
  //
  // Historia, para que no vuelva: Google se "apagó" el 22-may-2026 con un flag
  // de cliente, y se siguió pagando MÁS DE DOS MESES — el flag cortaba
  // `CallView` y `CrmCallView` pero no `useAddressValidation`, que es el hook
  // del badge que va DENTRO de esas mismas pantallas. La factura de Google llega
  // un mes tarde, así que para cuando se nota ya se pagó. Después se agregó un
  // segundo candado server-side (`GOOGLE_ENABLED`, cerrado por defecto) y una
  // prueba guardiana. Igual quedaba un camino: un secreto mal puesto y vuelve a
  // gastar.
  //
  // La única defensa que no depende de que el código esté bien es que el código
  // NO EXISTA. Por eso se borró en vez de dejarlo apagado. Si algún día se
  // quiere volver a prender, se escribe de nuevo a conciencia — no se destapa
  // por accidente.
  //
  // Nominatim (OpenStreetMap) es gratis y sin clave; se conserva. Lo que se
  // pierde: el `formattedAddress` de Google como sugerencia y el mensaje al
  // cliente redactado por Haiku. El semáforo NO se pierde — corre sobre la
  // heurística local, que es lo que viene decidiendo desde mayo.
  const geocoded = await nominatimGeocode(direccion, ciudad, departamento, countryCode);
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

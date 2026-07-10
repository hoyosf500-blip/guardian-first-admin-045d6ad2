// Resolución de la ciudad DESTINO para cotizar/crear órdenes Dropi.
//
//  1) Catálogo local `dropi_city_catalog` (match exacto ciudad+depto → solo ciudad).
//  2) FALLBACK VIVO: POST /api/locations — el MISMO catálogo que usa el panel de
//     Dropi para su selector de ciudades. El snapshot local (410 ciudades EC,
//     2026-07-01) está incompleto: en vivo existen ciudades que no tiene (ej.
//     MUISNE/ESMERALDAS). Si Dropi la lista, se usa y se AUTO-AGREGA al catálogo
//     (self-healing) con cod_dane vacío — verificado en vivo 2026-07-10:
//     cotizaEnvioTransportadoraV2 devuelve transportadoras válidas con cod_dane
//     vacío (SERVIENTREGA cotizó MUISNE $7.83; algunas carriers pueden no cotizar
//     sin el código, aceptable para una ciudad que antes no cotizaba NADA).
//  3) null = NI el catálogo NI Dropi listan la ciudad → NO hay cobertura COD
//     (caso SAN LORENZO/ESMERALDAS, pedido #6031904). El caller debe mostrar el
//     error de COBERTURA (`noCoverageMessage`), no "agregala al catálogo": no es
//     un hueco de datos de Guardian, es que Dropi no llega.
//
// Compartido por dropi-change-carrier y shopify-push-dropi (antes cada uno tenía
// su copia del lookup local, sin fallback).

import { dropiWebFetch, normUp, type DestCity, type DropiWebCfg } from "./dropiWebQuote.ts";

export async function resolveDestCity(
  // deno-lint-ignore no-explicit-any
  sbAdmin: any,
  /** Config web de la tienda (session token) para el fallback vivo; null lo desactiva. */
  cfg: DropiWebCfg | null,
  countryCode: string,
  city: string,
  state: string,
): Promise<DestCity | null> {
  const country = countryCode === "EC" ? "EC" : "CO";
  const cityNorm = normUp(city);
  const deptNorm = normUp(state);
  if (!cityNorm) return null;

  const withDept = await sbAdmin
    .from("dropi_city_catalog")
    .select("city_id, name, department_id, cod_dane")
    .eq("country_code", country)
    .eq("city_norm", cityNorm)
    .eq("dept_norm", deptNorm)
    .limit(1)
    .maybeSingle();
  // deno-lint-ignore no-explicit-any
  let row: any = withDept?.data ?? null;

  if (!row) {
    const cityOnly = await sbAdmin
      .from("dropi_city_catalog")
      .select("city_id, name, department_id, cod_dane")
      .eq("country_code", country)
      .eq("city_norm", cityNorm)
      .order("id", { ascending: true })
      .limit(1)
      .maybeSingle();
    row = cityOnly?.data ?? null;
  }

  if (row) {
    return {
      cityId: Number(row.city_id),
      name: String(row.name),
      departmentId: row.department_id != null ? Number(row.department_id) : null,
      codDane: String(row.cod_dane),
    };
  }

  if (!cfg || !cfg.sessionToken) return null;
  return await resolveDestCityLive(sbAdmin, cfg, country, cityNorm, deptNorm);
}

/** Fallback vivo contra POST /api/locations. Shape verificado 2026-07-10:
 *  { data: [{ label, id_state, items: [{ label, id_city }] }] }. Nunca tira. */
async function resolveDestCityLive(
  // deno-lint-ignore no-explicit-any
  sbAdmin: any,
  cfg: DropiWebCfg,
  country: "EC" | "CO",
  cityNorm: string,
  deptNorm: string,
): Promise<DestCity | null> {
  try {
    const { status, body } = await dropiWebFetch(cfg, "/api/locations", {
      method: "POST",
      body: { country: country === "EC" ? "ECUADOR" : "COLOMBIA" },
      logBody: false,
    });
    if (status < 200 || status >= 300) return null;
    // deno-lint-ignore no-explicit-any
    const states: any[] = Array.isArray(body?.data) ? body.data : [];
    const cands: Array<{ cityLabel: string; cityId: number; deptLabel: string; deptId: number; exact: boolean }> = [];
    for (const st of states) {
      const deptLabel = normUp(st?.label);
      const items = Array.isArray(st?.items) ? st.items : [];
      for (const it of items) {
        const cl = normUp(it?.label);
        const id = Number(it?.id_city);
        if (!cl || !Number.isFinite(id)) continue;
        const exact = cl === cityNorm;
        // Prefijo bidireccional (mín. 4 chars) para variantes tipo "QUITO DC" ↔ "QUITO".
        const prefix = cityNorm.length >= 4 && (cl.startsWith(cityNorm) || cityNorm.startsWith(cl));
        if (exact || prefix) {
          cands.push({ cityLabel: String(it.label), cityId: id, deptLabel, deptId: Number(st?.id_state) || 0, exact });
        }
      }
    }
    if (cands.length === 0) return null;
    // Preferencia: exacto en el depto correcto > exacto > prefijo en el depto > prefijo.
    cands.sort((a, b) =>
      (Number(b.exact) - Number(a.exact)) ||
      (Number(b.deptLabel === deptNorm) - Number(a.deptLabel === deptNorm)));
    const hit = cands[0];

    // Self-healing: dejarla en el catálogo para la próxima. NO pisa filas
    // existentes (ignoreDuplicates) — las cargadas a mano traen cod_dane real.
    try {
      await sbAdmin.from("dropi_city_catalog").upsert({
        country_code: country,
        city_norm: normUp(hit.cityLabel),
        dept_norm: hit.deptLabel,
        city_id: hit.cityId,
        name: hit.cityLabel,
        department_id: hit.deptId || null,
        cod_dane: "",
      }, { onConflict: "country_code,city_norm,dept_norm", ignoreDuplicates: true });
    } catch (e) {
      console.error("[dropiCityCatalog] self-heal upsert falló:", e);
    }

    console.log("[dropiCityCatalog] fallback vivo resolvió ciudad", {
      buscada: cityNorm, encontrada: hit.cityLabel, depto: hit.deptLabel, exact: hit.exact,
    });
    return { cityId: hit.cityId, name: hit.cityLabel, departmentId: hit.deptId || null, codDane: "" };
  } catch (e) {
    console.error("[dropiCityCatalog] fallback vivo /api/locations falló:", e);
    return null;
  }
}

/** Mensaje de error cuando ni el catálogo ni Dropi listan la ciudad: es un
 *  problema de COBERTURA de Dropi, no de datos de Guardian. */
export function noCoverageMessage(city: string, state: string): string {
  const dest = `${city}${state ? ` (${state})` : ""}`.trim();
  return `Dropi no lista "${dest}" en su catálogo de envíos — sin cobertura COD para cotizar/editar este destino. Confirmá la ciudad con el cliente (puede recibir en un cantón cercano con cobertura) o gestioná el pedido directo en el panel de Dropi.`;
}

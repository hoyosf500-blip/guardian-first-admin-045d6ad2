/**
 * Helpers PUROS para los desplegables de provincia/ciudad sincronizados con el
 * catálogo de Dropi (`dropi_city_catalog`). El operador ELIGE, no escribe, para
 * no equivocar el nombre y que el pedido siempre resuelva en la API de Dropi.
 *
 * Puro a propósito (se testea sin red). El hook `useDropiCityCatalog` lo usa
 * sobre las filas que trae de Supabase.
 */

export interface CatalogRow {
  dept_norm: string;
  name: string;
}

export interface GeoCatalog {
  /** Provincias distintas, ordenadas. */
  provinces: string[];
  /** provincia → ciudades ordenadas (nombre EXACTO de Dropi). */
  citiesByProvince: Record<string, string[]>;
}

/**
 * Normaliza para COMPARAR (no para mostrar): mayúsculas, sin tildes, sin ñ.
 * Así "Cañar" del pedido matchea "CANAR" del catálogo, y "Quito " matchea
 * "QUITO". Es el mismo criterio que usa el resolvedor server-side de Dropi.
 */
export function normGeo(s: string | null | undefined): string {
  return String(s ?? '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // tildes + la tilde de la ñ
    .trim();
}

/** Agrupa las filas del catálogo por provincia. Descarta filas incompletas. */
export function groupDropiCatalog(rows: CatalogRow[]): GeoCatalog {
  const byProv: Record<string, Set<string>> = {};
  for (const row of rows || []) {
    const prov = (row?.dept_norm || '').trim();
    const city = (row?.name || '').trim();
    if (!prov || !city) continue;
    (byProv[prov] ??= new Set()).add(city);
  }
  const citiesByProvince: Record<string, string[]> = {};
  for (const [p, set] of Object.entries(byProv)) {
    citiesByProvince[p] = [...set].sort((a, b) => a.localeCompare(b, 'es'));
  }
  const provinces = Object.keys(citiesByProvince).sort((a, b) => a.localeCompare(b, 'es'));
  return { provinces, citiesByProvince };
}

/**
 * Devuelve la lista de opciones y el valor a seleccionar para un campo, sin
 * PERDER NUNCA el valor actual: si lo que trae el pedido no está en el catálogo
 * (ej. ciudad que Dropi no cubre), se antepone como opción para que se vea y
 * el operador pueda dejarlo tal cual. El match es tolerante a tildes/casing.
 *
 * @returns { options, selected } — `selected` es la etiqueta canónica del
 *   catálogo si hubo match; si no, el valor crudo preservado; '' si vacío.
 */
export function optionsPreservingCurrent(
  current: string | null | undefined,
  catalogOptions: string[],
): { options: string[]; selected: string } {
  const cur = String(current ?? '').trim();
  if (!cur) return { options: catalogOptions, selected: '' };

  const curNorm = normGeo(cur);
  const canonical = catalogOptions.find((o) => normGeo(o) === curNorm);
  if (canonical) return { options: catalogOptions, selected: canonical };

  // Valor fuera del catálogo: lo preservamos arriba de todo (no se pierde).
  return { options: [cur, ...catalogOptions], selected: cur };
}

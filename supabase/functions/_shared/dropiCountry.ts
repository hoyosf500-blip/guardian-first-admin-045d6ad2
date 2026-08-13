// Datos por PAÍS de Dropi que las edge functions repetían como ternarios de dos
// ramas (`=== 'EC' ? x : y`). Con Guatemala (y los países que vengan) esos
// ternarios caían SIEMPRE en la rama de Colombia: catálogo de ciudades CO para
// destinos GT, país "COLOMBIA" en los creates de GT, quetzales redondeados a
// entero (auditoría 2026-08-13). Fuente única, igual que dropiHosts.ts para los
// hosts. Agregar países nuevos ACÁ, no con otro ternario.

import { dropiHostFor } from "./dropiHosts.ts";

/** Nombre de país que la API web de Dropi espera en bodies como
 *  POST /api/locations `{ country: "ECUADOR" }` y el create-with-edit.
 *  Verificados EN VIVO: COLOMBIA y ECUADOR (2026-07-10). El resto sigue el
 *  patrón del panel de cada país; si Dropi usa otra grafía, se corrige acá. */
export const DROPI_COUNTRY_NAMES: Record<string, string> = {
  CO: "COLOMBIA", EC: "ECUADOR", GT: "GUATEMALA", MX: "MEXICO", CL: "CHILE",
  PE: "PERU", PA: "PANAMA", AR: "ARGENTINA", PY: "PARAGUAY", VE: "VENEZUELA",
  BO: "BOLIVIA", CR: "COSTA RICA",
};

/** null = país sin mapeo. Los callers deben FALLAR CERRADO con un mensaje que
 *  diga "agregar a DROPI_COUNTRY_NAMES", nunca caer a Colombia en silencio —
 *  ese era exactamente el bug que corrompía el catálogo de ciudades. */
export function dropiCountryNameFor(countryCode: string | null | undefined): string | null {
  const cc = String(countryCode || "").toUpperCase();
  return DROPI_COUNTRY_NAMES[cc] ?? null;
}

/** ¿La moneda del país tiene CENTAVOS? CO = pesos enteros; EC (USD) y GT (GTQ)
 *  = 2 decimales. Espejo del helper homónimo de src/lib/utils.ts (cliente):
 *  si se agrega un país acá, agregarlo también allá. */
export function paisUsaCentavos(countryCode?: string | null): boolean {
  const cc = String(countryCode || "").toUpperCase();
  return cc === "EC" || cc === "GT";
}

/** Host del PANEL web (app.dropi.*) del país — Origin neutro y correcto cuando
 *  la tienda no configuró su dropi_store_url. Antes el fallback era el dominio
 *  de la tienda Rushmira (la del dueño de la plataforma) para CUALQUIER tienda
 *  de terceros. */
export function dropiAppHostFor(countryCode: string | null | undefined): string {
  return dropiHostFor(countryCode).replace("//api.", "//app.");
}

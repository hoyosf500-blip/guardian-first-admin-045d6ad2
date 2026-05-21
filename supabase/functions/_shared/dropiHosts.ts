// Mapa país → host de la API de Dropi. Fuente única para todas las edge
// functions (antes cada una hardcodeaba "https://api.dropi.co").
// Extraído de dropi-relay/index.ts. Agregar países nuevos acá.

export const DROPI_HOSTS: Record<string, string> = {
  CO: "https://api.dropi.co",
  MX: "https://api.dropi.mx",
  EC: "https://api.dropi.ec",
  CL: "https://api.dropi.cl",
  PE: "https://api.dropi.pe",
  PA: "https://api.dropi.pa",
  AR: "https://api.dropi.ar",
  GT: "https://api.dropi.gt",
  PY: "https://api.dropi.com.py",
  VE: "https://api.dropi.com.ve",
  BO: "https://api.dropi.bo",
  CR: "https://api.dropi.cr",
  ES: "https://dropipro.com",
};

// Devuelve el host para un country_code, con fallback a Colombia.
export function dropiHostFor(countryCode: string | null | undefined): string {
  const cc = String(countryCode || "CO").toUpperCase();
  return DROPI_HOSTS[cc] || DROPI_HOSTS.CO;
}

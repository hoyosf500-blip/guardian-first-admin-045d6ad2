// rastreo — el link de seguimiento de la transportadora, del lado del servidor.
//
// Es la MISMA tabla que `src/lib/constants.ts` (`CARRIER_TRACK*`) y el mismo
// algoritmo que `getTrackingUrl` (`src/lib/orderUtils.ts`). Vive duplicada
// acá porque las edge functions (Deno) no pueden importar `src/` — y el
// responder automático de ImporChat necesita armar el link sin un navegador.
//
// ⛔ La paridad entre las dos copias la vigila `src/lib/rastreoParidad.test.ts`:
// si alguien agrega una transportadora en `constants.ts` y no acá (o al
// revés), la prueba se pone roja. No hay que "recordar" mantenerlas iguales.
//
// Puro: sin red, sin Deno, sin imports. Lo importa también `src/` en la prueba.

/** Transportadoras de COLOMBIA. Las que terminan en '=' reciben la guía al final. */
export const RASTREO_CO: Record<string, string> = {
  'INTERRAPIDISIMO': 'https://www.interrapidisimo.com/sigue-tu-envio/',
  'INTER RAPIDISIMO': 'https://www.interrapidisimo.com/sigue-tu-envio/',
  'SERVIENTREGA': 'https://www.servientrega.com/wps/portal/rastreo-envio',
  'COORDINADORA': 'https://www.coordinadora.com/rastreo/rastreo-de-guia/',
  'ENVIA': 'https://hub.envia.co/landingrastreo/Rastreo/Index?guia=',
  'ENVÍA': 'https://hub.envia.co/landingrastreo/Rastreo/Index?guia=',
  'TCC': 'https://www.tcc.com.co/rastreo/',
  'VELOCES': 'https://veloces.com.co/',
  'DEPRISA': 'https://www.deprisa.com/rastreo/',
};

/** Transportadoras de ECUADOR. SERVIENTREGA existe en los dos países con URL distinta. */
export const RASTREO_EC: Record<string, string> = {
  'GINTRACOM': 'https://ec.gintracom.site/web/site/tracking',
  'LAARCOURIER': 'https://fenixoper.laarcourier.com/Tracking/Guiacompleta.aspx?guia=',
  'LAAR': 'https://fenixoper.laarcourier.com/Tracking/Guiacompleta.aspx?guia=',
  'SERVIENTREGA': 'https://www.servientrega.com.ec/Tracking/?tipo=GUIA&guia=',
};

/** Guatemala: vacío a propósito hasta tener las URLs reales (ver constants.ts). */
export const RASTREO_GT: Record<string, string> = {};

export const RASTREO_POR_PAIS: Record<string, Record<string, string>> = {
  CO: RASTREO_CO,
  EC: RASTREO_EC,
  GT: RASTREO_GT,
};

/**
 * Misma lógica que `getTrackingUrl`: en EC las entradas ecuatorianas pisan a
 * las colombianas del mismo nombre; GT usa SOLO su mapa; el resto, el de CO.
 * Devuelve la portada de la transportadora cuando la URL no lleva la guía.
 */
export function urlRastreo(transportadora: string | null | undefined, guia: string | null | undefined, cc?: string | null): string | null {
  const key = (transportadora || '').toUpperCase().trim();
  const pais = (cc || 'CO').toUpperCase();
  const map = pais === 'EC' ? { ...RASTREO_CO, ...RASTREO_EC }
    : pais === 'GT' ? RASTREO_GT
    : RASTREO_CO;
  for (const name of Object.keys(map)) {
    if (key.includes(name)) {
      const url = map[name];
      return url.endsWith('=') ? url + String(guia ?? '').trim() : url;
    }
  }
  return null;
}

/**
 * SOLO el link que lleva la guía adentro (el que sirve para decirle al cliente
 * "sígalo aquí"). La portada de la transportadora se devuelve `null`: mandarle
 * "sígalo aquí" con un link que no sigue nada es la trampa que ya se documentó
 * en `datosPlantilla.ts`.
 */
export function linkRastreoConGuia(transportadora: string | null | undefined, guia: string | null | undefined, cc?: string | null): string | null {
  const g = String(guia ?? '').trim();
  if (!g) return null;
  const url = urlRastreo(transportadora, g, cc);
  if (!url) return null;
  const portada = urlRastreo(transportadora, '', cc);
  return url !== portada ? url : null;
}

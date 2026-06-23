// Rastreo por transportadora para la IA de WhatsApp.
//
// Réplica server-side de getTrackingUrl + CARRIER_TRACK/CARRIER_TRACK_EC
// (src/lib/orderUtils.ts + src/lib/constants.ts). Las edge functions (Deno) no
// pueden importar src/, por eso se duplica el mapa acá. Si cambian las URLs en
// constants.ts, actualizar también este archivo.

const CARRIER_TRACK: Record<string, string> = {
  "INTERRAPIDISIMO": "https://www.interrapidisimo.com/sigue-tu-envio/",
  "INTER RAPIDISIMO": "https://www.interrapidisimo.com/sigue-tu-envio/",
  "SERVIENTREGA": "https://www.servientrega.com/wps/portal/rastreo-envio",
  "COORDINADORA": "https://www.coordinadora.com/rastreo/rastreo-de-guia/",
  "ENVIA": "https://hub.envia.co/landingrastreo/Rastreo/Index?guia=",
  "ENVÍA": "https://hub.envia.co/landingrastreo/Rastreo/Index?guia=",
  "TCC": "https://www.tcc.com.co/rastreo/",
  "VELOCES": "https://veloces.com.co/",
  "DEPRISA": "https://www.deprisa.com/rastreo/",
};

// Ecuador: SERVIENTREGA existe en CO y EC con URL distinta → por eso el rastreo
// es por país. Las que terminan en '=' reciben la guía al final.
const CARRIER_TRACK_EC: Record<string, string> = {
  "GINTRACOM": "https://ec.gintracom.site/web/site/tracking",
  "LAARCOURIER": "https://fenixoper.laarcourier.com/Tracking/Guiacompleta.aspx?guia=",
  "LAAR": "https://fenixoper.laarcourier.com/Tracking/Guiacompleta.aspx?guia=",
  "SERVIENTREGA": "https://www.servientrega.com.ec/Tracking/?tipo=GUIA&guia=",
};

/** Devuelve el link de rastreo del pedido o null si no hay match de carrier. */
export function getTrackingUrl(carrier: string, guia: string, countryCode?: string): string | null {
  const key = (carrier || "").toUpperCase().trim();
  if (!key) return null;
  const cc = (countryCode || "CO").toUpperCase();
  const map = cc === "EC" ? { ...CARRIER_TRACK, ...CARRIER_TRACK_EC } : CARRIER_TRACK;
  for (const name of Object.keys(map)) {
    if (key.includes(name)) {
      const url = map[name];
      return url.endsWith("=") ? url + (guia || "") : url;
    }
  }
  return null;
}

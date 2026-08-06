// src/hooks/useGooglePlaces.ts
//
// ⛔ GOOGLE PLACES ELIMINADO — 6-ago-2026, por decisión del dueño ("quitala ya").
//
// Este hook llamaba a la edge function `google-places-proxy`, que era un proxy
// PURO a Google: cada llamada que entraba era plata que salía. Esa función ya no
// existe en el repo, y acá no queda ni una línea de red.
//
// POR QUÉ SE BORRÓ EN VEZ DE DEJARLO APAGADO
// Google se "apagó" el 22-may-2026 con un flag de cliente y se siguió pagando
// MÁS DE DOS MESES: el flag cortaba `CallView` y `CrmCallView` pero no
// `useAddressValidation`, el hook del badge que va DENTRO de esas mismas
// pantallas. Después se agregó un candado server-side y una prueba guardiana, y
// aun así quedaba un camino abierto — un secreto mal puesto y la canilla se abre
// sola. La factura de Google llega un mes tarde: para cuando se nota, ya se pagó.
//
// Un interruptor es un PEDIDO. La única defensa que no depende de que el código
// esté bien es que el código NO EXISTA.
//
// SE CONSERVA LA FIRMA a propósito: `AddressAutocomplete` la consume y ya gatea
// sobre `available`, así que con `false` el campo de dirección queda como texto
// libre — exactamente el comportamiento que tiene desde mayo. Borrar el archivo
// obligaría a tocar `CallView`/`CrmCallView`, que son las pantallas más frágiles
// del proyecto (overrides de validación, `visualDecision`, `DespachoGateButton`)
// y no hay ninguna razón para arriesgarlas por esto.
//
// Si algún día se quiere volver a tener autocompletado, se escribe de nuevo a
// conciencia — no se destapa por accidente.

interface AutocompletePrediction {
  description: string;
  place_id: string;
  structured_formatting?: { main_text: string; secondary_text: string };
}

interface PlaceDetailsResult {
  place_id: string;
  formatted_address: string;
  geometry?: { location?: { lat: () => number; lng: () => number } };
  address_components?: Array<{ long_name: string; short_name: string; types: string[] }>;
}

interface GoogleApi {
  autocomplete: (query: string, ciudadBias?: string) => Promise<AutocompletePrediction[]>;
  getDetails: (place_id: string) => Promise<PlaceDetailsResult | null>;
  available: boolean;
}

/** Objeto congelado a nivel módulo: misma referencia en cada render, así ningún
 *  `useEffect` que lo tenga en sus dependencias se dispara de más. */
const API_INERTE: GoogleApi = Object.freeze({
  available: false,
  autocomplete: async () => [],
  getDetails: async () => null,
});

export function useGooglePlaces(): GoogleApi {
  return API_INERTE;
}

// País de la tienda → panel y API de Dropi.
//
// Estaba repetido con ternarios `=== 'EC' ? ... : ...` en el wizard y en el
// panel de credenciales, así que sumar Guatemala obligaba a acordarse de los
// dos lugares. Fuente única: agregar un país acá y listo.
//
// Espeja `supabase/functions/_shared/dropiHosts.ts` (lado servidor).

const PANELES: Record<string, string> = {
  CO: 'https://app.dropi.co',
  EC: 'https://app.dropi.ec',
  GT: 'https://app.dropi.gt',
};

const APIS: Record<string, string> = {
  CO: 'api.dropi.co',
  EC: 'api.dropi.ec',
  GT: 'api.dropi.gt',
};

const NOMBRES: Record<string, string> = {
  CO: 'Colombia',
  EC: 'Ecuador',
  GT: 'Guatemala',
};

const cc = (countryCode?: string | null): string =>
  String(countryCode || 'CO').toUpperCase();

/** URL del panel web de Dropi del país (fallback Colombia). */
export function panelDropiUrl(countryCode?: string | null): string {
  return PANELES[cc(countryCode)] ?? PANELES.CO;
}

/** Host del panel, sin protocolo — para mostrarlo como texto. */
export function panelDropiHost(countryCode?: string | null): string {
  return panelDropiUrl(countryCode).replace(/^https?:\/\//, '');
}

/** Host de la API de Dropi del país, sin protocolo. */
export function apiDropiHost(countryCode?: string | null): string {
  return APIS[cc(countryCode)] ?? APIS.CO;
}

/** Nombre del país en español, para textos de la interfaz. */
export function nombrePais(countryCode?: string | null): string {
  return NOMBRES[cc(countryCode)] ?? cc(countryCode);
}

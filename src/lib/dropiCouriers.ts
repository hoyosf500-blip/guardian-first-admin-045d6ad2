/**
 * Mapa courier_id → nombre de transportadora para la huella del comprador.
 *
 * La API de huella de Dropi (`by_courier`) da la transportadora como NÚMERO
 * (`courier_id`), no como nombre. Estos IDs son los mismos que devuelve la
 * cotización (`distributionCompany.id`), así que se descubren cotizando rutas.
 *
 * ⚠️ Ecuador: verificado en vivo (cotizaciones reales, 2026-07-29).
 * ⚠️ Colombia: PENDIENTE — su token de sesión estaba vencido y no se pudieron
 *    cotizar rutas CO para descubrir los IDs. NO se inventan (un id→nombre
 *    equivocado etiquetaría mal la transportadora, peor que no etiquetar). En
 *    cuanto el login de CO funcione, se cotizan 3-4 rutas y se completan acá.
 *    Mientras tanto, CO cae al fallback "Transportadora #N" (los NÚMEROS por
 *    transportadora sí se muestran; solo la etiqueta es genérica).
 */
const COURIERS_BY_COUNTRY: Record<string, Record<number, string>> = {
  EC: {
    1: 'LAARCOURIER',
    2: 'SERVIENTREGA',
    3: 'VELOCES',
    4: 'GINTRACOM',
  },
  CO: {
    // Pendiente de descubrir con el token de sesión CO. Ver nota de arriba.
  },
};

/** Nombre legible de la transportadora; fallback honesto si el ID es desconocido. */
export function courierName(countryCode: string | null | undefined, courierId: number): string {
  const cc = String(countryCode || 'CO').toUpperCase();
  const name = COURIERS_BY_COUNTRY[cc]?.[courierId];
  return name || `Transportadora #${courierId}`;
}

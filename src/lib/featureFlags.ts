// Flags de funcionalidad de la app.

/**
 * ⛔ GOOGLE MAPS / PLACES — ELIMINADO DEL CÓDIGO (6-ago-2026).
 *
 * Esto ya NO es un interruptor: es una constante que documenta que el camino no
 * existe. Se borraron la edge function `google-places-proxy` (que era un proxy
 * PURO a Google), las llamadas a Google Address Validation y a Haiku dentro de
 * `dropi-validate-address`, y el cuerpo de `useGooglePlaces`.
 *
 * Ponerlo en `true` NO reactiva nada — no hay a qué llamar.
 *
 * POR QUÉ SE BORRÓ EN VEZ DE DEJARLO APAGADO
 * Se apagó el 22-may-2026 con este mismo flag y se siguió pagando MÁS DE DOS
 * MESES: el flag cortaba `CallView` y `CrmCallView` pero no
 * `useAddressValidation`, el hook del badge que va DENTRO de esas mismas
 * pantallas. Después se agregó un candado server-side (`GOOGLE_ENABLED`) y una
 * prueba guardiana, y aun así quedaba un camino a la tarjeta. La factura de
 * Google llega un mes tarde: para cuando se nota, ya se pagó.
 *
 * QUÉ SIGUE FUNCIONANDO IGUAL
 * El semáforo verde/amarillo/rojo que habilita el despacho corre sobre la
 * heurística local (`src/lib/addressHeuristic.ts`, pura regex, sin red) más
 * Nominatim/OpenStreetMap, que es gratis y sin clave. Es exactamente lo que
 * viene decidiendo desde mayo. Lo único que se pierde es el autocompletado del
 * campo de dirección —que ya estaba inactivo— y el mensaje al cliente redactado
 * por Haiku.
 *
 * Vigilado por `src/test/googleApagado.test.ts`, que ahora comprueba la
 * AUSENCIA del código y no que un flag esté en false.
 *
 * FALTA LO ÚNICO QUE NO DEPENDE DEL CÓDIGO: borrar `GOOGLE_MAPS_API_KEY` de los
 * secretos de Supabase y revocar la clave en Google Cloud. Mientras la clave
 * exista, existe una tarjeta que alguien podría llegar a cobrar.
 */
export const GOOGLE_PLACES_ENABLED = false;

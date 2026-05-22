// Flags de funcionalidad de la app.

/**
 * API de Google Maps / Places — autocompletado de direcciones (dropdown) +
 * validación server-side vía la edge function `dropi-validate-address`
 * (que internamente usa Google Places + Haiku).
 *
 * DESACTIVADO el 2026-05-22 a pedido del dueño, para Colombia y Ecuador.
 * Con el flag en `false`:
 *   - El autocompletado de direcciones queda inactivo: el campo de dirección
 *     pasa a ser texto libre (sin sugerencias de Google).
 *   - El semáforo de validación (verde/amarillo/rojo que habilita el despacho)
 *     sigue funcionando 100% con la HEURÍSTICA LOCAL (`src/lib/addressHeuristic.ts`)
 *     — pura regex, sin red, sin costo de Google.
 *
 * Reactivar Google = poner en `true`. NO requiere redeploy de edge functions
 * (solo Publish); las funciones `google-places-proxy` y `dropi-validate-address`
 * siguen existiendo, simplemente dejan de invocarse desde la app.
 */
export const GOOGLE_PLACES_ENABLED = false;

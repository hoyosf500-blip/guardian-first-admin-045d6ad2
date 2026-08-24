/**
 * Re-export de la regla de la ventana de 24 h de WhatsApp.
 *
 * La definición vive en `supabase/functions/_shared/ventanaWhatsapp.ts` porque
 * el SERVIDOR es quien decide de verdad si un mensaje se manda o no. La
 * pantalla lee exactamente la misma función —no una copia— para que el botón
 * nunca prometa algo que la edge function después va a rechazar.
 *
 * Mismo patrón que `autoPushSelect` y `walletCategoria`: lógica pura en
 * `_shared`, consumida desde `src/` cruzando el límite.
 */
export {
  ventanaWhatsapp,
  MOTIVO_VENTANA,
  VENTANA_WA_MS,
  type Ventana,
  type EstadoVentana,
} from '../../supabase/functions/_shared/ventanaWhatsapp';

/**
 * Re-export del normalizador de la conversación de WhatsApp.
 *
 * La definición vive en `supabase/functions/_shared/conversacion.ts` porque el
 * hilo lo lee el SERVIDOR (es el único que tiene la credencial de ImporChat).
 * La pantalla usa exactamente la misma función —no una copia— para que lo que
 * se pinta sea lo mismo que se midió.
 *
 * Mismo patrón que `ventanaWhatsapp`, `autoPushSelect` y `walletCategoria`.
 */
export {
  normalizarConversacion,
  ultimoEntranteMs,
  ultimoSaliente,
  ultimoAutorNegocio,
  urlDeArchivo,
  type MensajeConversacion,
  type MensajeIC,
  type QuienEscribe,
} from '../../supabase/functions/_shared/conversacion';

// Re-export de la lógica pura del "bot NO CIEGO". El cuerpo vive en
// `supabase/functions/_shared/estadoPedidoRespuesta.ts` para que también lo
// importe la edge function Deno (el worker autónomo que viene después); el front
// la usa desde acá para pre-rellenar la respuesta de estado del pedido en el
// cuadro de WhatsApp. Mismo patrón que `src/lib/conversacion.ts`.
export * from '../../supabase/functions/_shared/estadoPedidoRespuesta';

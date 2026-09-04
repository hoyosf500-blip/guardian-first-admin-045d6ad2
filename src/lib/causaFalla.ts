// Re-export de la clasificación de motivos de fallo del push Shopify→Dropi. El
// cuerpo vive en `supabase/functions/_shared/causaFalla.ts` porque lo necesitan
// las DOS puntas: la pantalla (para agrupar las ventas trabadas por motivo) y el
// robot (para no martillar la misma causa cada 15 min). Una sola definición de
// "el motivo", o el cartel y el robot dirían cosas distintas sobre la misma
// venta. Mismo patrón que `src/lib/estadoPedidoRespuesta.ts`.
export * from '../../supabase/functions/_shared/causaFalla';

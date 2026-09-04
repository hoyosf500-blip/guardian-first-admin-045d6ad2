// Re-export del cruce chat↔pedido del respondedor. El cuerpo vive en
// `supabase/functions/_shared/importchatCruce.ts` porque lo usa la edge function
// Deno; acá se importa solo para poder probarlo con vitest, que únicamente mira
// `src/**`. Mismo patrón que `src/lib/estadoPedidoRespuesta.ts`.
export * from '../../supabase/functions/_shared/importchatCruce';

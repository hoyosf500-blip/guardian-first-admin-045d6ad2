// Re-export de la señal "¿la plantilla apareció en el chat?". El cuerpo vive en
// `supabase/functions/_shared/plantillaEnHilo.ts` porque lo usa la edge function
// Deno; acá se importa solo para poder probarlo con vitest (que únicamente mira
// `src/**`). Mismo patrón que `src/lib/estadoPedidoRespuesta.ts`.
export * from '../../supabase/functions/_shared/plantillaEnHilo';

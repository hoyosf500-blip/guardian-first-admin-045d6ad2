// Re-export del cortacircuitos del robot Shopify→Dropi. El cuerpo vive en
// `supabase/functions/_shared/cortacircuitos.ts` porque lo corre la edge
// function en Deno; acá se re-exporta SOLO para poder probarlo con vitest
// (`npm test` no mira `supabase/functions/`, ver CLAUDE.md). Mismo patrón que
// `src/lib/causaFalla.ts` y `src/lib/autoPushSelect.test.ts`.
export * from '../../supabase/functions/_shared/cortacircuitos';

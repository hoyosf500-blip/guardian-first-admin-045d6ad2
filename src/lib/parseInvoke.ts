// Helper compartido para leer respuestas de edge functions vía
// supabase.functions.invoke() — extraído de usePushToDropi (misma semántica).

/** Lee la respuesta de la edge function aunque venga como error HTTP (4xx/5xx).
 *  En supabase-js v2, cuando la función responde un status no-2xx, `invoke()`
 *  entrega `data=null` y `error.context` es un objeto `Response` (su `.body`
 *  es un stream, NO un string). Hay que leer el cuerpo con `await ctx.text()`
 *  para sacar el motivo real (ej. el rechazo de Dropi); antes se intentaba
 *  `JSON.parse(ctx.body)` y siempre fallaba, dejando el mensaje genérico
 *  "Edge Function returned a non-2xx status code". */
export async function parseInvoke<T>(data: unknown, error: unknown): Promise<T> {
  if (error) {
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.text === 'function') {
      try {
        const body = await ctx.text();
        if (body) {
          try { return JSON.parse(body) as T; }
          catch { return { ok: false, error: body.slice(0, 500) } as T; }
        }
      } catch { /* no se pudo leer el cuerpo */ }
    }
    return { ok: false, error: (error as { message?: string }).message || 'error' } as T;
  }
  return data as T;
}

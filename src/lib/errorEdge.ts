/**
 * Traducir el error de una edge function a algo que la asesora pueda leer.
 *
 * ── Por qué existe ─────────────────────────────────────────────────────────
 * Lovable NO redespliega edge functions con un push: el código llega a GitHub
 * y la función puede seguir sin existir en el servidor. Cuando eso pasa,
 * supabase-js devuelve uno de dos textos, los dos en inglés y los dos inútiles
 * para quien está atendiendo a un cliente:
 *
 *   · "Edge Function returned a non-2xx status code"  (llegó, con cuerpo)
 *   · "Failed to send a request to the Edge Function" (ni llegó, sin cuerpo)
 *
 * El segundo se midió en producción el 25-ago-2026 con `importchat-plantillas`
 * recién subida: se esperaba el `code: NOT_FOUND` del gateway, pero cuando el
 * rechazo viene sin cabeceras CORS el navegador corta el fetch antes de que
 * haya cuerpo, así que `context.json()` no existe y el `code` nunca se ve.
 * Depender solo de él dejaba a la asesora con el texto en inglés.
 *
 * La diferencia importa: "no llegó al servidor" NO es "el cliente no lo
 * recibió". Confundirlos hace que se reintente algo que ya salió, o que se dé
 * por perdido algo que nunca se intentó.
 */

/** Los mensajes de supabase-js que significan "no se pudo llegar a la función". */
const FALLO_DE_RED = /failed to send a request|failed to fetch|non-2xx status code|networkerror/i;

export interface MotivoEdge {
  /** Texto para mostrarle a la persona. Nunca vacío. */
  detalle: string;
  /** La tienda no tiene el servicio configurado: la pantalla NO se dibuja,
   *  en vez de mostrar un error que no le sirve a nadie. */
  sinConfig: boolean;
}

/**
 * @param error       lo que devolvió `supabase.functions.invoke`
 * @param cuerpo      el JSON de la respuesta, si se pudo leer (`context.json()`)
 * @param sinDesplegar qué decir cuando la función no está desplegada
 * @param porDefecto  último recurso, si no hay nada más que decir
 */
export function motivoEdge(
  error: unknown,
  cuerpo: { error?: string; code?: string; sin_config?: boolean } | null,
  sinDesplegar: string,
  porDefecto: string,
): MotivoEdge {
  // El cuerpo manda: es el motivo REAL que escribió la función.
  if (cuerpo?.sin_config) return { detalle: cuerpo.error || porDefecto, sinConfig: true };
  if (cuerpo?.error) return { detalle: cuerpo.error, sinConfig: false };
  if (cuerpo?.code === 'NOT_FOUND') return { detalle: sinDesplegar, sinConfig: false };

  const msg = String((error as { message?: string })?.message ?? '').trim();
  if (!msg || FALLO_DE_RED.test(msg)) return { detalle: sinDesplegar, sinConfig: false };
  return { detalle: msg, sinConfig: false };
}

/** Lee el cuerpo JSON del error sin lanzar. `null` si no había o no era JSON. */
export async function cuerpoDelError(
  error: unknown,
): Promise<{ error?: string; code?: string; sin_config?: boolean } | null> {
  try {
    const ctx = (error as { context?: { json?: () => Promise<Record<string, unknown>> } }).context;
    if (!ctx?.json) return null;
    return (await ctx.json()) as { error?: string; code?: string; sin_config?: boolean };
  } catch {
    return null;
  }
}

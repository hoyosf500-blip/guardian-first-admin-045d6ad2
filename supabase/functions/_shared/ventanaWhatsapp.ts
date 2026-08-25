/**
 * La ventana de 24 h de WhatsApp, que es la regla que decide si un mensaje
 * escrito a mano llega o se pierde.
 *
 * Meta solo entrega mensajes de TEXTO LIBRE dentro de las 24 h posteriores al
 * último mensaje DEL CLIENTE. Pasada esa ventana, el único camino es una
 * plantilla aprobada. Un texto libre fuera de ventana no da error visible en la
 * pantalla de nadie: simplemente **no llega**, y la asesora queda convencida de
 * que avisó. Por eso Guardian lo bloquea ANTES de enviar y lo dice con todas
 * las letras, en vez de dejar que se pierda en silencio.
 *
 * Puro y sin dependencias: lo comparten la edge function que envía y la
 * pantalla que dibuja el botón, así que no pueden discrepar sobre si se puede
 * escribir o no.
 */

export const VENTANA_WA_MS = 24 * 60 * 60 * 1000;

export type EstadoVentana =
  /** Se puede escribir texto libre: el cliente habló hace menos de 24 h. */
  | "abierta"
  /** El cliente habló, pero hace más de 24 h: solo plantilla. */
  | "vencida"
  /** El cliente nunca escribió: nunca hubo ventana. */
  | "nunca_escribio"
  /** No se leyó la conversación: no se sabe (y no se adivina). */
  | "sin_dato";

export interface Ventana {
  estado: EstadoVentana;
  /** Milisegundos que faltan para que se cierre. null si no está abierta. */
  restanteMs: number | null;
}

/**
 * @param entranteMs  último mensaje DEL CLIENTE (ms epoch) o null
 * @param leido       ¿se leyó la conversación de este pedido?
 */
export function ventanaWhatsapp(
  entranteMs: number | null,
  leido: boolean,
  ahoraMs: number = Date.now(),
): Ventana {
  if (!leido) return { estado: "sin_dato", restanteMs: null };
  if (entranteMs == null) return { estado: "nunca_escribio", restanteMs: null };
  const transcurrido = ahoraMs - entranteMs;
  if (transcurrido < VENTANA_WA_MS) {
    return { estado: "abierta", restanteMs: VENTANA_WA_MS - transcurrido };
  }
  return { estado: "vencida", restanteMs: null };
}

/**
 * Texto para la pantalla: por qué no se puede escribir y qué hacer.
 *
 * Desde el 25-ago-2026 la salida NO es solo "llamalo": Meta sí entrega fuera
 * de la ventana si el mensaje es una **plantilla aprobada**, y la cuenta tiene
 * 31. Decir únicamente "llamalo" mandaba a la asesora al teléfono teniendo el
 * WhatsApp disponible. Ver `plantillasMeta.ts` e `importchat-plantillas`.
 */
export const MOTIVO_VENTANA: Record<EstadoVentana, string> = {
  abierta: "",
  vencida:
    "Pasaron más de 24 h desde el último mensaje del cliente: WhatsApp ya no entrega mensajes escritos a mano. Se le puede mandar una plantilla aprobada, o llamarlo.",
  nunca_escribio:
    "Este cliente nunca escribió por WhatsApp, así que un mensaje escrito a mano no le llega. Se le puede mandar una plantilla aprobada, o llamarlo.",
  sin_dato:
    "Todavía no se leyó la conversación de este pedido, así que no se sabe si el mensaje llegaría.",
};

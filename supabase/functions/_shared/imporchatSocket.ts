// imporchatSocket — el ÚNICO lugar que habla el socket de ImporChat.
//
// ── Por qué un socket y no REST ────────────────────────────────────────────
// ImporChat no tiene endpoint REST ni para mandar texto libre ni para leer la
// conversación de un chat (se probaron 4 rutas: 404). Su panel usa socket.io
// (`https://chat.imporfactory.app`, path `/socket.io`, transporte websocket).
// Verificado el 24-ago-2026 conectándose desde fuera del navegador: acepta la
// conexión y responde comandos.
//
// ⚠️ El handshake NO pide auth: el token viaja DENTRO de cada payload
// (`jwt_token`). O sea que un emit con token vencido **no falla** — devuelve
// vacío. Por eso `leerChat` distingue "no contestó" (null) de "contestó sin
// mensajes" ([]): en esta operación un cero jamás puede hacerse pasar por una
// medición.
//
// Molde de `_shared/dropiWebQuote.ts`, que ya comparten `dropi-change-carrier`
// y `shopify-push-dropi`.

import { io, type Socket } from "https://esm.sh/socket.io-client@4.7.5";
// La FORMA del mensaje vive en `conversacion.ts`, que es puro y lo importa
// `src/`. Acá solo está la plomería: este archivo NUNCA lo puede importar el
// frontend, porque el `tsc` de la app no resuelve el import de socket.io.
import type { MensajeIC } from "./conversacion.ts";

export type { MensajeIC };

export const SOCKET_URL = "https://chat.imporfactory.app";
export const TIMEOUT_SOCKET_MS = 15_000;
/** Cuánto se espera un `CHATS_BOX_RESPONSE` antes de darlo por no contestado. */
export const ESPERA_LECTURA_MS = 8_000;

/** Credencial de la tienda: el JWT de sesión (7 días) y su id de configuración. */
export interface CredencialIC {
  token: string;
  idConf: number;
}

/** ImporChat acepta el chatId numérico; se manda como número cuando lo es. */
export function normalizarChatId(chatId: string | number): string | number {
  return Number(chatId) || chatId;
}

/**
 * Abre el socket, corre `fn` y lo cierra SIEMPRE — también si `fn` explota.
 * Un socket que queda abierto en una edge function se lleva el runtime puesto.
 */
export async function usarSocket<T>(fn: (socket: Socket) => Promise<T>): Promise<T> {
  const socket = io(SOCKET_URL, {
    transports: ["websocket"], reconnection: false, timeout: TIMEOUT_SOCKET_MS,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("el socket no conectó en 15 s")), TIMEOUT_SOCKET_MS);
      socket.on("connect", () => { clearTimeout(t); resolve(); });
      socket.on("connect_error", (e: Error) => { clearTimeout(t); reject(new Error(`socket: ${e.message}`)); });
    });
    return await fn(socket);
  } finally {
    try { socket.close(); } catch { /* ya estaba cerrado */ }
  }
}

/**
 * Pide la conversación completa de un chat.
 *
 * @returns los mensajes, o **`null` si el socket no contestó a tiempo**. `[]`
 *          es una respuesta válida (chat sin mensajes) y NO es lo mismo.
 */
export function leerChat(
  socket: Socket,
  cred: CredencialIC,
  chatId: string | number,
  esperaMs = ESPERA_LECTURA_MS,
): Promise<MensajeIC[] | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), esperaMs);
    socket.once("CHATS_BOX_RESPONSE", (data: unknown) => {
      clearTimeout(t);
      // La respuesta es un array de UN objeto: `[{...datosDelChat, mensajes}]`.
      const chat = Array.isArray(data) ? data[0] as { mensajes?: MensajeIC[] } | undefined : null;
      resolve(chat?.mensajes ?? []);
    });
    socket.emit("GET_CHATS_BOX", {
      chatId: normalizarChatId(chatId),
      id_configuracion: cred.idConf,
      jwt_token: cred.token,
    });
  });
}

/**
 * Emite el mensaje. NO espera confirmación a propósito: quien envía tiene que
 * RELEER el chat para saber si salió (ver `importchat-send`). Un `emit` que
 * vuelve sin error no prueba absolutamente nada.
 *
 * `nombre_encargado` es lo que ImporChat guarda como `responsable`, así que es
 * lo que después permite distinguir un mensaje de la asesora del del bot.
 */
export function emitirMensaje(socket: Socket, cred: CredencialIC, m: {
  chatId: string | number;
  telefono: string;
  mensaje: string;
  autor: string;
}): void {
  // Mismo payload que emite el panel (leído de su bundle). `client_tmp_id` es
  // el id optimista de su UI; se manda uno propio y reconocible.
  socket.emit("SEND_MESSAGE", {
    id_configuracion: cred.idConf,
    chatId: normalizarChatId(m.chatId),
    source: "wa",
    page_id: null,
    external_id: null,
    to: m.telefono,
    mensaje: m.mensaje,
    tipo_mensaje: "text",
    attachment_url: null,
    ruta_archivo: null,
    nombre_encargado: m.autor,
    client_tmp_id: `guardian-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    jwt_token: cred.token,
  });
}

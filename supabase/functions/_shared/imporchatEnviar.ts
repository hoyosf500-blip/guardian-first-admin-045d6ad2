// imporchatEnviar — mandar un texto por ImporChat y CONFIRMAR que salió.
//
// Es el mismo algoritmo que `importchat-send` usa desde el 24-ago-2026 (ver
// `enviarPorSocket` allá), sacado a `_shared` para que lo comparta el
// responder automático (`importchat-responder`). `importchat-send` conserva su
// copia a propósito: unificarla exige redesplegar una función que hoy anda, y
// eso se hace en su propio commit, no de pasada.
//
// Las tres reglas, iguales que allá:
//   1. La VENTANA de 24 h se decide con el hilo recién leído, no con la columna
//      del sync (que puede tener 30 min). Fuera de ventana no se emite nada.
//   2. Se confirma por CONTEO: cuántas copias exactas del texto había antes y
//      cuántas hay después. Un texto igual mandado antes no se confunde con
//      "mi mensaje salió".
//   3. No poder releer NO es "no llegó": es no saber, y se trata como fallo.

import type { Socket } from "https://esm.sh/socket.io-client@4.7.5";
import { ventanaWhatsapp, MOTIVO_VENTANA, type EstadoVentana } from "./ventanaWhatsapp.ts";
import { leerChat, emitirMensaje, type CredencialIC } from "./imporchatSocket.ts";
import { normalizarConversacion, ultimoEntranteMs, type MensajeConversacion } from "./conversacion.ts";

/** Reintentos de RELECTURA tras emitir (ms de espera antes de cada uno). */
export const RELECTURA_MS = [1500, 2000, 3000];

/** Cuántos salientes con EXACTAMENTE este texto hay en el hilo crudo. */
export function contarMismoTexto(
  crudos: Array<{ rol_mensaje?: number; texto_mensaje?: unknown }>,
  texto: string,
): number {
  const t = texto.trim();
  return crudos.filter(
    (m) => m.rol_mensaje === 1 && String(m.texto_mensaje ?? "").trim() === t,
  ).length;
}

export interface ResultadoEnvio {
  ok: boolean;
  confirmado: boolean;
  detalle: string;
  /** El hilo normalizado tras el envío (vacío si no se pudo leer). */
  mensajes: MensajeConversacion[];
  /** Si se frenó por la ventana de 24 h, cuál fue el estado. */
  ventanaCerrada?: EstadoVentana;
  /** El hilo ANTES de emitir, para que quien llama pueda mirar el contexto. */
  hiloPrevio: MensajeConversacion[] | null;
}

/**
 * Sobre un socket YA abierto: lee el hilo, decide la ventana, emite y relee
 * hasta ver la copia nueva. `antesDeEmitir` deja que quien llama mire el hilo
 * fresco y decida NO mandar (devolviendo un motivo) — el responder lo usa para
 * comprobar que nadie contestó mientras tanto.
 */
export async function enviarVerificado(
  socket: Socket,
  opts: {
    cred: CredencialIC;
    chatId: string;
    telefono: string;
    mensaje: string;
    autor: string;
    /** Marca de la base, SOLO de respaldo si no se pudo releer el hilo. */
    entranteAtDb: number | null;
    leidoDb: boolean;
    antesDeEmitir?: (hilo: MensajeConversacion[]) => string | null;
  },
): Promise<ResultadoEnvio> {
  const antes = await leerChat(socket, opts.cred, opts.chatId);
  const conBaseline = antes !== null;
  const antesN = conBaseline ? contarMismoTexto(antes, opts.mensaje) : 0;
  const hiloPrevio = conBaseline ? normalizarConversacion(antes) : null;

  const ultimoEnt = hiloPrevio ? ultimoEntranteMs(hiloPrevio) : opts.entranteAtDb;
  const leido = conBaseline ? true : opts.leidoDb;
  const v = ventanaWhatsapp(ultimoEnt, leido);
  if (v.estado !== "abierta") {
    return { ok: false, confirmado: false, ventanaCerrada: v.estado, detalle: MOTIVO_VENTANA[v.estado], mensajes: [], hiloPrevio };
  }

  if (opts.antesDeEmitir && hiloPrevio) {
    const veto = opts.antesDeEmitir(hiloPrevio);
    if (veto) return { ok: false, confirmado: false, detalle: veto, mensajes: hiloPrevio, hiloPrevio };
  }

  emitirMensaje(socket, opts.cred, {
    chatId: opts.chatId, telefono: opts.telefono, mensaje: opts.mensaje, autor: opts.autor,
  });

  let crudos: Awaited<ReturnType<typeof leerChat>> = null;
  for (const espera of RELECTURA_MS) {
    await new Promise((r) => setTimeout(r, espera));
    crudos = await leerChat(socket, opts.cred, opts.chatId);
    if (crudos !== null && contarMismoTexto(crudos, opts.mensaje) > antesN) break;
  }
  if (crudos === null) {
    return { ok: false, confirmado: false, detalle: "ImporChat no contestó al releer el chat", mensajes: [], hiloPrevio };
  }
  const despuesN = contarMismoTexto(crudos, opts.mensaje);
  const confirmado = conBaseline ? despuesN > antesN : despuesN > 0;
  const mensajes = normalizarConversacion(crudos);
  return confirmado
    ? { ok: true, confirmado: true, detalle: "enviado y confirmado en el chat", mensajes, hiloPrevio }
    : { ok: false, confirmado: false, detalle: "se emitió pero no apareció en el chat al releerlo", mensajes, hiloPrevio };
}

import type { ActividadChatOrden } from './actividadChat';
import { classifySegEstado, type SegStatusKey } from './segStatus';

/**
 * ¿Ya toca LLAMAR a este cliente?
 *
 * ── De dónde sale (28-ago-2026) ─────────────────────────────────────────────
 * Pedido del dueño, textual: *"necesito llevar un control, porque si mandan la
 * plantilla y no contesta entonces necesito que llamen"*.
 *
 * Hasta hoy el WhatsApp salía y ahí moría: nadie volvía a mirar ese pedido hasta
 * que la transportadora lo devolvía. El mensaje no es el trabajo — es el primer
 * intento. Este archivo pone el segundo intento en el reloj.
 *
 * ── La regla, en una comparación ────────────────────────────────────────────
 * **Le escribimos, desde ese mensaje el cliente no dijo nada, y pasaron 6 h.**
 *
 * Es a propósito la misma forma que `estadoConversacion` (`actividadChat.ts`):
 * una sola comparación entre el último saliente y el último entrante. Dos
 * definiciones de "no contestó" se desincronizan solas, y entonces el chip dice
 * una cosa y la tarjeta otra.
 *
 * Cubre los dos casos que importan y que la gente confunde:
 *   - nunca contestó nada (`entranteAt == null`)
 *   - contestó ANTES, le respondimos, y desde entonces silencio
 * En los dos la pelota está del lado del cliente y él no la movió.
 */

/**
 * Horas desde el mensaje antes de que el pedido pase a la cola de llamar.
 *
 * Elegido por el dueño (28-ago-2026) entre 2 h / 6 h / 24 h. Con 6 h, lo que se
 * mandó en la mañana se llama en la tarde: **el mismo día**, sin gastar una
 * llamada en alguien que todavía no abrió el teléfono.
 */
export const HORAS_PARA_LLAMAR = 6;
export const MS_PARA_LLAMAR = HORAS_PARA_LLAMAR * 3_600_000;

/**
 * Estados en los que llamar no tiene sentido: el pedido ya terminó su vida.
 * Mismo criterio (y mismos strings, borrados incluidos) que `useInboxEsperando`.
 */
const TERMINALES = new Set(['ENTREGADO', 'CANCELADO', 'ARCHIVADO GHOST', 'ARCHIVADO_GHOST']);

export function esTerminal(estado: string | null | undefined): boolean {
  return TERMINALES.has(String(estado || '').toUpperCase().trim());
}

/**
 * Las fases donde el silencio del cliente es un PROBLEMA — porque le pedimos
 * que haga algo.
 *
 * ⛔ Sin este filtro la cola no sirve (medido en pantalla el 28-ago-2026:
 * **353 pedidos**, o sea el tablero entero de Ecuador). El error es de fondo,
 * no de umbral: a un cliente al que le avisamos *"su pedido ya tiene guía"* o
 * *"va en camino"* **no le pedimos nada**, así que su silencio es lo normal y
 * llamarlo es gastar una llamada en alguien que no tiene nada que contestar.
 *
 * Una cola de 353 es la misma trampa del *"150 por gestionar"* que el dueño ya
 * rechazó: una meta imposible que se ignora, y con ella se ignoran los 30 que
 * sí importaban.
 *
 * Quedan las cuatro situaciones donde el pedido NO avanza si el cliente no
 * responde — y son justo las que terminan en devolución:
 *   - `oficina`: tiene que ir a retirarlo antes de que la agencia lo devuelva
 *   - `novedad` / `novedad_sol`: tiene que dar la dirección o coordinar
 *   - `reparto`: tiene que estar para recibirlo hoy
 *   - `devolucion` / `devolucion_transito` / `rechazado`: hay que rescatarlo
 */
const FASES_QUE_EXIGEN_RESPUESTA: ReadonlySet<SegStatusKey> = new Set([
  'oficina', 'novedad', 'novedad_sol', 'reparto',
  'devolucion', 'devolucion_transito', 'rechazado',
]);

export function faseExigeRespuesta(estado: string | null | undefined): boolean {
  return FASES_QUE_EXIGEN_RESPUESTA.has(classifySegEstado(estado || ''));
}

/**
 * `true` solo si estamos seguros de que le escribimos y no contestó.
 *
 * ⛔ **Sin actividad de chat leída devuelve `false`.** No saber si contestó NO es
 * lo mismo que saber que no contestó: es la regla de la casa (cero nunca
 * sustituye a "no se pudo medir") y acá tiene consecuencia física — mandaría a
 * una asesora a llamar a alguien que quizá ya respondió, con el mensaje del
 * cliente sin leer. Es el mismo error que `veredictoAviso` evita con `sin_dato`.
 */
export function tocaLlamar(
  act: ActividadChatOrden | null | undefined,
  estado: string | null | undefined,
  ahoraMs: number = Date.now(),
): boolean {
  if (!act) return false;
  if (esTerminal(estado)) return false;
  // Solo donde el silencio duele: ver `FASES_QUE_EXIGEN_RESPUESTA`.
  if (!faseExigeRespuesta(estado)) return false;
  // Nunca salió un mensaje: no hay nada que el cliente haya dejado en visto.
  // Ese pedido necesita el PRIMER aviso, no una llamada — y de eso se encarga
  // el botón de acción. Meterlo acá taparía las dos cosas en un mismo número.
  if (act.salienteAt == null) return false;
  // El cliente habló DESPUÉS de nuestro último mensaje: no está en visto, está
  // esperando respuesta nuestra. Ese caso ya tiene su propia lista ("te
  // escribieron y nadie contestó") y es más urgente que una llamada.
  if (act.entranteAt != null && act.entranteAt > act.salienteAt) return false;
  return ahoraMs - act.salienteAt >= MS_PARA_LLAMAR;
}

/**
 * Cuánto falta (en minutos) para que este pedido entre a la cola de llamar.
 * `0` = ya entró. `null` = no aplica (nunca se le escribió, o ya contestó).
 *
 * Existe para poder decir *"en 40 min"* en vez de dejar al pedido desaparecido
 * hasta que le toque: es la lección de `resumenSinRespuestaHoy` — lo que se
 * enfría sin decir cuándo vuelve, se pierde.
 */
export function minutosParaLlamar(
  act: ActividadChatOrden | null | undefined,
  estado: string | null | undefined,
  ahoraMs: number = Date.now(),
): number | null {
  if (!act || esTerminal(estado) || !faseExigeRespuesta(estado) || act.salienteAt == null) return null;
  if (act.entranteAt != null && act.entranteAt > act.salienteAt) return null;
  return Math.max(0, Math.ceil((act.salienteAt + MS_PARA_LLAMAR - ahoraMs) / 60_000));
}

/** Cuántos de una lista ya están para llamar. Cuenta con la MISMA función que
 *  decide el botón de la tarjeta, para que el chip y la tarjeta no discrepen. */
export function contarTocaLlamar<T>(
  items: readonly T[],
  actividadDe: (item: T) => ActividadChatOrden | null | undefined,
  estadoDe: (item: T) => string | null | undefined,
  ahoraMs: number = Date.now(),
): number {
  let n = 0;
  for (const it of items) if (tocaLlamar(actividadDe(it), estadoDe(it), ahoraMs)) n += 1;
  return n;
}

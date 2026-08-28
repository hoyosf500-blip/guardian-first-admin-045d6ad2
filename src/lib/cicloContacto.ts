import type { ActividadChatOrden } from './actividadChat';
import type { GestionDelPedido } from './gestionPorPedido';

/**
 * El CICLO de un pedido: qué le pasó al último contacto y qué toca ahora.
 *
 * ── De dónde sale (28-ago-2026) ─────────────────────────────────────────────
 * Pedido del dueño, textual:
 *
 *   *"como ahora con un solo botón se envía la plantilla, eso se descuenta.
 *   Pero si el cliente responde, que vuelva y aparezca, pero con una etiqueta
 *   para que el asesor lo atienda. Y si no contesta, que sea como en la llamada:
 *   que desaparezca, pero a la hora tiene que volver a aparecer, y la etiqueta
 *   de que tiene que hacer un segundo intento."*
 *
 * Es un cambio de modelo, no un chip más. Hasta hoy Seguimiento era una **lista
 * del día**: se tocaba un pedido y desaparecía hasta mañana. Ahora es una **cola
 * viva**: se trabaja, se enfría una hora, y vuelve con la etiqueta de qué sigue.
 *
 * ── Por qué reemplaza a cuatro chips ────────────────────────────────────────
 * La tarjeta llegó a apilar seis etiquetas, y CUATRO hablaban de lo mismo por
 * caminos distintos: la gestión declarada, el aviso de agencia, el estado de la
 * conversación y el "WhatsApp real" verificado. Un mismo pedido podía mostrar
 * *"Avisado hoy"* y *"WhatsApp real: plantilla hace 16 h"* a la vez. Ninguna
 * mentía; juntas eran ilegibles.
 *
 * ⛔ **No se pierde la verificación.** Este ciclo se calcula CON el dato
 * verificado contra ImporChat (`chat_saliente_at` / `chat_entrante_at`), no con
 * lo que la asesora declaró. Lo declarado solo puede ADELANTAR el reloj, nunca
 * inventar un contacto que no salió. El detalle de las dos fuentes queda en el
 * `title` de la etiqueta.
 *
 * PURO y testeable: entra data, sale un veredicto. La UI solo dibuja.
 */

/** Cuánto se enfría un pedido después de tocarlo, antes de volver a la cola. */
export const ESPERA_REINTENTO_MIN = 60;
const ESPERA_MS = ESPERA_REINTENTO_MIN * 60_000;

/** Al tercer intento el mensaje claramente no funciona con esta persona. */
export const INTENTOS_ANTES_DE_LLAMAR = 2;

export type EstadoCiclo =
  /** El cliente habló DESPUÉS de nuestro último mensaje. Hay alguien esperando. */
  | 'respondio'
  /** Lo tocamos hace menos de una hora: se le da tiempo de leer. */
  | 'enfriando'
  /** Pasó la espera y no contestó: toca insistir. */
  | 'reintento'
  /** Nadie le escribió nunca. */
  | 'sin_tocar';

export type AccionCiclo = 'atender' | 'insistir' | 'llamar' | 'avisar' | null;

export interface Ciclo {
  estado: EstadoCiclo;
  /** Qué dice la etiqueta de la tarjeta. `null` = no se dibuja ninguna. */
  etiqueta: string | null;
  /** Qué toca hacer, para que la tarjeta pueda resaltar el botón correcto. */
  accion: AccionCiclo;
  /** Cuántas veces se intentó contactar (lo que sabemos: gestiones de hoy). */
  intentos: number;
  /** ms del último contacto NUESTRO (mensaje verificado o gestión registrada). */
  ultimoNuestroMs: number | null;
  /** ms del último mensaje del cliente, si contestó después. */
  respondioMs: number | null;
  /** Minutos que faltan para que vuelva a la cola. Solo en `enfriando`. */
  vuelveEnMin: number | null;
}

const CERO: Ciclo = {
  estado: 'sin_tocar', etiqueta: null, accion: 'avisar',
  intentos: 0, ultimoNuestroMs: null, respondioMs: null, vuelveEnMin: null,
};

function haceTexto(ms: number, ahora: number): string {
  const min = Math.max(0, Math.round((ahora - ms) / 60_000));
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} días`;
}

/**
 * El ciclo de este pedido.
 *
 * `actividad` es lo VERIFICADO contra ImporChat; `gestion` es lo que registró el
 * equipo hoy. El último contacto nuestro es el MÁS RECIENTE de los dos: una
 * llamada registrada también enfría el pedido, igual que un WhatsApp — es
 * exactamente la analogía que pidió el dueño ("que sea como en la llamada").
 *
 * ⛔ Sin ninguna de las dos fuentes devuelve `sin_tocar`, y eso es una
 * afirmación fuerte ("nadie le escribió"). Solo se sostiene porque
 * `chat_saliente_at` viene de leer la conversación entera del cliente en
 * ImporChat; si esa lectura no existe, `actividad` llega `null` y el llamador
 * tiene que tratar `sin_tocar` como "no sé", no como "no se le avisó".
 */
export function cicloContacto(args: {
  actividad?: ActividadChatOrden | null;
  gestion?: GestionDelPedido | null;
  ahoraMs?: number;
}): Ciclo {
  const ahora = args.ahoraMs ?? Date.now();
  const act = args.actividad ?? null;
  const g = args.gestion ?? null;

  const salienteMs = act?.salienteAt ?? null;
  const gestionMs = g?.ultimoAt ? Date.parse(g.ultimoAt) : NaN;
  const candidatos = [salienteMs, Number.isFinite(gestionMs) ? gestionMs : null]
    .filter((x): x is number => x != null && Number.isFinite(x));
  const ultimoNuestroMs = candidatos.length ? Math.max(...candidatos) : null;
  const intentos = g?.intentos ?? 0;

  if (ultimoNuestroMs == null) {
    return { ...CERO, intentos, etiqueta: 'Sin avisar' };
  }

  // ¿Contestó DESPUÉS de lo último que le mandamos? Es la única comparación que
  // importa: un mensaje suyo de antes no es una respuesta a lo de ahora.
  const entrante = act?.entranteAt ?? null;
  if (entrante != null && entrante > ultimoNuestroMs) {
    return {
      estado: 'respondio',
      etiqueta: `Te respondió · ${haceTexto(entrante, ahora)}`,
      accion: 'atender',
      intentos, ultimoNuestroMs, respondioMs: entrante, vuelveEnMin: null,
    };
  }

  const transcurrido = ahora - ultimoNuestroMs;
  if (transcurrido < ESPERA_MS) {
    const vuelveEnMin = Math.max(1, Math.ceil((ESPERA_MS - transcurrido) / 60_000));
    return {
      estado: 'enfriando',
      // Dice CUÁNDO vuelve, no solo que se fue. Es la lección de los "no
      // contestó" que se enfriaban y desaparecían sin decir cuándo volvían.
      etiqueta: `Escrito ${haceTexto(ultimoNuestroMs, ahora)} · vuelve en ${vuelveEnMin} min`,
      accion: null,
      intentos, ultimoNuestroMs, respondioMs: null, vuelveEnMin,
    };
  }

  // Pasó la espera y no dijo nada. Al tercer intento el chat no está
  // funcionando con esta persona: se manda al teléfono.
  //
  // ⛔ `intentos` solo cuenta las gestiones de HOY (así viene de la base). Un
  // pedido al que le escribimos hace tres días y nadie volvió a tocar traía
  // `intentos = 0` y la etiqueta decía **"1º intento"** sobre alguien que ya
  // recibió un mensaje — visto en pantalla el 28-ago-2026. Si ImporChat
  // registra un saliente, hubo al menos un intento, lo hayamos anotado o no.
  const hechos = Math.max(intentos, salienteMs != null ? 1 : 0);
  const numero = hechos + 1;
  const llamar = hechos >= INTENTOS_ANTES_DE_LLAMAR;
  return {
    estado: 'reintento',
    etiqueta: llamar
      ? `${numero}º intento · mejor llamá`
      : `${numero}º intento · no contestó ${haceTexto(ultimoNuestroMs, ahora)}`,
    accion: llamar ? 'llamar' : 'insistir',
    intentos, ultimoNuestroMs, respondioMs: null, vuelveEnMin: null,
  };
}

/**
 * ¿Se esconde de la cola de trabajo ahora mismo?
 *
 * SOLO mientras se enfría. Es la diferencia con `estaGestionadoHoy`, que lo
 * escondía hasta el día siguiente — y son dos preguntas distintas que conviene
 * no mezclar:
 *   - `estaGestionadoHoy` → *"¿alguien lo trabajó hoy?"*. Es la MÉTRICA: alimenta
 *     el cierre del día, la productividad y el reporte. No cambia.
 *   - `enEspera` → *"¿me toca AHORA?"*. Es la COLA. Vuelve a la hora.
 */
export function enEspera(c: Ciclo): boolean {
  return c.estado === 'enfriando';
}

/**
 * Orden dentro de la columna.
 *
 * Pedido del dueño: *"que armemos las cosas por orden de prioridad desde qué día
 * está en oficina, desde qué día está en novedad — no desde que nació el
 * pedido"*. Ese "desde qué día" lo aporta el llamador con `diasSinMovimiento`;
 * acá solo se decide qué va arriba de eso:
 *
 *   1. **Respondió** — hay una persona esperando respuesta ahora mismo.
 *   2. Todo lo demás, por días en el estado (el más viejo primero: es el que
 *      está más cerca de que la transportadora lo devuelva).
 *   3. **Enfriando** al fondo — se acaba de tocar, no hay nada que hacerle.
 *
 * A propósito NO hay un escalón entre "reintento" y "sin tocar": los dos
 * necesitan trabajo hoy, y ponerlos en niveles distintos terminaría enterrando
 * a uno de los dos grupos a medida que crece el otro.
 */
export function rangoCiclo(c: Ciclo): number {
  if (c.estado === 'respondio') return 0;
  if (c.estado === 'enfriando') return 2;
  return 1;
}

import { RIESGO_INFO, type NivelRiesgo } from '@/lib/riesgoChat';
import { ESPERA_REINTENTO_MIN, textoEspera } from '@/lib/cicloContacto';

/**
 * El glosario de las etiquetas — UNA sola fuente para las dos pantallas.
 *
 * ── Por qué existe (28-ago-2026) ────────────────────────────────────────────
 * Pedido del dueño: *"que puedan diferenciar y coincidir en las etiquetas"*.
 * Llamada y Seguimiento describen los MISMOS hechos con vocabularios distintos,
 * y la asesora que pasa de una a la otra traduce de memoria:
 *
 *   Llamada:     "Llamar — no usa chat" · "No confirmó por el chat" ·
 *                "Quedó con dudas" · "Sin leer" · "Ya confirmó"
 *   Seguimiento: "Sin avisar" · "Te respondió · hace X" ·
 *                "Escrito hace X · vuelve en 3 h" · "2º intento"
 *
 * Peor: dos de ellas llegaron a CONTRADECIRSE en la misma fila. El chip decía
 * "No respondió" (que medía si el cliente apretó el botón de confirmar de ESE
 * pedido) al lado de "el cliente escribió y sigue sin respuesta" (que mira toda
 * la conversación). Las dos ciertas, leídas como opuestas.
 *
 * Acá no se inventa vocabulario nuevo: se ANOTA el que ya existe, se dice qué
 * mide cada uno y con cuál del otro lado se corresponde. La página
 * `/como-se-trabaja` lo dibuja, y el guardián `etiquetasTrabajo.test.ts` falla
 * si alguien agrega una etiqueta y no la explica — el mismo trato que ya tienen
 * los escalones de la escalera y las listas SLA.
 *
 * ⛔ Las etiquetas de Llamada NO se copian a mano: salen de `RIESGO_INFO`. Una
 * copia se desincroniza el día que alguien cambia el texto en un solo lado, que
 * es exactamente el problema que este archivo vino a cerrar.
 */

export type Pantalla = 'llamada' | 'seguimiento';

export interface EntradaGlosario {
  /** Clave estable. No se muestra; sirve para el guardián y para los anclajes. */
  clave: string;
  /** Dónde la ve la asesora. */
  pantalla: Pantalla;
  /** El texto EXACTO que aparece en la tarjeta o la fila. */
  etiqueta: string;
  /** Qué mide, en cristiano. */
  que: string;
  /** Qué se hace con eso. */
  queHacer: string;
  /**
   * La etiqueta de la OTRA pantalla que habla del mismo hecho, si la hay.
   * `null` cuando no existe equivalente — decirlo es parte del glosario: la
   * asesora tiene que saber que ese dato solo lo va a ver de un lado.
   */
  equivaleA: string | null;
}

/** Las de Llamada salen de `RIESGO_INFO`, sin copiar texto. */
const DE_LLAMADA: Array<{ nivel: NivelRiesgo; queHacer?: string; equivaleA: string | null }> = [
  { nivel: 'mudo', equivaleA: 'Sin avisar' },
  { nivel: 'frio', equivaleA: 'No contestó · toca llamar' },
  { nivel: 'tibio', equivaleA: 'Te respondió' },
  { nivel: 'sin_dato', equivaleA: 'Sin avisar' },
  { nivel: 'confirmado', equivaleA: null },
];

/**
 * Las de Seguimiento salen de los estados de `cicloContacto`. El texto real
 * lleva la hora adentro ("Te respondió · hace 3 h"), así que acá va la forma sin
 * el reloj — es lo que la asesora reconoce de un vistazo.
 */
const DE_SEGUIMIENTO: Array<Omit<EntradaGlosario, 'pantalla'>> = [
  {
    clave: 'seg-sin-avisar',
    etiqueta: 'Sin avisar',
    que: 'Nadie le escribió a este cliente por este pedido, y tampoco quedó registrada ninguna gestión.',
    queHacer: 'Es el primer contacto. Mandale el mensaje de su fase.',
    equivaleA: 'Llamar — no usa chat',
  },
  {
    clave: 'seg-respondio',
    etiqueta: 'Te respondió',
    que: 'El cliente escribió DESPUÉS de lo último que le mandamos. Hay una persona esperando.',
    queHacer: 'Se lee y se contesta antes que nada. Es lo único que no puede esperar.',
    equivaleA: 'Quedó con dudas',
  },
  {
    clave: 'seg-enfriando',
    etiqueta: 'Escrito · vuelve en un rato',
    que: `Se lo acaba de trabajar. Sale de la cola ${textoEspera(ESPERA_REINTENTO_MIN)} para darle tiempo al cliente de contestar.`,
    queHacer: 'Nada. Vuelve solo — y antes si el cliente responde.',
    equivaleA: null,
  },
  {
    clave: 'seg-reintento',
    etiqueta: '2º intento · no contestó',
    que: 'Pasó la espera y el cliente no dijo nada. Se cuenta cuántas veces se intentó hoy.',
    queHacer: 'Insistir. Al tercero el chat no está funcionando con esa persona: se llama.',
    equivaleA: 'No confirmó por el chat',
  },
  {
    clave: 'seg-llamar',
    etiqueta: 'No contestó · toca llamar',
    que: 'Ya se le escribió dos veces sin respuesta.',
    queHacer: 'Llamada telefónica. Mandar un tercer mensaje al mismo silencio no cambia nada.',
    equivaleA: 'Llamar — no usa chat',
  },
  {
    clave: 'seg-esperando-transportadora',
    etiqueta: 'Esperando transportadora',
    que: 'La transportadora cerró o dejó vencer la novedad. Dropi NO deja resolverla.',
    queHacer: 'Nada. No es trabajo pendiente — mirarlo es tiempo perdido.',
    equivaleA: null,
  },
  {
    clave: 'seg-ya-gestionado',
    etiqueta: 'Gestionado hoy · con el nombre de quien lo hizo',
    que: 'Alguien del equipo ya habló con este cliente hoy.',
    queHacer: 'No lo vuelvas a tocar: sería un segundo contacto al mismo cliente el mismo día.',
    equivaleA: null,
  },
  {
    clave: 'seg-intento-de-otra',
    etiqueta: 'Nombre · lo que marcó · hace cuánto',
    que: 'Una compañera ya lo intentó y NO logró hablar con el cliente. Por eso sigue en la cola.',
    queHacer: 'Podés seguir vos. No estás repitiendo: ella no llegó a hablarle.',
    equivaleA: null,
  },
  {
    clave: 'seg-sin-dato',
    etiqueta: 'sin dato',
    que: 'Dropi no reporta cuándo se movió este pedido por última vez.',
    queHacer: 'No es que esté quieto: es que no sabemos. Refrescalo desde Dropi si te importa el reloj.',
    equivaleA: null,
  },
];

/** El glosario completo, en el orden en que conviene leerlo. */
export const GLOSARIO_ETIQUETAS: EntradaGlosario[] = [
  ...DE_LLAMADA.map(({ nivel, equivaleA }) => {
    const i = RIESGO_INFO[nivel];
    return {
      clave: `llamada-${nivel}`,
      pantalla: 'llamada' as const,
      etiqueta: i.etiqueta,
      que: i.tasa === '—' ? i.que : `${i.que} ${i.tasa}.`,
      queHacer: i.queHacer,
      equivaleA,
    };
  }),
  ...DE_SEGUIMIENTO.map((e) => ({ ...e, pantalla: 'seguimiento' as const })),
];

/** Las de una pantalla. */
export function etiquetasDe(p: Pantalla): EntradaGlosario[] {
  return GLOSARIO_ETIQUETAS.filter((e) => e.pantalla === p);
}

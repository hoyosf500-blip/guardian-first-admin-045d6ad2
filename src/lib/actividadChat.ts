/**
 * ¿Le escribimos a este cliente? — el veredicto VERIFICADO contra ImporChat.
 *
 * Nació del pedido del dueño (24-ago-2026): "hay 75 pedidos en oficina, me
 * dicen que ya les escribieron — ¿cómo verifico yo eso?". El aviso que declara
 * la asesora (touchpoint "Avisé: en oficina") es una palabra; esto compara
 * contra lo que ImporChat REGISTRÓ: el último mensaje que salió del negocio
 * hacia ese cliente (`orders.chat_saliente_at`, lo escribe `importchat-sync`).
 *
 * Regla de la casa: un NULL jamás se lee como "no le escribieron". "No le
 * escribieron" solo se afirma con la conversación LEÍDA (leidoAt) y cero
 * salientes. Sin lectura, el veredicto es `sin_dato` y la pantalla lo dice.
 */

/** La actividad de chat de UN pedido, como la sirve `useRiesgoChat`. */
export interface ActividadChatOrden {
  /** Último mensaje del negocio al cliente (ms epoch), o null si nunca hubo. */
  salienteAt: number | null;
  /** 'plantilla' | 'directo'. El export de ImporChat NO dice si fue el bot o
   *  una asesora — esto es el TIPO del mensaje, no su autor. */
  salienteTipo: 'plantilla' | 'directo' | null;
  /** Último mensaje del cliente (ms epoch). */
  entranteAt: number | null;
  /** Cuándo importchat-sync leyó esta conversación (ms epoch). */
  leidoAt: number;
}

export type VeredictoAviso =
  /** Hubo mensaje del negocio DESPUÉS del reloj de referencia (ej.: llegó a la agencia y sí se le avisó). */
  | 'escrito_despues'
  /** Se le escribió alguna vez, pero NADA después del reloj de referencia. */
  | 'escrito_antes'
  /** Se le escribió, pero no hay reloj de referencia para comparar (sin last_movement_at). */
  | 'escrito_sin_reloj'
  /** Conversación LEÍDA y ni un solo mensaje del negocio, jamás. */
  | 'nunca_escrito'
  /** La conversación no se leyó todavía: no se afirma nada. */
  | 'sin_dato';

/**
 * Compara la actividad del chat contra un reloj de referencia (típicamente la
 * llegada del paquete a la agencia = `last_movement_at`).
 *
 * `llegadaMs` null = no hay reloj: se degrada a "escrito / nunca escrito" sin
 * afirmar el "después", que sería inventar una comparación sin una de las dos
 * fechas.
 */
export function veredictoAviso(
  act: ActividadChatOrden | null | undefined,
  llegadaMs: number | null,
): VeredictoAviso {
  if (!act) return 'sin_dato';
  if (act.salienteAt == null) return 'nunca_escrito';
  if (llegadaMs == null) return 'escrito_sin_reloj';
  return act.salienteAt >= llegadaMs ? 'escrito_despues' : 'escrito_antes';
}

/** "hace 2 h" / "hace 3 días" — para el chip. Sin palabra inventada si el
 *  delta es negativo (reloj corrido): devuelve "recién". */
export function haceCuantoMs(ms: number, ahoraMs: number = Date.now()): string {
  const delta = ahoraMs - ms;
  if (delta < 0) return 'recién';
  const h = delta / 3_600_000;
  if (h < 1) return `hace ${Math.max(1, Math.round(delta / 60_000))} min`;
  if (h < 48) return `hace ${Math.round(h)} h`;
  return `hace ${Math.round(h / 24)} días`;
}

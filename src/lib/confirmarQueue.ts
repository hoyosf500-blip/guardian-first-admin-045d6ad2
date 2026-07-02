// confirmarQueue — lógica PURA de ordenamiento para la cola de /confirmar.
//
// Por qué existe (Hallazgo 4, falla de diseño): la cola compartía el comparador
// `calcPriority` con Seguimiento. Para un PENDIENTE CONFIRMACION recién creado,
// `calcPriority` da ~0 (diasConf=0, stage 'otro', el valor EC en USD no cruza
// los umbrales en COP), así que el desempate caía en `b.dias - a.dias` = MÁS
// VIEJO PRIMERO. Resultado perverso: el comprador de hace 5 minutos —el que hay
// que llamar YA, cuando la intención de compra está caliente— quedaba al fondo,
// debajo de "zombies" de 7+ días que ya casi nunca compran.
//
// `compareConfirmar` invierte esa prioridad para el caso de CONFIRMAR:
//   1. Recordatorio vencido primero (si la señal llega en OrderData; hoy vive en
//      ConfirmarTab/useOrderNotesIndex y NO baja a OrderContext — ver README del
//      call-site y `concerns`).
//   2. Reintento listo (retryCount) primero — el no-contestó que ya cumplió el
//      cooldown.
//   3. FRESCURA: los pedidos de HOY, el MÁS NUEVO primero (intención caliente).
//   4. El resto por antigüedad (más nuevo primero dentro de "no-hoy"), con los
//      D4+ ("por cancelar", casi perdidos) empujados AL FINAL.
//
// Es country-agnostic y no toca `calcPriority` (compartido con Seguimiento).

/** Subconjunto de OrderData que el comparador necesita. Se deja laxo a
 *  propósito para poder testear con objetos mínimos sin construir un OrderData
 *  completo (TS no estricto en este repo). */
export interface ConfirmarQueueOrder {
  dias?: number;
  createdAt?: string | null;
  retryCount?: number;
  result?: string;
  /** Recordatorio próximo/ya vencido (ISO). Opcional: hoy NO baja a
   *  OrderContext, se integra en ConfirmarTab. Si algún día llega aquí, el
   *  comparador ya lo respeta. */
  nextReminderAt?: string | null;
}

/** Umbral de "por cancelar / casi perdido": D4+ va al fondo de la cola. */
export const DIAS_POR_CANCELAR = 4;

/**
 * ¿El pedido tiene un recordatorio YA vencido (o que vence en ≤`lookaheadMs`)?
 * Un recordatorio malformado o ausente cuenta como "no urgente" (false).
 */
export function hasDueReminder(
  o: ConfirmarQueueOrder,
  nowMs: number = Date.now(),
  lookaheadMs = 0,
): boolean {
  if (!o.nextReminderAt) return false;
  const t = Date.parse(o.nextReminderAt);
  if (!Number.isFinite(t)) return false;
  return t <= nowMs + lookaheadMs;
}

/** ¿El reintento está listo? (no-contestó con cooldown cumplido y sin resolver) */
export function isRetryReady(o: ConfirmarQueueOrder): boolean {
  return !!o.retryCount && !o.result;
}

/**
 * Días efectivos del pedido para ordenar por frescura.
 * Prefiere `createdAt` (tiene HORA → distingue "hace 5 min" de "hace 20 h" el
 * mismo día). Si no viene o está malformado, cae a `dias` (granularidad de día).
 * Devuelve un número de días como float (más chico = más nuevo).
 */
export function effectiveAgeDays(
  o: ConfirmarQueueOrder,
  nowMs: number = Date.now(),
): number {
  if (o.createdAt) {
    const t = Date.parse(o.createdAt);
    if (Number.isFinite(t)) {
      return Math.max(0, (nowMs - t) / 86400000);
    }
  }
  return Math.max(0, o.dias ?? 0);
}

/** ¿El pedido entró HOY? (menos de 1 día de antigüedad efectiva) */
export function isFreshToday(
  o: ConfirmarQueueOrder,
  nowMs: number = Date.now(),
): boolean {
  return effectiveAgeDays(o, nowMs) < 1;
}

// Rango numérico de "bucket" — más chico = más arriba en la cola.
// Con buckets discretos el desempate por edad queda bien definido y estable.
const BUCKET_REMINDER = 0; // recordatorio vencido → lo más urgente
const BUCKET_RETRY = 1;    // reintento listo
const BUCKET_FRESH = 2;    // pedido de hoy
const BUCKET_OLD = 3;      // viejo (no-hoy, < D4)
const BUCKET_CANCEL = 4;   // D4+ "por cancelar" → al fondo

function bucketOf(o: ConfirmarQueueOrder, nowMs: number): number {
  if (hasDueReminder(o, nowMs)) return BUCKET_REMINDER;
  if (isRetryReady(o)) return BUCKET_RETRY;
  const age = effectiveAgeDays(o, nowMs);
  if (age < 1) return BUCKET_FRESH;
  if (age >= DIAS_POR_CANCELAR) return BUCKET_CANCEL;
  return BUCKET_OLD;
}

/**
 * Comparador PURO de la cola de Confirmar. Ordena así (menor primero):
 *   1) recordatorio vencido, 2) reintento listo, 3) frescos de hoy (más nuevo
 *   primero), 4) viejos (más nuevo primero), 5) D4+ por cancelar (al fondo).
 * Dentro de cada bucket, el más NUEVO va primero (menor edad efectiva).
 * Estable ante empates (edad idéntica → devuelve 0, `Array.sort` conserva orden).
 */
export function compareConfirmar(
  a: ConfirmarQueueOrder,
  b: ConfirmarQueueOrder,
  nowMs: number = Date.now(),
): number {
  const ba = bucketOf(a, nowMs);
  const bb = bucketOf(b, nowMs);
  if (ba !== bb) return ba - bb;
  // Mismo bucket → el más nuevo (menor edad efectiva) primero.
  const aa = effectiveAgeDays(a, nowMs);
  const ab = effectiveAgeDays(b, nowMs);
  if (aa !== ab) return aa - ab;
  return 0; // empate → estable
}

/**
 * Helper de render: separa la cola en "calientes de hoy" (recordatorios,
 * reintentos y frescos de hoy — lo que hay que atacar YA) vs "viejos por
 * cancelar" (D4+). Cada grupo ya viene ordenado por `compareConfirmar`.
 * No muta la entrada.
 */
export function splitCalientesVsViejos<T extends ConfirmarQueueOrder>(
  orders: T[],
  nowMs: number = Date.now(),
): { calientes: T[]; porCancelar: T[] } {
  const sorted = [...orders].sort((a, b) => compareConfirmar(a, b, nowMs));
  const calientes: T[] = [];
  const porCancelar: T[] = [];
  for (const o of sorted) {
    if (bucketOf(o, nowMs) === BUCKET_CANCEL) porCancelar.push(o);
    else calientes.push(o);
  }
  return { calientes, porCancelar };
}

// —————————————————————————————————————————————————————————————————————————
// Escalera de reintentos N/R (Hallazgo "N/R escalera").
//
// Antes: cooldown PLANO de 2 h entre intentos (COOLDOWN_HOURS=2). Rígido: el
// primer reintento de un "no contestó" recién hecho tardaba 2 h en habilitarse,
// cuando en la práctica conviene reintentar mucho antes (la persona pudo estar
// ocupada 20 min). La escalera arranca corto y se estira:
//   intento 1 → ~0.4 h (25 min), intento 2 → 1 h, intento 3 → 2 h.
//
// El CAP de intentos/día SIGUE en 3 (MAX_DAILY_ATTEMPTS) — NO subirlo: la RPC
// `pending_retry_list` asume cap 3 y hay que quedar alineados (ver `concerns`).
// —————————————————————————————————————————————————————————————————————————

/** Horas de cooldown según cuántos intentos N/R ya hubo HOY (escalera).
 *  `attemptNumber` = cantidad de noresp ya registrados hoy para el pedido:
 *    1 → 0.4 h (~25 min) antes del 1er reintento
 *    2 → 1 h
 *    3+ → 2 h
 *  Defensivo: valores <1 se tratan como 1 (nunca cooldown 0). */
export function cooldownHoursForAttempt(attemptNumber: number): number {
  const n = Number.isFinite(attemptNumber) ? Math.floor(attemptNumber) : 1;
  if (n <= 1) return 0.4;
  if (n === 2) return 1;
  return 2;
}

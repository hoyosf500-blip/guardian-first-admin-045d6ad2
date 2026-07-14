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
 * Días efectivos del pedido para el DESEMPATE FINO (intra-día).
 * Prefiere `createdAt` (tiene HORA → distingue "hace 5 min" de "hace 20 h" el
 * mismo día). Si no viene o está malformado, cae a `dias` (granularidad de día).
 * Devuelve un número de días como float (más chico = más nuevo).
 *
 * OJO: esta señal NO define el bucket — para eso está `realAgeDays`. Usar
 * `createdAt` como señal GRUESA rompe la cola: un zombie backfilleado recibe
 * `created_at = now()` en nuestra DB y aparentaría "fresco" aunque en Dropi
 * tenga 30 días. `effectiveAgeDays` sólo ordena DENTRO de un bucket ya fijado
 * por la edad real.
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

/**
 * Edad REAL del pedido (antigüedad en Dropi), en días — la señal GRUESA que
 * define el BUCKET. `o.dias` (lo que Dropi reporta) MANDA sobre `createdAt`.
 *
 * Por qué (Hallazgo 4, corrección): `createdAt` es el timestamp de inserción en
 * NUESTRA DB (default `now()`). Un pedido zombie de hace 30 días re-importado
 * hoy recibe `created_at = hoy` → con `effectiveAgeDays` caería en el bucket
 * "fresco" y FLOTARÍA AL TOPE, exactamente lo contrario del propósito del
 * módulo. Usando `dias` (edad real) el zombie cae en "por cancelar" (D4+) y el
 * `createdAt` reciente sólo desempata dentro de su bucket. Si `dias` falta, se
 * deriva de `createdAt` como último recurso.
 */
export function realAgeDays(
  o: ConfirmarQueueOrder,
  nowMs: number = Date.now(),
): number {
  if (typeof o.dias === 'number' && Number.isFinite(o.dias)) {
    return Math.max(0, o.dias);
  }
  // Sin `dias` confiable: derivar de createdAt (granularidad de día).
  if (o.createdAt) {
    const t = Date.parse(o.createdAt);
    if (Number.isFinite(t)) {
      return Math.max(0, (nowMs - t) / 86400000);
    }
  }
  return 0;
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
  // Bucket por edad REAL (Dropi), NO por createdAt: un zombie backfilleado no
  // debe colarse al bucket "fresco" sólo porque su fila se insertó hoy.
  const age = realAgeDays(o, nowMs);
  if (age < 1) return BUCKET_FRESH;
  if (age >= DIAS_POR_CANCELAR) return BUCKET_CANCEL;
  return BUCKET_OLD;
}

/**
 * Comparador PURO de la cola de Confirmar. Ordena así (menor primero):
 *   1) recordatorio vencido, 2) reintento listo, 3) frescos de hoy (más nuevo
 *   primero), 4) viejos (más nuevo primero), 5) D4+ por cancelar (al fondo).
 * Dentro de cada bucket, el más NUEVO va primero: primero por edad REAL
 * (`realAgeDays`, Dropi) y, a igualdad, por `createdAt` (desempate intra-día).
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
  // Mismo bucket → primero por edad REAL (grueso: el más nuevo en Dropi arriba).
  const ra = realAgeDays(a, nowMs);
  const rb = realAgeDays(b, nowMs);
  if (ra !== rb) return ra - rb;
  // Misma edad real → desempate FINO por createdAt (distingue intra-día).
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
// Reintentos N/R — cooldown PLANO de 2 h (regla del dueño, 2026-07-07).
//
// Regla operativa: si el cliente no contestó, se hacen hasta 3 intentos, uno
// cada 2 horas. Ej.: llamó a las 10 → el pedido vuelve a la cola a las 12 →
// vuelve a las 14 → y ahí se cierra el día (cap 3). Antes había una escalera
// (25 min → 1 h → 2 h) que reintentaba el primero mucho antes; el dueño la
// cambió por 2 h parejo (más predecible para el equipo).
//
// El CAP de intentos/día SIGUE en 3 (MAX_DAILY_ATTEMPTS) — NO subirlo: la RPC
// `pending_retry_list` asume cap 3 y hay que quedar alineados (ver `concerns`).
// —————————————————————————————————————————————————————————————————————————

/** Horas de cooldown antes de que un "no contestó" vuelva a la cola.
 *  Plano en 2 h para todos los intentos (llamó 10 → vuelve 12 → 14). El
 *  parámetro se mantiene por compatibilidad de firma con los call-sites. */
export function cooldownHoursForAttempt(_attemptNumber?: number): number {
  return 2;
}

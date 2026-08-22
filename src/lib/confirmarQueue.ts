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

import { compararRiesgo, type NivelRiesgo } from './riesgoChat';

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
  /** Qué hizo el cliente con el botón del WhatsApp (viene de ImporChat vía
   *  `orders.chat_riesgo`). `null`/ausente = todavía no hay señal, y el
   *  comparador lo trata como neutro. Ver `src/lib/riesgoChat.ts`. */
  riesgoChat?: NivelRiesgo | null;
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

/**
 * "Próximo" = recordatorio que llega en ≤1 h o que ya pasó (vencido).
 *
 * Vivía duplicado como const local en ConfirmarTab y en WorkFilters con el mismo
 * valor. Está acá porque ahora además define la frontera de `estaAplazado`: si
 * los tres números se separaran, un pedido podría quedar escondido de la cola Y
 * fuera del chip de recordatorios al mismo tiempo — invisible.
 */
export const REMIND_LOOKAHEAD_MS = 60 * 60 * 1000;

/** ¿El reintento está listo? (no-contestó con cooldown cumplido y sin resolver) */
export function isRetryReady(o: ConfirmarQueueOrder): boolean {
  return !!o.retryCount && !o.result;
}

/**
 * ¿El pedido está APLAZADO? = tiene recordatorio a futuro, más allá de la
 * ventana de "próximo" (1 h).
 *
 * Es lo que hace real el REAGENDAMIENTO: un cliente que dijo "llamame el viernes"
 * no puede seguir apareciendo hoy en la cola de pendientes — la asesora lo
 * volvería a llamar hoy, que es exactamente lo que él pidió que no pasara, y de
 * paso ensucia el conteo de "cuánto me falta hoy".
 *
 * ⚠️ ESCONDER TRABAJO ES PELIGROSO y en este repo ya costó caro (ver
 * `resumenSinRespuestaHoy`: los pedidos enfriando desaparecían sin decir cuándo
 * volvían, y el equipo daba el día por terminado con 35 clientes vivos). Por eso
 * un aplazado NO se borra: sale del filtro "Pendientes" pero tiene su propio chip
 * con la cuenta y su propia lista. Se puede ver siempre; simplemente no estorba.
 *
 * Un pedido YA resuelto (`result`) nunca es aplazado: ya terminó.
 */
export function estaAplazado(
  o: ConfirmarQueueOrder,
  nowMs: number = Date.now(),
  lookaheadMs: number = REMIND_LOOKAHEAD_MS,
): boolean {
  if (o.result) return false;
  if (!o.nextReminderAt) return false;
  const t = Date.parse(o.nextReminderAt);
  if (!Number.isFinite(t)) return false;
  return t > nowMs + lookaheadMs;
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
  // Mismo bucket → primero por lo que hizo el CLIENTE con el WhatsApp.
  //
  // Va antes que la edad porque la edad, medida contra el reloj real, no
  // distingue nada dentro del primer día: <2 h 19,3% · 2-6 h 18,4% · 6-24 h
  // 20,1% de cancelación (agosto-2026 EC, 765 pedidos resueltos). El botón de
  // confirmar parte esa MISMA población en 10,4% y 57,7%.
  //
  // La regla de frescura de abajo no se borra: sigue desempatando, y sigue
  // siendo la que manda mientras no haya señal — un pedido sin `riesgoChat`
  // cuenta como neutro, así que con la sincronización apagada esta línea no
  // cambia absolutamente nada.
  const rr = compararRiesgo(a.riesgoChat ?? null, b.riesgoChat ?? null);
  if (rr !== 0) return rr;
  // Mismo riesgo → primero por edad REAL (grueso: el más nuevo en Dropi arriba).
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
// Reintentos N/R — cooldown PLANO de 1 h (regla del dueño; 2 h hasta 31-jul-2026).
//
// Regla operativa: si el cliente no contestó, se hacen hasta 3 intentos, uno
// cada HORA (ver COOLDOWN_MINUTES). Ej.: llamó a las 9 → vuelve a la cola a las
// 10 → a las 11 → y ahí se cierra el día (cap 3). Fue 2 h hasta el 31-jul-2026:
// con la jornada de 8 a 5, ese intervalo dejaba fuera de los 3 intentos a todo
// pedido que entrara después de la 1 de la tarde.
//
// El CAP de intentos/día SIGUE en 3 (MAX_DAILY_ATTEMPTS) — NO subirlo: la RPC
// `pending_retry_list` asume cap 3 y hay que quedar alineados (ver `concerns`).
// —————————————————————————————————————————————————————————————————————————

/**
 * Tope de llamadas por pedido y por DÍA. Vivía como const suelta dentro de
 * `buildWorkQueue` y la pantalla no lo sabía: la asesora no tenía forma de ver
 * cuántos intentos le quedaban a un cliente hoy. Se exporta para que el
 * contador "Hoy 2 de 3" y el cooldown salgan del MISMO número — si mañana el
 * dueño lo sube a 4, se cambia acá y las dos cosas se enteran.
 *
 * NO subirlo sin mirar la RPC `pending_retry_list`, que asume cap 3.
 */
export const MAX_DAILY_ATTEMPTS = 3;

/**
 * Minutos que espera un "no contestó" antes de volver a la cola.
 *
 * 60 min desde el 31-jul-2026. Sale de la jornada de 8 a 5 y de una cuenta:
 * para que un cliente alcance sus 3 llamadas dentro del horario, la última
 * tiene que caber antes de las 17:00. Con 60 min, el que entra a las 15:00
 * todavía llega (15 → 16 → 17); con 90 el corte se adelanta a las 14:00 y con
 * 120 a las 13:00. Medido sobre 2.599 clientes-día reales, eso es la
 * diferencia entre que alcance el 61% o el 52%.
 *
 * NO es "llamar más rápido": el intervalo real que hace el equipo es de 3h30
 * (mediana medida). Bajarlo solo ABRE la ventana antes; nadie llama antes de
 * lo que puede. Y espaciar más tampoco protegía al cliente — lo que hacía era
 * dejar llamadas del día sin usar.
 *
 * Si se cambia, cambia solo acá: los textos de pantalla y el panel de "no
 * contestaron" leen `COOLDOWN_LABEL` y esta misma función.
 */
export const COOLDOWN_MINUTES = 60;

/** Cómo se dice en pantalla. Derivado, para que nunca diga "2h" con la regla en 1. */
export const COOLDOWN_LABEL: string =
  COOLDOWN_MINUTES % 60 === 0
    ? (COOLDOWN_MINUTES / 60 === 1 ? '1 hora' : `${COOLDOWN_MINUTES / 60} horas`)
    : `${COOLDOWN_MINUTES} min`;

/** Horas de cooldown antes de que un "no contestó" vuelva a la cola.
 *  El parámetro se mantiene por compatibilidad de firma con los call-sites:
 *  el intervalo es PLANO (no escalera) por decisión del dueño. */
export function cooldownHoursForAttempt(_attemptNumber?: number): number {
  return COOLDOWN_MINUTES / 60;
}

/** Fila de `order_results` necesaria para el resumen de "sin respuesta". */
export interface FilaResultado {
  order_id: string | null;
  phone: string;
  result: string;
  result_date: string | null;
  created_at: string;
}

export interface ResumenSinRespuesta {
  /** Clientes que hoy no contestaron y cuyo pedido sigue abierto. */
  total: number;
  /** Ya cumplieron el enfriamiento: se pueden llamar AHORA. */
  listos: number;
  /** Esperando a que se cumpla el enfriamiento. Vuelven solos a la cola. */
  enfriando: number;
  /** Usaron los 3 intentos del día: no vuelven hasta mañana. */
  agotados: number;
  /** Minutos que faltan para que vuelva el PRÓXIMO. null si no hay ninguno. */
  proximoEnMinutos: number | null;
  /** Cuántas llamadas del día quedan sin usar entre todos. Es la plata que se
   *  pierde si nadie las hace antes de que termine la jornada. */
  llamadasDisponibles: number;
}

/**
 * "No contestaron 36 — ¿y ahora qué?"
 *
 * La pantalla mostraba el 36 y nada más, mientras la cola decía "1 por
 * confirmar". El equipo daba el día por terminado con 35 clientes que todavía
 * tenían llamadas disponibles, porque estaban ENFRIANDO (esperando el turno) y
 * un pedido enfriando no se ve en ningún lado: no está en la cola ni en ninguna
 * lista. Desaparecía sin decir cuándo volvía.
 *
 * Este resumen responde las tres preguntas de una: a cuántos puedo llamar YA,
 * cuántos están esperando y cuándo vuelve el primero, y cuántos ya no tienen
 * más intentos hoy.
 *
 * Agrupa por TELÉFONO, no por pedido: así es como el sistema aplica el tope de
 * 3 (si un cliente tiene dos pedidos, las llamadas son a la misma persona). Es
 * la misma regla que usa el cooldown en `buildWorkQueue` — si divergieran, este
 * panel prometería llamadas que la cola nunca va a devolver.
 *
 * `ahoraMs` se inyecta para poder testear sin depender del reloj.
 *
 * `pedidosVivos` = los pedidos que SIGUEN pendientes de confirmar. Sin esta
 * lista el resumen se guía solo por `order_results`, y ahí un pedido cancelado
 * DIRECTO EN DROPI (o por la reconciliación nocturna) no deja ninguna fila: el
 * panel lo seguía contando como "se puede llamar ya". Verificado en producción
 * el 31-jul: decía 35 cuando la cola entregaba 31, y los 4 de diferencia
 * estaban CANCELADOS. Se omite si no se pasa — no saber cuáles viven no es lo
 * mismo que saber que murieron.
 */
export function resumenSinRespuestaHoy(
  filas: FilaResultado[] | null | undefined,
  hoyLocal: string,
  ahoraMs: number,
  pedidosVivos?: Set<string> | null,
): ResumenSinRespuesta {
  const vacio: ResumenSinRespuesta = {
    total: 0, listos: 0, enfriando: 0, agotados: 0,
    proximoEnMinutos: null, llamadasDisponibles: 0,
  };
  if (!filas || !filas.length) return vacio;

  const deHoy = filas.filter((f) => f.result_date === hoyLocal);
  // Pedidos que HOY terminaron en confirmado o cancelado: ya no son "sin
  // respuesta" aunque antes no hubieran contestado.
  const cerrados = new Set(
    deHoy.filter((f) => (f.result === 'conf' || f.result === 'canc') && f.order_id)
      .map((f) => f.order_id as string),
  );

  const porTelefono = new Map<string, number[]>();
  for (const f of deHoy) {
    if (f.result !== 'noresp' || !f.phone) continue;
    if (f.order_id && cerrados.has(f.order_id)) continue;
    // El pedido ya no está pendiente (lo cancelaron en Dropi, se despachó…):
    // no hay a quién llamar, aunque hoy no haya contestado.
    if (pedidosVivos && (!f.order_id || !pedidosVivos.has(f.order_id))) continue;
    const t = Date.parse(f.created_at);
    if (!Number.isFinite(t)) continue;
    const arr = porTelefono.get(f.phone);
    if (arr) arr.push(t); else porTelefono.set(f.phone, [t]);
  }
  if (!porTelefono.size) return vacio;

  const cooldownMs = cooldownHoursForAttempt() * 3600_000;
  const out: ResumenSinRespuesta = { ...vacio, total: porTelefono.size };
  let proximoMs = Infinity;

  for (const intentos of porTelefono.values()) {
    if (intentos.length >= MAX_DAILY_ATTEMPTS) { out.agotados += 1; continue; }
    out.llamadasDisponibles += MAX_DAILY_ATTEMPTS - intentos.length;
    const ultimo = Math.max(...intentos);
    const falta = ultimo + cooldownMs - ahoraMs;
    if (falta <= 0) {
      out.listos += 1;
    } else {
      out.enfriando += 1;
      if (falta < proximoMs) proximoMs = falta;
    }
  }
  out.proximoEnMinutos = Number.isFinite(proximoMs) ? Math.ceil(proximoMs / 60_000) : null;
  return out;
}

/**
 * ¿Los dos resúmenes dicen lo mismo?
 *
 * Este resumen se recalcula cada minuto contra el reloj (el "vuelve en 12 min"
 * tiene que bajar a 11). Como `resumenSinRespuestaHoy` devuelve un objeto nuevo
 * siempre, sin esta comparación cada tick cambiaría la referencia del contexto y
 * re-renderizaría la cola entera 1.440 veces al día para pintar los mismos
 * números.
 */
export function mismoResumen(
  a: ResumenSinRespuesta | null,
  b: ResumenSinRespuesta | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.total === b.total
    && a.listos === b.listos
    && a.enfriando === b.enfriando
    && a.agotados === b.agotados
    && a.proximoEnMinutos === b.proximoEnMinutos
    && a.llamadasDisponibles === b.llamadasDisponibles;
}

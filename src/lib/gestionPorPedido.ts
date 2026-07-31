/**
 * "¿A este pedido ya lo llamó alguien HOY, y quién?"
 *
 * El dueño lo pidió con estas palabras: "para yo no tener que preguntarles si
 * esos ya los llamaron". Hasta ahora el dato existía pero estaba ESCONDIDO: los
 * intentos viven en `order_results` con su `operator_id`, y la única forma de
 * verlos era ABRIR el pedido (AttemptHistory dentro de CallView). En la lista de
 * la cola solo se veía un "2/3" sin nombre ni hora — así que para saber si una
 * compañera ya había llamado había que preguntar.
 *
 * Ojo con la diferencia que causaba la confusión:
 *  - `myConfirmTouchedToday` (OrderContext) = lo que toqué YO. Alimenta el chip
 *    "Tu cola hoy" y el toggle "Solo sin tocar". Es PERSONAL a propósito.
 *  - lo de acá = lo que tocó CUALQUIERA del equipo. Es lo que evita la llamada
 *    repetida al mismo cliente.
 * Una asesora podía leer "Te faltan 33 sin tocar" y llamar a 20 que una
 * compañera ya había llamado esa misma mañana: para ELLA estaban sin tocar.
 *
 * Se calcula sobre las MISMAS filas que ya trae `buildWorkQueue` para el
 * cooldown (7 días, store-wide, paginadas) — cero consultas nuevas.
 */

/** Fila de `order_results` tal como la trae buildWorkQueue. */
export interface FilaIntento {
  order_id: string | null;
  result: string;
  /** Lo que anotó la asesora al marcar (motivo de cancelación, qué pidió el
   *  cliente…). Es el "¿y qué dijo?" que hoy obliga a abrir el pedido. */
  reason?: string | null;
  result_date: string | null;
  created_at: string;
  operator_id: string | null;
}

export interface GestionDelPedido {
  /** Cuántas veces lo llamó el EQUIPO hoy (cada llamada cuenta, no se dedupea). */
  intentos: number;
  /** ISO del intento más reciente de hoy. */
  ultimoAt: string;
  /** Quién hizo ese último intento (user_id; el nombre lo resuelve useOperatorNames). */
  ultimoPor: string | null;
  /** Resultado del último intento: 'conf' | 'canc' | 'noresp'. */
  ultimoResult: string;
  /** Lo que quedó anotado de ESE intento — el motivo de la cancelación, lo que
   *  pidió el cliente, etc. Es la respuesta a "¿y qué dijo?". `null` si la
   *  asesora no escribió nada. */
  ultimoMotivo: string | null;
}

/**
 * Cómo se lee en pantalla un resultado de llamada. Se traduce acá y no en el
 * componente para que Confirmar, Seguimiento y la ficha del pedido digan lo
 * mismo — 'noresp' es código interno, la asesora lee "No contestó".
 */
export function etiquetaResultado(result: string): string {
  if (result === 'conf') return 'Confirmó';
  if (result === 'canc') return 'Canceló';
  if (result === 'noresp') return 'No contestó';
  // Seguimiento guarda el método tal cual ("Envié la guía"): ya es legible.
  return result;
}

/**
 * "hace 20 min" / "hace 3 h" / "ayer".
 *
 * La hora del reloj ("14:35") obliga a hacer la cuenta mentalmente y a las 9am
 * no dice si fue hoy. Lo que la asesora necesita saber antes de volver a marcar
 * un número es CUÁNTO HACE, no a qué hora fue.
 *
 * `ahoraMs` se inyecta para poder testear sin depender del reloj real.
 */
export function haceCuanto(iso: string, ahoraMs: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const min = Math.floor((ahoraMs - t) / 60_000);
  // Un reloj adelantado en el equipo de la asesora daría "hace -3 min", que
  // parece un error del sistema. Se trata como recién.
  if (min < 1) return 'recién';
  if (min < 60) return `hace ${min} min`;
  const horas = Math.floor(min / 60);
  if (horas < 24) return `hace ${horas} h`;
  const dias = Math.floor(horas / 24);
  return dias === 1 ? 'ayer' : `hace ${dias} días`;
}

/**
 * Solo resultados de LLAMADA. Las filas de auditoría ('edicion_orden',
 * 'cambio_transportadora') no son intentos de contacto: contarlas mostraría
 * "1 intento" en un pedido que nadie llamó — justo el dato que el dueño quiere
 * poder creer sin verificar. Mismo criterio que `isCallOutcome` del cooldown.
 */
const ES_LLAMADA = (r: string): boolean => r === 'conf' || r === 'canc' || r === 'noresp';

/** Milisegundos de un ISO; -Infinity si no parsea (nunca gana como "el último"). */
function ms(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : -Infinity;
}

/**
 * Agrupa por `order_id` los intentos de llamada de HOY.
 *
 * @param filas  order_results de los últimos 7 días (store-wide)
 * @param hoyLocal fecha Bogotá 'YYYY-MM-DD' — se compara contra `result_date`,
 *   que ya viene en fecha local; usar `created_at` (UTC) mandaría las llamadas
 *   de después de las 7pm al día siguiente.
 */
export function buildGestionPorPedido(
  filas: FilaIntento[] | null | undefined,
  hoyLocal: string,
): Map<string, GestionDelPedido> {
  const mapa = new Map<string, GestionDelPedido>();
  if (!filas || !filas.length) return mapa;

  for (const f of filas) {
    if (!f.order_id) continue;
    if (!ES_LLAMADA(f.result)) continue;
    if (f.result_date !== hoyLocal) continue;

    const previo = mapa.get(f.order_id);
    if (!previo) {
      mapa.set(f.order_id, {
        intentos: 1,
        ultimoAt: f.created_at,
        ultimoPor: f.operator_id,
        ultimoResult: f.result,
        ultimoMotivo: f.reason?.trim() || null,
      });
      continue;
    }
    previo.intentos += 1;
    // Las filas llegan ordenadas por created_at DESC, pero no se asume: si otra
    // pantalla reusa esto con otro orden, el "último" tiene que seguir siendo el
    // último de verdad.
    if (ms(f.created_at) > ms(previo.ultimoAt)) {
      previo.ultimoAt = f.created_at;
      previo.ultimoPor = f.operator_id;
      previo.ultimoResult = f.result;
      previo.ultimoMotivo = f.reason?.trim() || null;
    }
  }
  return mapa;
}

/**
 * ¿Cambió algo respecto del mapa anterior?
 *
 * `buildWorkQueue` corre en CADA ráfaga de realtime. Si devolviéramos un Map
 * nuevo siempre, el value del OrderContext cambiaría de referencia y
 * re-renderizaría a TODOS sus consumidores (CounterBar, ConfirmarTab, la lista
 * entera) aunque los números fueran idénticos — el "parpadeo de toda la página"
 * que ya se peleó con smartMerge. Comparar es O(n) sobre decenas de entradas.
 */
export function mismaGestion(
  a: Map<string, GestionDelPedido>,
  b: Map<string, GestionDelPedido>,
): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [id, ga] of a) {
    const gb = b.get(id);
    if (!gb) return false;
    if (ga.intentos !== gb.intentos) return false;
    if (ga.ultimoAt !== gb.ultimoAt) return false;
    if (ga.ultimoResult !== gb.ultimoResult) return false;
    if (ga.ultimoPor !== gb.ultimoPor) return false;
    // Sin esto, corregir el motivo de una llamada no se veía hasta recargar: el
    // resto del registro es idéntico y el mapa se descartaba por "sin cambios".
    if (ga.ultimoMotivo !== gb.ultimoMotivo) return false;
  }
  return true;
}

/** Fila de `touchpoints` (Seguimiento). No tiene order_id: la clave es el teléfono. */
export interface FilaToque {
  phone: string;
  /** 'SEG: Envié la guía', 'SEG: No contestó', … */
  action: string;
  operator_id: string | null;
  created_at: string;
}

/**
 * Lo mismo que `buildGestionPorPedido` pero para SEGUIMIENTO, donde la unidad
 * es el TELÉFONO (la tabla `touchpoints` no guarda order_id — mismo criterio que
 * `classifySegOwnershipFromTps` y que `mySegTouchedToday`).
 *
 * Las filas ya vienen filtradas por tienda, por `action ILIKE 'SEG:%'` y por el
 * día de hoy: no se re-filtra acá para no duplicar el criterio en dos lugares.
 * `ultimoResult` guarda el MÉTODO tal como lo eligió la asesora, sin el prefijo
 * `SEG:` — es lo que se muestra ("Envié la guía"), no un código interno.
 */
export function buildGestionSegPorTelefono(
  filas: FilaToque[] | null | undefined,
): Map<string, GestionDelPedido> {
  const mapa = new Map<string, GestionDelPedido>();
  if (!filas || !filas.length) return mapa;

  for (const f of filas) {
    if (!f.phone) continue;
    const metodo = f.action.replace(/^SEG:\s*/i, '').trim();
    const previo = mapa.get(f.phone);
    if (!previo) {
      mapa.set(f.phone, {
        intentos: 1,
        ultimoAt: f.created_at,
        ultimoPor: f.operator_id,
        ultimoResult: metodo,
        // touchpoints no guarda un campo de motivo: el método YA dice qué pasó
        // ("Cliente recoge", "No contestó"). No se inventa nada acá.
        ultimoMotivo: null,
      });
      continue;
    }
    previo.intentos += 1;
    if (ms(f.created_at) > ms(previo.ultimoAt)) {
      previo.ultimoAt = f.created_at;
      previo.ultimoPor = f.operator_id;
      previo.ultimoResult = metodo;
    }
  }
  return mapa;
}

/** Hora "14:35" del último intento, en horario de Bogotá. '' si no parsea. */
export function horaDeIntento(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleTimeString('es-CO', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/Bogota',
  });
}

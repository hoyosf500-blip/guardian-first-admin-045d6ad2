// Utilidades puras para los recordatorios de notas por pedido.
// Zona horaria fija America/Bogota (UTC-5): sirve para CO y EC (mismo offset).
//
// El modelo: cada nota puede tener un `remind_at` opcional (timestamptz).
// La UI usa estas dos utilidades:
//   - `isReminderDue`: ¿ya llegó la hora? → resalta el pedido en la cola.
//   - `summarizeReminder`: texto humano corto para el chip de la nota.

const TZ = 'America/Bogota';

/** Normaliza Date|string|null|undefined → Date válida o null. */
function toDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** true si el recordatorio ya llegó (o pasó). null/inválido → false. */
export function isReminderDue(
  remindAt: Date | string | null | undefined,
  now: Date = new Date(),
): boolean {
  const d = toDate(remindAt);
  if (!d) return false;
  return d.getTime() <= now.getTime();
}

/** Día YYYY-MM-DD en zona Bogota — sirve para comparar "mismo día". */
function bogotaDay(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
}

/**
 * Resumen humano corto:
 *   - "hoy 3:00 pm"  (mismo día Bogota)
 *   - "mañana 10:30 am"  (día siguiente)
 *   - "vie 30 may, 3:00 pm"  (otro día)
 *
 * Devuelve "" para null/inválido para que el caller pueda hacer `&&` sin
 * mostrar un chip vacío.
 */
export function summarizeReminder(
  remindAt: Date | string | null | undefined,
  now: Date = new Date(),
): string {
  const d = toDate(remindAt);
  if (!d) return '';

  // Intl en es-CO devuelve "3:00 p. m." separado por narrow no-break space
  // (U+202F) o regular no-break space (U+00A0). Los normalizamos a espacio
  // común y contraemos "p. m." / "a. m." a "pm" / "am" para mantener corto
  // el chip. Usamos escapes unicode (no caracteres literales) para no chocar
  // con la regla lint no-irregular-whitespace.
  const hora = new Intl.DateTimeFormat('es-CO', {
    timeZone: TZ,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
    .format(d)
    .toLowerCase()
    .replace(/[\u202f\u00a0]/g, ' ')
    .replace(/\s*([ap])\.\s*m\.?/g, ' $1m')
    .trim();

  const today = bogotaDay(now);
  const target = bogotaDay(d);
  if (target === today) return `hoy ${hora}`;

  const tomorrow = bogotaDay(new Date(now.getTime() + 86_400_000));
  if (target === tomorrow) return `mañana ${hora}`;

  // Otro día: "vie 30 may, 3:00 pm". Construimos cada parte por separado para
  // no depender del formato regional ("mié, 27 de may, ..." vs "mié 27 may, ...").
  const dia = new Intl.DateTimeFormat('es-CO', { timeZone: TZ, weekday: 'short' })
    .format(d).replace(/[.,]/g, '').trim();
  const num = new Intl.DateTimeFormat('es-CO', { timeZone: TZ, day: 'numeric' })
    .format(d);
  const mes = new Intl.DateTimeFormat('es-CO', { timeZone: TZ, month: 'short' })
    .format(d).replace(/\./g, '').trim();
  return `${dia} ${num} ${mes}, ${hora}`;
}

/* ─────────────────────────── REAGENDA ───────────────────────────
 * Presets para "el cliente quiere el pedido, pero después".
 *
 * Son DÍAS, no horas: los atajos de NotesPanel (`En 1 h`, `En 3 h`) sirven para
 * volver a intentar una llamada; acá el cliente ya contestó y dio una fecha.
 *
 * `proximo_pago` es el que más se va a usar y por eso existe: en COD LATAM
 * "ahora no tengo plata" casi siempre significa "hasta que cobre", y se cobra el
 * 15 y el último día del mes. Hacer que la asesora calcule esa fecha a mano, en
 * medio de la llamada, es como se pierde el reagendamiento.
 *
 * La hora se fija en el reloj LOCAL de quien reagenda (setHours), igual que
 * QUICK_REMINDERS en NotesPanel: un recordatorio "a las 9" tiene que sonar a las
 * 9 de la asesora, y CO/EC/GT no comparten offset.
 */

export type ReagendaPresetKey = 'manana' | 'en_2_dias' | 'en_3_dias' | 'proximo_pago' | 'en_1_semana';

/** Hora por defecto del recordatorio: arranque del turno, no de madrugada. */
const REAGENDA_HORA = 9;

function aLasNueve(d: Date): Date {
  d.setHours(REAGENDA_HORA, 0, 0, 0);
  return d;
}

/**
 * Próxima fecha de pago quincenal: el 15, o el último día del mes, el que llegue
 * primero DESPUÉS de hoy. Si hoy es 15 o fin de mes, salta al siguiente — un
 * recordatorio para "hoy mismo" no es un reagendamiento.
 */
export function proximaFechaDePago(now: Date = new Date()): Date {
  const d = new Date(now.getTime());
  const dia = d.getDate();
  const finDeMes = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  if (dia < 15) return aLasNueve(new Date(d.getFullYear(), d.getMonth(), 15));
  if (dia < finDeMes) return aLasNueve(new Date(d.getFullYear(), d.getMonth(), finDeMes));
  // Es el último día del mes → el 15 del mes que viene.
  return aLasNueve(new Date(d.getFullYear(), d.getMonth() + 1, 15));
}

function enDias(now: Date, dias: number): Date {
  const d = new Date(now.getTime());
  d.setDate(d.getDate() + dias);
  return aLasNueve(d);
}

export const REAGENDA_PRESETS: Array<{
  key: ReagendaPresetKey;
  label: string;
  build: (now?: Date) => Date;
}> = [
  { key: 'manana', label: 'Mañana', build: (now = new Date()) => enDias(now, 1) },
  { key: 'en_2_dias', label: 'En 2 días', build: (now = new Date()) => enDias(now, 2) },
  { key: 'en_3_dias', label: 'En 3 días', build: (now = new Date()) => enDias(now, 3) },
  { key: 'proximo_pago', label: 'Cuando cobre', build: (now = new Date()) => proximaFechaDePago(now) },
  { key: 'en_1_semana', label: 'En 1 semana', build: (now = new Date()) => enDias(now, 7) },
];

/** Resuelve un preset por clave. Devuelve null si la clave no existe. */
export function buildReagendaDate(key: ReagendaPresetKey, now: Date = new Date()): Date | null {
  const p = REAGENDA_PRESETS.find(x => x.key === key);
  return p ? p.build(now) : null;
}

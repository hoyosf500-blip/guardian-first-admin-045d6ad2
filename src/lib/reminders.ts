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

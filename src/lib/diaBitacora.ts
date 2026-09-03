/**
 * El día operativo de la bitácora, en UTC.
 *
 * ⛔ LA TRAMPA QUE YA APAGÓ EL AUTO-REPARTO PARA SIEMPRE. En este proyecto
 * alguien escribió `new Date(fecha.toLocaleString('en-US', { timeZone }))`
 * para "convertir a Bogotá": eso convierte DOS veces y, después de las 19:00,
 * devuelve MAÑANA. Ver la memoria `dia_bogota_doble_conversion`.
 *
 * Acá no se convierte nada. Bogotá es UTC−5 fijo, sin horario de verano, así
 * que el día `2026-09-03` es exactamente `[2026-09-03T05:00Z, 2026-09-04T05:00Z)`
 * y eso se arma con aritmética de fechas, sin locales de por medio.
 *
 * Bogotá y no la zona de la tienda a propósito: `touchpoints.action_date` ya se
 * escribe con `bogotaToday()`, así que si la bitácora usara otro día, el mismo
 * turno saldría partido distinto en dos pantallas. Un turno, un corte.
 */

const OFFSET_BOGOTA_HORAS = 5;

export interface RangoDia {
  /** Inclusive. */
  desdeIso: string;
  /** Exclusivo. */
  hastaIso: string;
}

/** `ymd` en formato `YYYY-MM-DD` (el que devuelve `bogotaToday`). */
export function rangoDiaBogota(ymd: string): RangoDia | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const [, a, mes, d] = m;
  const inicio = Date.UTC(Number(a), Number(mes) - 1, Number(d), OFFSET_BOGOTA_HORAS, 0, 0, 0);
  if (!Number.isFinite(inicio)) return null;
  return {
    desdeIso: new Date(inicio).toISOString(),
    hastaIso: new Date(inicio + 86_400_000).toISOString(),
  };
}

/** La hora del evento, como la lee una persona en Colombia: `14:53`. */
export function horaBogota(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '--:--';
  const d = new Date(t - OFFSET_BOGOTA_HORAS * 3_600_000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * La HORA del día en Bogotá (0-23) de un instante ISO.
 *
 * Es la cubeta del mapa de calor. Misma aritmética que `horaBogota` —restar el
 * offset y leer en UTC—, nunca `toLocaleString`, que convierte dos veces.
 *
 * `null` si el ISO no se puede leer: una hora inventada movería una gestión de
 * franja y el mapa acusaría a alguien por una hora en la que sí trabajó.
 */
export function horaDelDiaBogota(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t - OFFSET_BOGOTA_HORAS * 3_600_000).getUTCHours();
}

/** Corre `ymd` en `dias` (negativo = hacia atrás). Sin locales. */
export function correrDia(ymd: string, dias: number): string {
  const r = rangoDiaBogota(ymd);
  if (!r) return ymd;
  const base = Date.parse(r.desdeIso) + dias * 86_400_000;
  const d = new Date(base);
  const a = d.getUTCFullYear();
  const mes = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${a}-${mes}-${dd}`;
}

// Ventana de alertas de inactividad de la operadora.
// Horario laboral FIJO 9:00–17:00 (hora Bogotá), almuerzo 12:30–13:30 excluido.
// CO y EC comparten el mismo wall-clock (ambos UTC-5, sin DST) → una sola TZ.
//
// Funciones PURAS (reciben Date, no leen el reloj) para poder testearlas con
// fechas fijas. Trabajan con SEGUNDOS-del-día (no minutos) para que el umbral
// de 5 min sea exacto y no varíe ±1 min según la fracción de segundo.

export const BOGOTA_TZ = 'America/Bogota';
export const WORK_START_SEC = 9 * 3600;             // 09:00:00
export const WORK_END_SEC = 17 * 3600;              // 17:00:00
export const LUNCH_START_SEC = (12 * 60 + 30) * 60; // 12:30:00
export const LUNCH_END_SEC = (13 * 60 + 30) * 60;   // 13:30:00
export const IDLE_THRESHOLD_SECONDS = 5 * 60;       // 5 minutos sin actividad

/**
 * Horario laboral (en SEGUNDOS-del-día Bogotá) contra el que se miden las
 * advertencias de inactividad. Configurable POR TIENDA (migration
 * 20260703210000: columnas work_start_min/work_end_min/lunch_start_min/
 * lunch_end_min en `stores`). Antes era fijo 9–17, lo que inflaba el "tiempo
 * perdido" de operadoras que trabajan de noche.
 */
export interface WorkSchedule {
  workStartSec: number;
  workEndSec: number;
  lunchStartSec: number;
  lunchEndSec: number;
}

/** Horario histórico 9–17 con almuerzo 12:30–13:30 — default y valor de las
 *  columnas nuevas de `stores`. Los call-sites sin tienda usan este. */
export const DEFAULT_SCHEDULE: WorkSchedule = {
  workStartSec: WORK_START_SEC,
  workEndSec: WORK_END_SEC,
  lunchStartSec: LUNCH_START_SEC,
  lunchEndSec: LUNCH_END_SEC,
};

/** Convierte los minutos-del-día de `stores` a segundos para las funciones puras. */
export function scheduleFromMinutes(m: {
  work_start_min: number;
  work_end_min: number;
  lunch_start_min: number;
  lunch_end_min: number;
}): WorkSchedule {
  return {
    workStartSec: m.work_start_min * 60,
    workEndSec: m.work_end_min * 60,
    lunchStartSec: m.lunch_start_min * 60,
    lunchEndSec: m.lunch_end_min * 60,
  };
}

const _fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: BOGOTA_TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

function parts(date: Date): { dateKey: string; seconds: number } {
  const p = _fmt.formatToParts(date);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  let hh = parseInt(get('hour'), 10);
  if (hh === 24) hh = 0; // algunos runtimes devuelven '24' para medianoche
  const mm = parseInt(get('minute'), 10);
  const ss = parseInt(get('second'), 10);
  return { dateKey: `${get('year')}-${get('month')}-${get('day')}`, seconds: hh * 3600 + mm * 60 + ss };
}

/** Fecha calendario Bogotá 'YYYY-MM-DD' de un instante. */
export function bogotaDateKey(date: Date): string {
  return parts(date).dateKey;
}

/** Segundo-del-día (0–86399) en hora Bogotá. */
export function bogotaSecondsOfDay(date: Date): number {
  return parts(date).seconds;
}

/** Minuto-del-día (0–1439) en hora Bogotá — helper de conveniencia. */
export function bogotaMinutesOfDay(date: Date): number {
  return Math.floor(parts(date).seconds / 60);
}

/** ¿`date` cae dentro del horario laboral de la tienda y FUERA del almuerzo?
 *  `schedule` default = 9–17 / 12:30–13:30 (histórico) para call-sites sin tienda. */
export function isWithinAlertWindow(date: Date, schedule: WorkSchedule = DEFAULT_SCHEDULE): boolean {
  const s = parts(date).seconds;
  if (s < schedule.workStartSec || s >= schedule.workEndSec) return false;
  if (s >= schedule.lunchStartSec && s < schedule.lunchEndSec) return false;
  return true;
}

/**
 * Segundos de tiempo LABORAL perdidos entre `last` y `now`, contando solo el
 * solapamiento con el horario de la tienda y EXCLUYENDO su almuerzo. Si `last` y
 * `now` caen en días Bogotá distintos devuelve 0 (eso no es inactividad de
 * jornada, es ausencia / arranque de un nuevo día — no la confrontamos).
 * `schedule` default = 9–17 / 12:30–13:30 (histórico).
 */
export function workingSecondsLost(last: Date, now: Date, schedule: WorkSchedule = DEFAULT_SCHEDULE): number {
  const a = parts(last);
  const b = parts(now);
  if (a.dateKey !== b.dateKey) return 0;
  const lo = Math.max(a.seconds, schedule.workStartSec);
  const hi = Math.min(b.seconds, schedule.workEndSec);
  if (hi <= lo) return 0;
  let lost = hi - lo;
  // restar el solapamiento con el almuerzo
  const lunch = Math.max(0, Math.min(hi, schedule.lunchEndSec) - Math.max(lo, schedule.lunchStartSec));
  lost -= lunch;
  return Math.max(0, lost);
}

/** "12 minutos" / "1 minuto" / "45 segundos" / "6 min 30 s". */
export function formatLostTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m <= 0) return `${s} segundos`;
  if (s === 0) return `${m} ${m === 1 ? 'minuto' : 'minutos'}`;
  return `${m} min ${s} s`;
}

// huecosGestion — "¿hace cuánto que un asesor no MARCA un pedido?"
//
// Nació de un reclamo del dueño (25-ago-2026): una asesora tuvo huecos de 20 y
// 30 min sin gestionar nada y NO saltó ninguna alerta, porque la alerta vieja
// (`useInactivityGuard`) y la columna "Sin trabajar" miran el MOUSE/TECLADO, no
// si marcó pedidos. Mover el mouse alcanzaba para figurar "activa".
//
// Esto mide lo correcto: minutos LABORALES desde la última gestión real
// (conf/canc/noresp en `order_results`). Reutiliza `workingSecondsLost` para
// descontar almuerzo y fuera de horario — un hueco de las 12:40 no cuenta, está
// almorzando.
//
// PURO y testeable. Lo usan dos lados: el aviso SUAVE a la operadora
// (`useSinGestionNudge`) y el tablero del dueño (Productividad → Jornada).
//
// ⚠️ El filo, dicho por mí al dueño y aceptado por él: una llamada larga de
// verdad TAMBIÉN se ve como un hueco (no hay clic mientras se habla). Por eso el
// umbral es alto (20 min) y el aviso NO bloquea ni cuenta como falta — es un
// recordatorio, no un castigo. El tablero se lo muestra al dueño para que él
// decida, no para acusar solo con el número.

import { workingSecondsLost, isWithinAlertWindow, DEFAULT_SCHEDULE, type WorkSchedule } from './inactivityWindow';

/** 20 min laborales sin marcar un pedido → recordatorio. Alto a propósito: una
 *  llamada larga legítima no debería dispararlo casi nunca. */
export const UMBRAL_SIN_GESTION_MIN = 20;

/**
 * Minutos LABORALES desde la última gestión (excluye almuerzo y fuera de
 * horario). null si nunca marcó. Si la última marca fue en OTRO día Bogotá,
 * `workingSecondsLost` devuelve 0 → 0 min (no es un hueco, es un día nuevo).
 */
export function minutosSinGestion(
  lastMarkMs: number | null,
  nowMs: number,
  schedule: WorkSchedule = DEFAULT_SCHEDULE,
): number | null {
  if (lastMarkMs == null) return null;
  return Math.floor(workingSecondsLost(new Date(lastMarkMs), new Date(nowMs), schedule) / 60);
}

/**
 * El mayor hueco LABORAL entre dos gestiones consecutivas del día (en minutos).
 * null si hubo menos de 2 gestiones. Para el tablero del dueño: "el peor rato
 * que estuvo sin marcar nada hoy".
 */
export function mayorHuecoMin(
  marksMs: number[],
  schedule: WorkSchedule = DEFAULT_SCHEDULE,
): number | null {
  if (!marksMs || marksMs.length < 2) return null;
  const s = [...marksMs].sort((a, b) => a - b);
  let max = 0;
  for (let i = 1; i < s.length; i++) {
    max = Math.max(max, workingSecondsLost(new Date(s[i - 1]), new Date(s[i]), schedule));
  }
  return Math.floor(max / 60);
}

/**
 * El mayor hueco LABORAL entre BLOQUES de trabajo consecutivos (en minutos).
 *
 * Para el tablero del dueño. `operator_worked_blocks` agrupa las gestiones en
 * bloques con corte de 15 min, así que el hueco entre `end` de uno y `start`
 * del siguiente ES un rato ≥15 min sin marcar nada — justo lo que el dueño
 * quiere ver. Se descuenta almuerzo y fuera de horario. null si <2 bloques.
 */
export function mayorHuecoEntreBloques(
  bloques: Array<{ startMs: number; endMs: number }>,
  schedule: WorkSchedule = DEFAULT_SCHEDULE,
): number | null {
  if (!bloques || bloques.length < 2) return null;
  const s = [...bloques].sort((a, b) => a.startMs - b.startMs);
  let max = 0;
  for (let i = 1; i < s.length; i++) {
    max = Math.max(max, workingSecondsLost(new Date(s[i - 1].endMs), new Date(s[i].startMs), schedule));
  }
  return Math.floor(max / 60);
}

/**
 * ¿Hay que darle el aviso suave al asesor?
 *
 * Condiciones (todas): hay trabajo pendiente, es horario laboral, pasaron
 * `umbralMin` minutos laborales sin marcar, y no se le avisó hace menos de
 * `umbralMin` (para no repetirlo cada minuto). Nunca avisa si nunca marcó
 * (lastMarkMs null) — de eso se encarga el aviso de "nadie tocó la cola", no
 * este.
 */
export function debeAvisarSinGestion(args: {
  lastMarkMs: number | null;
  nowMs: number;
  hayTrabajo: boolean;
  schedule?: WorkSchedule;
  umbralMin?: number;
  ultimoAvisoMs?: number | null;
}): boolean {
  const umbral = args.umbralMin ?? UMBRAL_SIN_GESTION_MIN;
  if (!args.hayTrabajo) return false;
  if (!isWithinAlertWindow(new Date(args.nowMs), args.schedule)) return false;
  const min = minutosSinGestion(args.lastMarkMs, args.nowMs, args.schedule);
  if (min == null || min < umbral) return false;
  if (args.ultimoAvisoMs != null && (args.nowMs - args.ultimoAvisoMs) / 60000 < umbral) return false;
  return true;
}

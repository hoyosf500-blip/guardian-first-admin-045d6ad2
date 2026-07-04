// Señales anti-"mama gallo": medir PRODUCCIÓN real, no presencia.
//
// El problema (dueño 2026-07-04): una operadora puede parecer ocupada (mouse
// vivo, "Trabajó Xh") pero producir poquísimo. Estas funciones puras cruzan el
// TRABAJO REAL (worked_seconds por evidencia + gestiones) contra el tiempo, para
// que "presente pero improductiva" salte a la vista.
//
// Todas country-agnostic, sin red, sin DOM — testeables con Vitest.

/** Debajo de este trabajo (30 min) NO juzgamos el ritmo: muy poca muestra →
 *  evita falsos "está lenta" a las 9 a. m. con 3 pedidos. */
export const MIN_WORK_SECONDS_TO_JUDGE = 30 * 60;
/** Umbral genérico de ritmo (gestiones/hora). Calibrable. */
export const MIN_GESTIONES_POR_HORA = 10;
/** Umbral del 🔴 sobre INTENTOS por hora (esfuerzo de marcado). Decisión del
 *  dueño 2026-07-04: el rojo se pinta sobre el esfuerzo (todas las marcadas,
 *  incl. "no contestó" = llamadas en frío), NO sobre clientes cerrados — así un
 *  día de muchos no-contesta no la castiga; solo cae la que casi no marca. */
export const MIN_INTENTOS_POR_HORA = 10;
/** El mouse tiene que estar "alto" (2h+) para que la bandera mouse-vivo aplique. */
export const UMBRAL_ACTIVA_FLAG_SEG = 2 * 3600;
/** Tiempo/cliente meta = inverso exacto del umbral (10/h ⟺ 6 min por pedido). */
export const TIEMPO_CLIENTE_META_SEG = 3600 / MIN_GESTIONES_POR_HORA;

function num(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Pedidos gestionados por HORA TRABAJADA (por evidencia). La bala de plata:
 * cierra el menear-el-mouse, el espaciar-acciones y la lentitud de una sola vez.
 * null si falta dato o si trabajó < 30 min (muestra insuficiente).
 */
export function gestionesPorHora(
  atendidos: number | null | undefined,
  workedSeconds: number | null | undefined,
): number | null {
  const a = num(atendidos);
  const w = num(workedSeconds);
  if (a == null || w == null) return null;
  if (w < MIN_WORK_SECONDS_TO_JUDGE) return null;
  return a / (w / 3600);
}

/**
 * Tiempo real por pedido gestionado = worked_seconds ÷ gestiones (segundos).
 * Basado en TRABAJO por evidencia, NO en el mouse (que es inflable). Inverso de
 * gestionesPorHora. null si no hay gestiones.
 */
export function tiempoPorClienteSeg(
  workedSeconds: number | null | undefined,
  atendidos: number | null | undefined,
): number | null {
  const w = num(workedSeconds);
  const a = num(atendidos);
  if (w == null || a == null || a <= 0) return null;
  return Math.max(0, w) / a;
}

/**
 * Densidad del turno = worked ÷ (última señal − primera señal), 0..1. "De un
 * turno de 8h, trabajó 4h20 = 54%". Deja ver el tiempo muerto de la jornada.
 */
export function densidadTurno(
  workedSeconds: number | null | undefined,
  turnoSpanSeconds: number | null | undefined,
): number | null {
  const w = num(workedSeconds);
  const s = num(turnoSpanSeconds);
  if (w == null || s == null || s <= 0) return null;
  return Math.min(1, Math.max(0, w / s));
}

export interface MouseVivoInput {
  /** active_seconds del heartbeat (el número inflable). */
  activeSeconds?: number | null;
  /** total_atendidos (gestiones reales). */
  atendidos?: number | null;
  /** Umbral de gestiones/hora-de-mouse (default MIN_GESTIONES_POR_HORA). */
  umbralGestionesHora?: number;
}

/**
 * Bandera "mouse vivo, no produce": el heartbeat dice muy activa (2h+) pero
 * gestiona poco POR HORA DE MOUSE. Es la firma de menear el mouse para figurar.
 * Ojo: se mide sobre las horas de MOUSE (active), no las trabajadas — porque el
 * mouse es justo lo que se está inflando.
 */
export function esMouseVivoNoProduce(input: MouseVivoInput): boolean {
  const active = num(input.activeSeconds);
  const atendidos = num(input.atendidos);
  if (active == null || atendidos == null) return false;
  if (active < UMBRAL_ACTIVA_FLAG_SEG) return false;
  const umbral = input.umbralGestionesHora ?? MIN_GESTIONES_POR_HORA;
  return atendidos / (active / 3600) < umbral;
}

/** ¿Hay trabajo suficiente (30 min+) para juzgar el ritmo sin falso positivo? */
export function ritmoEsJuzgable(workedSeconds: number | null | undefined): boolean {
  const w = num(workedSeconds);
  return w != null && w >= MIN_WORK_SECONDS_TO_JUDGE;
}

/** Tono semántico del ritmo vs el umbral: rojo debajo, ámbar cerca, verde ok. */
export function ritmoTone(
  gestHora: number | null,
  umbral: number = MIN_GESTIONES_POR_HORA,
): 'muted' | 'danger' | 'warning' | 'success' {
  if (gestHora == null) return 'muted';
  if (gestHora < umbral) return 'danger';
  if (gestHora < umbral * 1.5) return 'warning';
  return 'success';
}

/**
 * "Estoy en otra cosa" — que el asesor pueda DECIRLE al sistema en qué se le
 * fue el tiempo, en vez de que el sistema lo adivine.
 *
 * ── De dónde sale ───────────────────────────────────────────────────────────
 * 27-ago-2026. El dueño le escribió a un asesor: *"llevás una hora sin marcar
 * una acción en el CRM, ¿pasa algo?"*. La respuesta: *"estoy revisando las
 * guías de retiro en agencia de Servientrega… estoy intentando llamarles
 * también"*. Estaba trabajando. Guardian no tenía forma de saberlo: el guard de
 * inactividad mide `mousemove`/`keydown` **sobre la ventana de Guardian**, así
 * que una hora en el sitio de la transportadora, o al teléfono con el celular
 * en la mano, se ve exactamente igual que una hora sin hacer nada.
 *
 * ── La regla ────────────────────────────────────────────────────────────────
 * El sistema no puede ver lo que pasa fuera de la pantalla. Cuando no puede
 * ver, tiene dos opciones: **acusar** (lo que hacía) o **preguntar**. Un hueco
 * sin explicación sigue siendo un hueco — la pausa no lo borra, lo NOMBRA. El
 * dueño pasa de "estuvo una hora quieto" a "estuvo una hora en la agencia", que
 * es un dato con el que sí se puede decidir algo.
 *
 * ⛔ Y por eso tiene tope: una pausa sin límite dejaría de ser una explicación
 * para volverse un escondite. A los `PAUSA_MAX_MS` se cierra sola.
 */

export interface MotivoPausa {
  /** Lo que se guarda en la base. No cambia: es la clave del histórico. */
  value: string;
  /** Lo que ve el asesor. Este sí se puede cambiar. */
  label: string;
}

/**
 * Los motivos salen del caso REAL, no de una lluvia de ideas: son las cosas que
 * el equipo de Ecuador hace fuera de Guardian y que hoy se leen como pereza.
 * "Otro" existe para no forzar a mentir con el motivo más parecido — un motivo
 * inventado ensucia el dato más que un "otro" honesto con su nota.
 */
export const MOTIVOS_PAUSA: readonly MotivoPausa[] = [
  { value: 'agencia', label: 'Revisando guías en la agencia' },
  { value: 'transportadora', label: 'Hablando con la transportadora' },
  { value: 'llamada', label: 'En una llamada larga' },
  { value: 'almuerzo', label: 'Almuerzo / descanso' },
  { value: 'otro', label: 'Otra cosa' },
];

/** Tope duro. Pasado esto la pausa deja de valer aunque nadie la haya cerrado:
 *  el asesor pudo cerrar la pestaña, irse, o simplemente olvidarse. */
export const PAUSA_MAX_MS = 45 * 60 * 1000;

export interface Pausa {
  id?: string;
  motivo: string;
  nota?: string | null;
  /** ms del epoch. */
  inicio: number;
  /** ms del epoch, o null si sigue abierta. */
  fin?: number | null;
}

/**
 * ¿Esta pausa cubre AHORA?
 *
 * Cerrada → no. Abierta pero pasada del tope → tampoco: se la trata como
 * vencida sin necesidad de que nadie la cierre, porque el caso más probable de
 * una pausa de 3 horas no es una reunión de 3 horas, es que se olvidaron de
 * apagarla.
 */
export function pausaVigente(p: Pausa | null | undefined, nowMs: number): boolean {
  if (!p) return false;
  if (p.fin != null) return false;
  if (!Number.isFinite(p.inicio)) return false;
  return nowMs - p.inicio < PAUSA_MAX_MS;
}

/** Minutos transcurridos, para mostrarlos mientras corre. Nunca negativo. */
export function minutosDePausa(p: Pausa | null | undefined, nowMs: number): number {
  if (!p || !Number.isFinite(p.inicio)) return 0;
  const hasta = p.fin ?? nowMs;
  return Math.max(0, Math.floor((hasta - p.inicio) / 60_000));
}

/** El texto que se le muestra al asesor y, con el mismo `value`, al dueño en
 *  el panel. Un motivo desconocido (guardado por una versión más nueva) se
 *  muestra crudo en vez de caer a "Otra cosa": inventar la etiqueta escondería
 *  que hay un motivo que esta versión no conoce. */
export function etiquetaMotivo(value: string | null | undefined): string {
  const v = String(value || '').trim();
  if (!v) return 'Sin motivo';
  return MOTIVOS_PAUSA.find((m) => m.value === v)?.label ?? v;
}

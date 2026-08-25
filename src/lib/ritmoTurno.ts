// ritmoTurno — el velocímetro del turno del asesor. Lo APURA a ir rápido.
//
// Pedido del dueño (25-ago-2026): "quiero ser estricto con el trabajo, que el
// sistema afane al asesor a que sea rápido". En vez de trabar por calidad de
// dirección (poco confiable sin Google), se le muestra EN VIVO su ritmo y si a
// ese paso termina la cola — el atraso deja de ser invisible.
//
// PURO y testeable. La UI (VelocimetroTurno) solo dibuja lo que esto calcula.
//
// ⚠️ Guardrail honesto: apurar puede empujar a confirmar sin mirar → devoluciones.
// La tasa de devolución por asesor (Causa raíz) es el contrapeso que lo vigila
// por detrás. Este velocímetro presiona el ritmo; esa tasa cuida la calidad.

/** Meta de ritmo por defecto (pedidos gestionados por hora). Regla del dueño
 *  (25-ago-2026): MÁXIMO 3 minutos por pedido → 60/3 = **20 por hora**. Por debajo
 *  de eso el velocímetro se pinta rojo y grita "Acelerá". Es la vara estricta que
 *  pidió: que el colaborador sienta la presión del reloj. */
export const RITMO_META_POR_HORA = 20;

/** Antes de este tiempo trabajado NO se calcula ritmo: con 3 gestiones en 4 min
 *  daría "45/hora", un número fantasioso que desinfla la presión después. */
export const RITMO_MIN_MINUTOS = 10;

export interface Ritmo {
  /** Pedidos gestionados por hora. null si todavía es muy temprano para medir. */
  porHora: number | null;
  /** Minutos estimados para vaciar la cola al ritmo actual. null si no medible. */
  etaMin: number | null;
  /** Va por debajo de la meta → se muestra en rojo, es el "apurate". */
  vaLento: boolean;
  /** Horas trabajadas desde la primera gestión (para mostrar contexto). */
  horasTrabajadas: number | null;
}

const VACIO: Ritmo = { porHora: null, etaMin: null, vaLento: false, horasTrabajadas: null };

/**
 * Calcula el ritmo del turno.
 * - `gestionados`: cuántos marcó HOY el asesor (en vivo).
 * - `desdeMs`: instante de su PRIMERA gestión de hoy (null si aún no marcó).
 * - `faltan`: pendientes por gestionar (para la proyección de fin).
 */
export function calcularRitmo(args: {
  gestionados: number;
  desdeMs: number | null;
  nowMs: number;
  faltan: number;
  metaPorHora?: number;
  minMinutos?: number;
}): Ritmo {
  const meta = args.metaPorHora ?? RITMO_META_POR_HORA;
  const minMin = args.minMinutos ?? RITMO_MIN_MINUTOS;
  if (args.desdeMs == null) return VACIO;
  const elapsedMin = (args.nowMs - args.desdeMs) / 60000;
  const horasTrabajadas = elapsedMin > 0 ? elapsedMin / 60 : 0;
  if (elapsedMin < minMin || args.gestionados <= 0) {
    return { ...VACIO, horasTrabajadas };
  }
  const porHora = args.gestionados / horasTrabajadas;
  const etaMin = porHora > 0 && args.faltan > 0 ? (args.faltan / porHora) * 60 : (args.faltan <= 0 ? 0 : null);
  return {
    porHora: Math.round(porHora * 10) / 10,
    etaMin: etaMin == null ? null : Math.round(etaMin),
    vaLento: porHora < meta,
    horasTrabajadas,
  };
}

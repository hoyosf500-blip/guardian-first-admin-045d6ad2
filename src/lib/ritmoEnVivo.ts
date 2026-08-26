// ritmoEnVivo — la vara ESTRICTA del dueño para el panel "Ahora mismo".
//
// Pedido del dueño (26-ago-2026): "necesito ponerme estricto — quiero ver EN VIVO
// quién va lento o rápido, quién entró tarde y quién no ha gestionado, sin
// preguntar". Eligió la vara MÁS estricta: óptimo 25/hora, rojo por debajo de 15.
//
// ⚠️ A PROPÓSITO es MÁS dura que la del velocímetro del asesor (ritmoTurno.ts,
// 20/12): esa es la que VE la asesora — más suave, para no tener el rojo siempre
// prendido y desmotivar. Ésta es la que ve el DUEÑO — su listón es más alto. NO es
// un bug ni una definición olvidada: son dos audiencias, dos varas, a pedido suyo.
//
// PURO y testeable. La UI (AdvisorCard) solo dibuja lo que esto calcula.

import { calcularRitmo, type Ritmo } from './ritmoTurno';

/** ÓPTIMO del dueño: pedidos/hora que se muestran como meta (≈2,4 min/pedido). */
export const RITMO_VIVO_META = 25;
/** ALERTA del dueño: por debajo de esto (4 min/pedido) se pinta rojo. */
export const RITMO_VIVO_ALERTA = 15;

/** Ritmo en vivo con la vara estricta. Reusa calcularRitmo (ya probado) para no
 *  tener DOS matemáticas de ritmo: acá solo se le fijan los umbrales del dueño. */
export function ritmoVivo(args: {
  gestionados: number;
  desdeMs: number | null;
  nowMs: number;
  faltan?: number;
}): Ritmo {
  return calcularRitmo({
    gestionados: args.gestionados,
    desdeMs: args.desdeMs,
    nowMs: args.nowMs,
    faltan: args.faltan ?? 0,
    metaPorHora: RITMO_VIVO_META,
    alertaPorHora: RITMO_VIVO_ALERTA,
  });
}

/** Reparte marcas (por su HORA Bogotá 0-23) en cubetas por hora. Descarta horas
 *  fuera de rango (dato sucio) en vez de reventar. */
export function repartirPorHora(horasBogota: number[]): { hora: number; cantidad: number }[] {
  const m = new Map<number, number>();
  for (const h of horasBogota) {
    if (!Number.isInteger(h) || h < 0 || h > 23) continue;
    m.set(h, (m.get(h) ?? 0) + 1);
  }
  return [...m.entries()]
    .map(([hora, cantidad]) => ({ hora, cantidad }))
    .sort((a, b) => a.hora - b.hora);
}

/** Serie DENSA de horas (rellena con 0 las horas sin gestión) para dibujar las
 *  barritas de todo el turno — una hora vacía es información, no un hueco. */
export function serieHoraria(
  buckets: { hora: number; cantidad: number }[],
  desdeHora: number,
  hastaHora: number,
): { hora: number; cantidad: number }[] {
  const m = new Map(buckets.map((b) => [b.hora, b.cantidad]));
  const out: { hora: number; cantidad: number }[] = [];
  const desde = Math.max(0, Math.min(23, Math.floor(desdeHora)));
  const hasta = Math.max(desde, Math.min(23, Math.floor(hastaHora)));
  for (let h = desde; h <= hasta; h++) out.push({ hora: h, cantidad: m.get(h) ?? 0 });
  return out;
}

/** ¿Entró tarde? primera señal del día (segundos del día Bogotá) vs el inicio del
 *  horario de la tienda + una gracia. Sin señal ⇒ false (no acusa sin dato). */
export function entroTarde(
  primeraSenalSecDelDia: number | null,
  inicioHorarioSec: number,
  graciaSec = 600,
): boolean {
  if (primeraSenalSecDelDia == null || !Number.isFinite(primeraSenalSecDelDia)) return false;
  return primeraSenalSecDelDia > inicioHorarioSec + graciaSec;
}

// rachaRapida — la "racha" de pedidos gestionados rápido, para enganchar al asesor
// como un juego: "12 seguidos en menos de 3 min 🔥". Se rompe si se demora.
//
// Pedido del dueño (25-ago-2026): presión psicológica que empuje a no aflojar el
// ritmo. La racha premia el ritmo SOSTENIDO, no un pico suelto.
//
// Cómo se mide SIN tocar CallView (zona frágil): el tiempo de un pedido ≈ el hueco
// entre dos marcas seguidas (se trabaja de a uno). Cada 'guardian:mi-gestion'
// (que dispara markResult) trae un instante; si el hueco contra la marca anterior
// es ≤ 3 min, ese pedido fue rápido y la racha sube; si no, se reinicia.
//
// PURO y testeable. El hook solo guarda estado y el reloj.

/** 3 minutos: el óptimo por pedido (mismo umbral que el reloj del pedido). */
export const RACHA_UMBRAL_SEG = 180;

/**
 * Nueva racha tras una marca.
 * - `lastMarkMs` null (primera marca del turno) → arranca en 1.
 * - hueco ≤ umbral → +1 (fue rápido).
 * - hueco > umbral → se reinicia a 1 (este pedido rompe la racha, pero él mismo
 *   inicia una nueva).
 */
export function siguienteRacha(
  rachaActual: number,
  lastMarkMs: number | null,
  nowMs: number,
  umbralSeg: number = RACHA_UMBRAL_SEG,
): number {
  if (lastMarkMs == null) return 1;
  const gapSeg = (nowMs - lastMarkMs) / 1000;
  if (gapSeg < 0) return 1; // reloj corrido: no se premia ni se castiga raro
  return gapSeg <= umbralSeg ? rachaActual + 1 : 1;
}

/** Chispa de hito para celebrar rachas redondas (10, 20, 30…). '' si no toca. */
export function hitoDeRacha(racha: number): string {
  if (racha > 0 && racha % 10 === 0) return `¡${racha} seguidos! 🔥`;
  return '';
}

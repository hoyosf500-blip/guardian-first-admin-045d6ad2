// tiempoEnPedido — cuánto lleva el asesor en el pedido que tiene abierto.
// Apura a no demorarse en cada uno. Puro y testeable; el componente self-contained
// lleva el reloj.

/** A los 5 min en un mismo pedido se pone en rojo con "dale". Un no-contesta
 *  toma ~1 min y una venta real 3-4; 5 min ya es demorarse. NO bloquea. */
export const UMBRAL_PEDIDO_SEG = 300;

/** "2:34" / "0:07" / "12:03" a partir de segundos. */
export function formatMMSS(segundos: number): string {
  const s = Math.max(0, Math.floor(segundos));
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${m}:${String(ss).padStart(2, '0')}`;
}

/** ¿Ya se pasó del umbral (se está demorando)? */
export function seDemora(segundos: number, umbral: number = UMBRAL_PEDIDO_SEG): boolean {
  return segundos >= umbral;
}

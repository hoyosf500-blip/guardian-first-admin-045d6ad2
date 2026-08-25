// tiempoEnPedido — cuánto lleva el asesor en el pedido que tiene abierto.
// Apura a no demorarse en cada uno. Puro y testeable; el componente self-contained
// lleva el reloj.

// DOS umbrales (regla del dueño 25-ago-2026): el ÓPTIMO son 3 min por pedido, pero
// la ALERTA roja recién a los 5 — así el 3 se muestra como meta a alcanzar pero el
// rojo no grita todo el tiempo (si vive en rojo, deja de presionar). Verde <3,
// ámbar 3-5 (te pasaste del óptimo), rojo 5+ (te estás demorando). Nada BLOQUEA.

/** ÓPTIMO: pasado esto (3 min) el reloj se pone ámbar — "apurá, ya te pasaste". */
export const UMBRAL_OPTIMO_SEG = 180;

/** ALERTA: pasado esto (5 min) el reloj se pone rojo con "dale". */
export const UMBRAL_PEDIDO_SEG = 300;

/** "2:34" / "0:07" / "12:03" a partir de segundos. */
export function formatMMSS(segundos: number): string {
  const s = Math.max(0, Math.floor(segundos));
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${m}:${String(ss).padStart(2, '0')}`;
}

/** ¿Ya se pasó del umbral de ALERTA (5 min → rojo)? */
export function seDemora(segundos: number, umbral: number = UMBRAL_PEDIDO_SEG): boolean {
  return segundos >= umbral;
}

/** ¿Ya se pasó del ÓPTIMO (3 min → ámbar) pero todavía no de la alerta? */
export function sobreOptimo(segundos: number, umbral: number = UMBRAL_OPTIMO_SEG): boolean {
  return segundos >= umbral;
}

/** Nivel visual del reloj: 'ok' (<3 min) · 'optimo_pasado' (3-5) · 'alerta' (5+). */
export function nivelTiempo(segundos: number): 'ok' | 'optimo_pasado' | 'alerta' {
  if (seDemora(segundos)) return 'alerta';
  if (sobreOptimo(segundos)) return 'optimo_pasado';
  return 'ok';
}

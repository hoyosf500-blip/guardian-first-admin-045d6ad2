// ritmoSeguimiento — la vara de SEGUIMIENTO, que no es la de las llamadas.
//
// ── Por qué existe (28-ago-2026) ────────────────────────────────────────────
// El mismo día que Productividad empezó a mostrar el trabajo de Seguimiento,
// apareció el filo: ROBERTO MORAN hizo **51 gestiones de agencia** y su tarjeta
// decía *"3,7 por hora · lento"*. No iba lento — se le estaba aplicando la vara
// de una llamada telefónica (25/hora) a un trabajo que es leer la tarjeta, tocar
// un botón y confirmar.
//
// El dueño lo resolvió en una frase: *"como es presionar un botón tienen que
// trabajar más rápido"*. Y eligió la vara más exigente de las que se le
// ofrecieron: **óptimo 40/hora (1,5 min por pedido), rojo bajo 25/hora**.
//
// ⚠️ AHORA HAY TRES VARAS Y LAS TRES SON A PROPÓSITO. No es una definición
// olvidada ni un refactor pendiente: son tres trabajos y tres audiencias.
//
//   | vara                       | qué mide                     | óptimo | rojo |
//   |----------------------------|------------------------------|--------|------|
//   | ritmoTurno.ts              | Confirmar, la que VE el asesor|  20   |  12  |
//   | ritmoEnVivo.ts             | Confirmar, la que ve el DUEÑO |  25   |  15  |
//   | ritmoSeguimiento.ts (esta) | Seguimiento y Novedades       |  40   |  25  |
//
// La de Confirmar es telefónica: marcar, esperar el tono, hablar. Ésta no.
// Meterlas en un solo número volvería a producir el "3,7 · lento" de Roberto.
//
// PURO y testeable. La UI (AdvisorCard) solo dibuja lo que esto calcula.

import { calcularRitmo, type Ritmo } from './ritmoTurno';

/** ÓPTIMO de Seguimiento: gestiones/hora que se muestran como meta (1,5 min c/u). */
export const RITMO_SEG_META = 40;
/** ALERTA de Seguimiento: por debajo de esto (2,4 min c/u) se pinta rojo. */
export const RITMO_SEG_ALERTA = 25;

/**
 * Ritmo de Seguimiento. Reusa `calcularRitmo` (ya probado) para no tener una
 * cuarta matemática de ritmo: acá solo se le fijan los umbrales de este carril.
 *
 * ⛔ `desdeMs` tiene que ser la primera marca **de Seguimiento**, no la primera
 * señal del día. Medir 51 gestiones de agencia contra el reloj que arrancó
 * cuando la persona abrió Confirmar a las 8 a. m. inventa un número: es
 * exactamente el error que este archivo viene a arreglar, cometido de nuevo.
 */
export function ritmoSeguimiento(args: {
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
    metaPorHora: RITMO_SEG_META,
    alertaPorHora: RITMO_SEG_ALERTA,
  });
}

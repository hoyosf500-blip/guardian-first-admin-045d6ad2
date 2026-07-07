/**
 * Tasas de entrega/devolución "maduras" — mismo principio que la tasa de
 * confirmación madura de Reportes Diarios.
 *
 * Problema: las RPC de logística calculan `tasa_entrega = entregados ÷ total`,
 * metiendo en el denominador pedidos que TODAVÍA no concluyen (en tránsito,
 * pendientes, novedades). En rangos recientes eso hunde la tasa artificialmente
 * (medio cohorte sigue en camino).
 *
 * Tasa madura = `entregados ÷ (entregados + devueltos)` — solo sobre pedidos que
 * llegaron a un desenlace logístico FINAL. `% concluido = (entregados+devueltos)
 * ÷ total` indica qué tan maduro está el cohorte; por debajo del umbral la tasa
 * no es concluyente y se muestra en gris.
 *
 * COUNTRY-AGNOSTIC: solo usa los dos buckets terminales (entregado/devuelto), así
 * que los estados intermedios que EC inventa (EN RUTA A…, INGRESANDO…, ASIGNADO…,
 * PARA RETIRO EN AGENCIA…) quedan EXCLUIDOS del cálculo automáticamente — no hay
 * que enumerarlos. Sirve igual para CO y EC sin tocar nada por país.
 */

/** % concluido mínimo para tratar la tasa de entrega como concluyente. */
export const DELIVERY_MATURITY_THRESHOLD = 70;

/** Mínimo de pedidos RESUELTOS (entregados+devueltos) para que una tasa sea
 *  estadísticamente confiable. Mismo umbral que carrierRecommendations
 *  (MIN_RESUELTOS_RANK). Debajo de esto, una ciudad/carrier/producto con 1-4
 *  concluidos puede dar 0%/100% y NO debe pintarse con confianza. */
export const MIN_RESUELTOS_CONFIABLE = 5;

/** true cuando la tasa madura NO es confiable: cohorte inmaduro (pocos
 *  concluidos vs total) O muestra chica (< MIN_RESUELTOS_CONFIABLE resueltos).
 *  La UI debe atenuar (gris) + marcar "prelim." en vez de pintar verde/rojo. */
export function isRatePreliminary(m: DeliveryMaturity): boolean {
  return m.inmaduro || m.resueltos < MIN_RESUELTOS_CONFIABLE;
}

export interface DeliveryMaturity {
  /** entregados + devueltos (pedidos con desenlace logístico final). */
  resueltos: number;
  /** entregados ÷ (entregados + devueltos), 0-100. null si no hay resueltos. */
  tasaEntregaMadura: number | null;
  /** devueltos ÷ (entregados + devueltos), 0-100. null si no hay resueltos. */
  tasaDevolucionMadura: number | null;
  /** (entregados + devueltos) ÷ total, 0-100. Madurez del cohorte. */
  pctConcluido: number;
  /** pctConcluido < umbral → tasa no concluyente (mostrar en gris). */
  inmaduro: boolean;
}

/**
 * @param rechazados — los RECHAZADOS vienen sumados DENTRO de `devueltos` en
 *   todas las RPCs (la vista de plata no cambia), pero la tasa madura los
 *   EXCLUYE (decisión del dueño 2026-06-24: un rechazo del cliente no mide a la
 *   transportadora). Pasar la columna `rechazados` del server cuando exista;
 *   con la RPC vieja (sin columna) queda en 0 y el cálculo es el histórico.
 */
export function deriveDeliveryMaturity(
  entregados: number,
  devueltos: number,
  total: number,
  rechazados = 0,
): DeliveryMaturity {
  const e = Math.max(0, entregados || 0);
  const d = Math.max(0, (devueltos || 0) - Math.max(0, rechazados || 0));
  const t = Math.max(0, total || 0);
  const resueltos = e + d;
  const pctConcluido = t > 0 ? Math.round((resueltos / t) * 100) : 0;
  return {
    resueltos,
    tasaEntregaMadura: resueltos > 0 ? Math.round((e / resueltos) * 100) : null,
    tasaDevolucionMadura: resueltos > 0 ? Math.round((d / resueltos) * 100) : null,
    pctConcluido,
    inmaduro: pctConcluido < DELIVERY_MATURITY_THRESHOLD,
  };
}

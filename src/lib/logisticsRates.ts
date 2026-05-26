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

export function deriveDeliveryMaturity(
  entregados: number,
  devueltos: number,
  total: number,
): DeliveryMaturity {
  const e = Math.max(0, entregados || 0);
  const d = Math.max(0, devueltos || 0);
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

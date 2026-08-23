/**
 * La MISMA población de Seguimiento para los tres consumidores.
 *
 * SeguimientoTab filtra su data en tres pasos antes de mostrar nada: ventana de
 * 45 días, dedup de pedidos reemplazados por Dropi, y los cierres del equipo
 * («Resuelto» / «Devolución» via isClosedOutByCloser). Pero la barra «Lo que
 * sigue» y el guard de inactividad recibían `segData` CRUDO: contaban pedidos
 * que la pantalla ya descarta — un detenido que el equipo cerró ayer, un
 * duplicado, un pedido de hace dos meses — y mandaban a la asesora a trabajar
 * trabajo hecho. Una barra que pide trabajo hecho se aprende a ignorar
 * (auditoría 23-ago-2026).
 *
 * Va en un helper puro y NO copiado en cada consumidor: dos definiciones de
 * "visible" en la misma app es exactamente cómo nació este bug. El invariante
 * guardián («el guard ve trabajo ⟹ la barra no dice al día») se sostiene solo
 * si barra y guard filtran IGUAL.
 */

import type { OrderData } from './orderUtils';
import { isWithinLastDays, isClosedOutByCloser } from './orderUtils';
import { findSupersededInSeg } from './duplicateOrders';

/** Ventana por defecto de Seguimiento. La misma que usa SeguimientoTab. */
export const SEG_WINDOW_DAYS = 45;

export function segVisiblesParaCola(
  segData: OrderData[],
  closedPhones: Map<string, number>,
  nowMs: number,
): OrderData[] {
  const enVentana = segData.filter((o) => isWithinLastDays(o.fecha, SEG_WINDOW_DAYS, nowMs));
  const superseded = findSupersededInSeg(enVentana);
  return enVentana.filter((o) =>
    !superseded.has(String(o.externalId ?? '')) &&
    !isClosedOutByCloser(o.fecha, o.phone ? closedPhones.get(o.phone) : undefined, o.estado));
}

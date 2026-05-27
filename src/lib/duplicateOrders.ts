// Detección de duplicados "superados" en la cola de Confirmar.
//
// Caso real (Rushmira Ecuador, 2026-05-27): LucidBot creó DOS órdenes en Dropi
// para el mismo cliente — una vieja #5563193 a $90 (sin descuento, quedó como
// PENDIENTE CONFIRMACION y ya ni existe en Dropi) y la real #5569313 a $70
// (PENDIENTE). El operador veía la vieja a $90 y se confundía. Esto detecta el
// PENDIENTE CONFIRMACION viejo cuando ya hay un pedido real más nuevo del mismo
// cliente+producto, para ocultarlo de la cola. NO cancela nada (no destructivo):
// la fila sigue en la DB; solo se filtra de la vista.

import { normalizePhone } from './phone';
import type { OrderData } from './orderUtils';

/** Pedido "progresado" (ya real en Dropi): cualquier estado que no sea
 *  PENDIENTE CONFIRMACION ni CANCELADO. Forma mínima que necesita el matcher. */
export interface ProgressedOrder {
  phone: string | null;
  producto: string | null;
  external_id: string | null;
  estado: string | null;
  fecha: string | null;        // fecha de la orden (YYYY-MM-DD) — apples-to-apples con OrderData.fecha
  created_at?: string | null;  // informativo
}

const DAY_MS = 86400000;

/**
 * Devuelve el Set de `externalId` de los pedidos PENDIENTE CONFIRMACION que YA
 * fueron superados por un pedido real (progresado) del MISMO teléfono + producto,
 * creado de forma contemporánea o más nueva (dentro de `windowDays`).
 *
 * Seguro por diseño: solo oculta cuando hay un match claro y el pedido real NO es
 * más viejo que el pendiente (tolerancia de 1 día), para no esconder una recompra
 * legítima por culpa de un pedido entregado hace tiempo.
 */
export function findSupersededPendingConf(
  pendingConf: OrderData[],
  progressed: ProgressedOrder[],
  windowDays = 14,
): Set<string> {
  const out = new Set<string>();
  const winMs = windowDays * DAY_MS;
  for (const pc of pendingConf) {
    const tel = normalizePhone(pc.phone);
    if (!tel) continue;
    const pcId = String(pc.externalId ?? '');
    const pcProd = (pc.producto || '').trim();
    const pcT = Date.parse(String(pc.fecha || ''));
    const superseded = progressed.some((p) => {
      if (normalizePhone(p.phone) !== tel) return false;
      if ((p.producto || '').trim() !== pcProd) return false;
      if (String(p.external_id ?? '') === pcId) return false; // misma orden, no cuenta
      const pT = Date.parse(String(p.fecha || ''));
      // Sin fechas válidas el match tel+producto+otra-orden ya es señal fuerte.
      if (Number.isNaN(pcT) || Number.isNaN(pT)) return true;
      // El pedido real debe ser contemporáneo o más nuevo (no una compra vieja).
      return pT >= pcT - DAY_MS && pT <= pcT + winMs;
    });
    if (superseded) out.add(pcId);
  }
  return out;
}

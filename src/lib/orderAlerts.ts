// Alertas POR PEDIDO en Confirmar (chips en la ficha de llamada y la lista):
//  1. DUPLICADO: el cliente ya tiene OTRO pedido "en curso" (riesgo de doble
//     envío) — sea uno real en Dropi o un segundo pendiente en la misma cola.
//  2. SOBREPRECIO: el pedido ya está en Dropi con un valor MAYOR al total que
//     el cliente aceptó en Shopify (descuento perdido u otra causa).
//
// Los banners agregados de arriba de la cola ya existían (ShopifyPendingPanel);
// esto lleva el aviso AL PEDIDO MISMO para que la asesora lo vea mientras llama.

import { normalizePhone } from './phone';
import type { OrderData } from './orderUtils';
import type { ProgressedOrder } from './duplicateOrders';

/** Estados terminales: un pedido ENTREGADO/DEVUELTO/INDEMNIZADO/RECHAZADO viejo
 *  es una recompra o historia, NO un duplicado en riesgo de doble envío. */
const TERMINAL_STATES = /ENTREGAD|CANCELAD|REEMPLAZ|DEVOLUCION|DEVUELT|INDEMNIZ|RECHAZAD/i;

export interface ActiveDupAlert {
  externalId: string;
  estado: string;
  fecha: string | null;
  /** 'dropi' = pedido ya real en Dropi; 'cola' = otro pendiente en la misma cola. */
  source: 'dropi' | 'cola';
}

/** Alertas agregadas que ConfirmarTab computa una vez y pasa a CallView/WorkList. */
export interface ConfirmarOrderAlerts {
  /** teléfono normalizado → pedidos "en curso" de ese cliente. */
  dupByPhone: Map<string, ActiveDupAlert[]>;
  /** external_id → total de Shopify (para detectar sobreprecio contra o.valor VIVO). */
  mismatchByExt: Map<string, number>;
}

/**
 * Índice teléfono → pedidos "en curso" del cliente. Dos fuentes:
 *  - `progressed`: pedidos YA reales en Dropi de los teléfonos de la cola (la
 *    query de ConfirmarTab ya excluye PENDIENTE CONFIRMACION y CANCELADO; acá
 *    filtramos también terminales — un entregado viejo es recompra, no dup).
 *  - `queue`: la propia cola visible — dos PENDIENTE CONFIRMACION del mismo
 *    teléfono también son duplicado a revisar antes de confirmar los dos.
 * El consumidor excluye el propio pedido con `dupAlertsFor` (por externalId).
 */
export function buildActiveDupIndex(
  queue: OrderData[],
  progressed: ProgressedOrder[],
): Map<string, ActiveDupAlert[]> {
  const out = new Map<string, ActiveDupAlert[]>();
  const push = (tel: string, alert: ActiveDupAlert) => {
    const list = out.get(tel);
    if (list) list.push(alert);
    else out.set(tel, [alert]);
  };
  for (const p of progressed) {
    const tel = normalizePhone(p.phone);
    if (!tel) continue;
    const estado = String(p.estado || '');
    if (TERMINAL_STATES.test(estado)) continue;
    push(tel, {
      externalId: String(p.external_id ?? ''),
      estado,
      fecha: p.fecha ?? null,
      source: 'dropi',
    });
  }
  // Pendientes duplicados dentro de la cola: solo cuando el MISMO teléfono
  // aparece 2+ veces (cada uno alerta sobre el otro vía dupAlertsFor).
  const queueByTel = new Map<string, OrderData[]>();
  for (const o of queue) {
    const tel = normalizePhone(o.phone);
    if (!tel) continue;
    const list = queueByTel.get(tel);
    if (list) list.push(o);
    else queueByTel.set(tel, [o]);
  }
  for (const [tel, list] of queueByTel) {
    if (list.length < 2) continue;
    for (const o of list) {
      push(tel, {
        externalId: String(o.externalId ?? ''),
        estado: o.estado || 'PENDIENTE CONFIRMACION',
        fecha: o.fecha ?? null,
        source: 'cola',
      });
    }
  }
  return out;
}

/** Alertas de duplicado para UN pedido (excluye el propio external_id). */
export function dupAlertsFor(
  index: Map<string, ActiveDupAlert[]> | undefined,
  order: Pick<OrderData, 'phone' | 'externalId'>,
): ActiveDupAlert[] {
  if (!index) return [];
  const tel = normalizePhone(order.phone);
  if (!tel) return [];
  const selfId = String(order.externalId ?? '');
  return (index.get(tel) ?? []).filter(a => a.externalId && a.externalId !== selfId);
}

/**
 * Sobreprecio VIVO de un pedido contra el total de Shopify: usa `o.valor` actual
 * (no el snapshot del reconcile), así el chip desaparece solo apenas se corrige
 * el valor — sin esperar el refetch de 10 min del hook.
 */
export function overchargeFor(
  mismatchByExt: Map<string, number> | undefined,
  order: Pick<OrderData, 'externalId' | 'valor'>,
): { shopifyTotal: number; overcharge: number } | null {
  if (!mismatchByExt) return null;
  const shopifyTotal = mismatchByExt.get(String(order.externalId ?? ''));
  if (shopifyTotal == null || shopifyTotal <= 0) return null;
  const overcharge = (Number(order.valor) || 0) - shopifyTotal;
  return overcharge > 0.01 ? { shopifyTotal, overcharge } : null;
}

/**
 * Parsea el valor que tipea la operadora tolerando formatos locales:
 * "26,99" → 26.99 (EC) · "59.900" → 59900 (miles CO) · "26.99" → 26.99 ·
 * "$ 70.000" → 70000. Devuelve null si no es un número usable.
 */
export function parseValorInput(s: string): number | null {
  const t = String(s ?? '').trim().replace(/[$\s]/g, '');
  if (!t) return null;
  let normalized = t;
  const hasComma = t.includes(',');
  const hasDot = t.includes('.');
  if (hasComma && hasDot) {
    // El ÚLTIMO separador es el decimal; el otro es de miles.
    const lastComma = t.lastIndexOf(',');
    const lastDot = t.lastIndexOf('.');
    normalized = lastComma > lastDot
      ? t.replace(/\./g, '').replace(',', '.')
      : t.replace(/,/g, '');
  } else if (hasComma) {
    // Coma decimal si deja 1-2 dígitos al final ("26,99"); si no, miles ("1,234").
    normalized = /,\d{1,2}$/.test(t) ? t.replace(',', '.') : t.replace(/,/g, '');
  } else if (hasDot) {
    // Punto decimal si deja 1-2 dígitos al final ("26.99"); si no, miles ("59.900").
    normalized = /\.\d{1,2}$/.test(t) ? t : t.replace(/\./g, '');
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

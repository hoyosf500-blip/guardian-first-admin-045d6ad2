/**
 * Parseo y helpers PUROS del `context_analysis` de la huella de Dropi — el
 * historial detallado del comprador que ve la asesora en Confirmar.
 *
 * La API de huella (`dropi-fingerprint` → `fingerprint.context_analysis`)
 * devuelve el comportamiento del cliente en TRES alcances: mi tienda, otras
 * tiendas, y todas juntas. Cada alcance trae totales del período + desgloses
 * por transportadora, por rango de precio y por tipo de pago.
 *
 * Puro a propósito: se testea sin red, con la forma real de la API. La UI
 * (`BuyerHistoryDetail`) solo dibuja lo que estas funciones devuelven.
 */

export interface CourierStat {
  courierId: number;
  delivered: number;
  returned: number;
  transit: number;
}
export interface PriceStat {
  label: string;
  total: number;
  delivered: number;
  returned: number;
  transit: number;
}
export interface PaymentStat {
  isCod: boolean;
  delivered: number;
  returned: number;
  transit: number;
}
export interface ScopeStat {
  orders: number;
  delivered: number;
  returned: number;
  transit: number;
  byCourier: CourierStat[];
  byPrice: PriceStat[];
  byPayment: PaymentStat[];
}
export interface BuyerContext {
  myShop: ScopeStat;
  otherShops: ScopeStat;
  allShops: ScopeStat;
}

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

function parseScope(raw: unknown): ScopeStat {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v : []);
  return {
    orders: n(o.period_orders),
    delivered: n(o.period_delivered),
    returned: n(o.period_returned),
    transit: n(o.period_transit),
    byCourier: arr(o.by_courier)
      .map((c) => ({
        courierId: n(c.courier_id),
        delivered: n(c.delivered),
        returned: n(c.returned),
        transit: n(c.transit),
      }))
      .filter((c) => c.courierId > 0),
    byPrice: arr(o.by_price_range)
      .map((p) => ({
        label: String(p.label ?? '').trim(),
        total: n(p.total),
        delivered: n(p.delivered),
        returned: n(p.returned),
        transit: n(p.transit),
      }))
      .filter((p) => p.label),
    byPayment: arr(o.by_payment_type).map((p) => ({
      isCod: Boolean(p.is_cod),
      delivered: n(p.delivered),
      returned: n(p.returned),
      transit: n(p.transit),
    })),
  };
}

/**
 * Convierte el `context_analysis` crudo en un `BuyerContext` tipado, o `null`
 * si no hay nada útil (huella vieja sin este bloque, o cliente sin historial).
 */
export function parseBuyerContext(raw: unknown): BuyerContext | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const ctx: BuyerContext = {
    myShop: parseScope(o.my_shop),
    otherShops: parseScope(o.other_shops),
    allShops: parseScope(o.all_shops),
  };
  // Sin ningún pedido en ningún lado → no hay detalle que mostrar.
  if (ctx.allShops.orders <= 0 && ctx.myShop.orders <= 0 && ctx.otherShops.orders <= 0) {
    return null;
  }
  return ctx;
}

/** Volumen total de una fila (para ordenar de mayor a menor actividad). */
export function courierVolume(c: CourierStat): number {
  return c.delivered + c.returned + c.transit;
}

/** Transportadoras ordenadas por volumen desc (la que más usó, primero). */
export function sortCouriersByVolume(list: CourierStat[]): CourierStat[] {
  return [...list].sort((a, b) => courierVolume(b) - courierVolume(a));
}

/**
 * Resumen de "otras tiendas" para la línea de alerta cross-tienda. Devuelve
 * `null` cuando el cliente NO tiene actividad con otras tiendas (nada que
 * resaltar) — así la UI no pinta una línea vacía.
 */
export function otherShopsSummary(
  ctx: BuyerContext,
): { orders: number; delivered: number; returned: number; transit: number } | null {
  const s = ctx.otherShops;
  if (s.orders <= 0 && s.delivered <= 0 && s.returned <= 0 && s.transit <= 0) return null;
  return { orders: s.orders, delivered: s.delivered, returned: s.returned, transit: s.transit };
}

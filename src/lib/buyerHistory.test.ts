import { describe, it, expect } from 'vitest';
import {
  parseBuyerContext, otherShopsSummary, sortCouriersByVolume, courierVolume,
} from './buyerHistory';

// Forma REAL de la API (verificada en producción EC, 2026-07-29).
const REAL = {
  my_shop: {
    period_orders: 1, period_delivered: 1, period_returned: 0, period_transit: 0,
    by_courier: [{ courier_id: 3, delivered: 1, returned: 0, transit: 0 }],
    by_price_range: [{ range_id: 3, label: '$30 - $45', currency: '$', total: 1, delivered: 1, returned: 0, transit: 0 }],
    by_payment_type: [{ is_cod: true, delivered: 1, returned: 0, transit: 0 }],
  },
  other_shops: { period_orders: 0, period_delivered: 0, period_returned: 0, period_transit: 0 },
  all_shops: {
    period_orders: 1, period_delivered: 1, period_returned: 0, period_transit: 0,
    by_courier: [{ courier_id: 3, delivered: 1, returned: 0, transit: 0 }],
    by_price_range: [{ range_id: 3, label: '$30 - $45', currency: '$', total: 1, delivered: 1, returned: 0, transit: 0 }],
    by_payment_type: [{ is_cod: true, delivered: 1, returned: 0, transit: 0 }],
  },
};

describe('parseBuyerContext', () => {
  it('parsea la forma real de la API', () => {
    const ctx = parseBuyerContext(REAL)!;
    expect(ctx.allShops.orders).toBe(1);
    expect(ctx.allShops.byCourier).toEqual([{ courierId: 3, delivered: 1, returned: 0, transit: 0 }]);
    expect(ctx.allShops.byPrice[0].label).toBe('$30 - $45');
    expect(ctx.allShops.byPayment[0].isCod).toBe(true);
  });

  it('other_shops sin desgloses (solo totales) no rompe', () => {
    const ctx = parseBuyerContext(REAL)!;
    expect(ctx.otherShops.orders).toBe(0);
    expect(ctx.otherShops.byCourier).toEqual([]);
  });

  it('cliente sin ningún pedido → null (no hay detalle que mostrar)', () => {
    expect(parseBuyerContext({
      my_shop: { period_orders: 0 }, other_shops: { period_orders: 0 }, all_shops: { period_orders: 0 },
    })).toBeNull();
  });

  it('entrada basura → null, nunca tira', () => {
    for (const bad of [null, undefined, 'x', 42, {}]) {
      expect(parseBuyerContext(bad)).toBeNull();
    }
  });

  it('descarta filas de transportadora sin courier_id', () => {
    const ctx = parseBuyerContext({
      all_shops: { period_orders: 2, by_courier: [{ courier_id: 0, delivered: 1 }, { courier_id: 5, delivered: 1 }] },
      my_shop: {}, other_shops: {},
    })!;
    expect(ctx.allShops.byCourier).toEqual([{ courierId: 5, delivered: 1, returned: 0, transit: 0 }]);
  });
});

describe('otherShopsSummary', () => {
  it('sin actividad con otras tiendas → null', () => {
    expect(otherShopsSummary(parseBuyerContext(REAL)!)).toBeNull();
  });

  it('con actividad → resumen para la línea de alerta', () => {
    const ctx = parseBuyerContext({
      all_shops: { period_orders: 9 }, my_shop: {},
      other_shops: { period_orders: 6, period_delivered: 3, period_returned: 2, period_transit: 1 },
    })!;
    expect(otherShopsSummary(ctx)).toEqual({ orders: 6, delivered: 3, returned: 2, transit: 1 });
  });
});

describe('sortCouriersByVolume', () => {
  it('ordena por volumen total desc (la más usada primero)', () => {
    const sorted = sortCouriersByVolume([
      { courierId: 1, delivered: 1, returned: 0, transit: 0 }, // vol 1
      { courierId: 2, delivered: 6, returned: 2, transit: 1 }, // vol 9
      { courierId: 3, delivered: 1, returned: 1, transit: 0 }, // vol 2
    ]);
    expect(sorted.map((c) => c.courierId)).toEqual([2, 3, 1]);
  });

  it('no muta el array original', () => {
    const orig = [{ courierId: 1, delivered: 1, returned: 0, transit: 0 }];
    sortCouriersByVolume(orig);
    expect(orig[0].courierId).toBe(1);
  });

  it('courierVolume suma los tres estados', () => {
    expect(courierVolume({ courierId: 1, delivered: 6, returned: 2, transit: 1 })).toBe(9);
  });
});

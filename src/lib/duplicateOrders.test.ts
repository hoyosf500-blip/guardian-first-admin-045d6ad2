import { describe, it, expect } from 'vitest';
import { findSupersededPendingConf, type ProgressedOrder } from './duplicateOrders';
import type { OrderData } from './orderUtils';

// Fixtures mínimas: el helper solo lee phone, producto, externalId, fecha.
const pc = (over: Partial<OrderData>): OrderData => ({
  phone: '983975354', producto: 'AIRE ACONDICIONADO GR PR',
  externalId: '5563193', fecha: '2026-05-26', ...over,
} as unknown as OrderData);

const prog = (over: Partial<ProgressedOrder>): ProgressedOrder => ({
  phone: '983975354', producto: 'AIRE ACONDICIONADO GR PR',
  external_id: '5569313', estado: 'PENDIENTE', fecha: '2026-05-26', ...over,
});

describe('findSupersededPendingConf', () => {
  it('oculta el PENDIENTE CONFIRMACION viejo cuando hay un pedido real más nuevo (caso #5563193 → #5569313)', () => {
    const res = findSupersededPendingConf([pc({})], [prog({})]);
    expect(res.has('5563193')).toBe(true);
    expect(res.size).toBe(1);
  });

  it('NO oculta si el producto es distinto', () => {
    const res = findSupersededPendingConf([pc({})], [prog({ producto: 'OTRO PRODUCTO' })]);
    expect(res.size).toBe(0);
  });

  it('NO oculta una recompra: el pedido real es MUCHO más viejo (entregado hace meses)', () => {
    const res = findSupersededPendingConf([pc({ fecha: '2026-05-26' })], [prog({ estado: 'ENTREGADO', fecha: '2026-03-01' })]);
    expect(res.size).toBe(0);
  });

  it('NO oculta si el pedido real está fuera de la ventana hacia adelante (>14 días)', () => {
    const res = findSupersededPendingConf([pc({ fecha: '2026-05-26' })], [prog({ fecha: '2026-07-01' })]);
    expect(res.size).toBe(0);
  });

  it('NO oculta si no hay teléfono', () => {
    const res = findSupersededPendingConf([pc({ phone: '' })], [prog({})]);
    expect(res.size).toBe(0);
  });

  it('NO se cuenta a sí mismo (mismo external_id)', () => {
    const res = findSupersededPendingConf([pc({ externalId: '5569313' })], [prog({ external_id: '5569313' })]);
    expect(res.size).toBe(0);
  });

  it('matchea aunque el teléfono venga con prefijo de país / formato distinto', () => {
    const res = findSupersededPendingConf([pc({ phone: '0983975354' })], [prog({ phone: '+593983975354' })]);
    expect(res.has('5563193')).toBe(true);
  });
});

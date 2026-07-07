import { describe, it, expect } from 'vitest';
import { buildActiveDupIndex, dupAlertsFor, overchargeFor, parseValorInput } from './orderAlerts';
import type { OrderData } from './orderUtils';
import type { ProgressedOrder } from './duplicateOrders';

function order(over: Partial<OrderData>): OrderData {
  return {
    idx: 0,
    externalId: '100',
    nombre: 'Cliente',
    phone: '0983975354',
    estado: 'PENDIENTE CONFIRMACION',
    fecha: '2026-07-01',
    valor: 70,
    ...over,
  } as OrderData;
}

function prog(over: Partial<ProgressedOrder>): ProgressedOrder {
  return {
    phone: '0983975354',
    producto: 'X',
    external_id: '200',
    estado: 'PENDIENTE',
    fecha: '2026-07-02',
    ...over,
  };
}

describe('buildActiveDupIndex + dupAlertsFor', () => {
  it('marca duplicado cuando el cliente tiene un pedido EN CURSO en Dropi', () => {
    const idx = buildActiveDupIndex([order({})], [prog({ estado: 'GUIA_GENERADA' })]);
    const alerts = dupAlertsFor(idx, order({}));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ externalId: '200', source: 'dropi' });
  });

  it('NO marca duplicado por un pedido ENTREGADO viejo (recompra legítima)', () => {
    const idx = buildActiveDupIndex([order({})], [prog({ estado: 'ENTREGADO' })]);
    expect(dupAlertsFor(idx, order({}))).toHaveLength(0);
  });

  it('NO marca por devoluciones ni indemnizadas', () => {
    const idx = buildActiveDupIndex([order({})], [
      prog({ estado: 'DEVOLUCION EN TRANSITO', external_id: '201' }),
      prog({ estado: 'ORDEN INDEMNIZADA', external_id: '202' }),
    ]);
    expect(dupAlertsFor(idx, order({}))).toHaveLength(0);
  });

  it('marca duplicado cuando el mismo teléfono aparece DOS veces en la cola', () => {
    const a = order({ externalId: '100' });
    const b = order({ externalId: '101' });
    const idx = buildActiveDupIndex([a, b], []);
    const alertsA = dupAlertsFor(idx, a);
    expect(alertsA).toHaveLength(1);
    expect(alertsA[0]).toMatchObject({ externalId: '101', source: 'cola' });
    // y el otro alerta sobre el primero
    expect(dupAlertsFor(idx, b)[0].externalId).toBe('100');
  });

  it('matchea teléfonos EC con y sin prefijo de país (+593 vs 0)', () => {
    const idx = buildActiveDupIndex(
      [order({ phone: '0983975354' })],
      [prog({ phone: '+593983975354' })],
    );
    expect(dupAlertsFor(idx, order({ phone: '0983975354' }))).toHaveLength(1);
  });

  it('nunca se alerta a sí mismo (mismo external_id)', () => {
    const idx = buildActiveDupIndex([order({})], [prog({ external_id: '100' })]);
    expect(dupAlertsFor(idx, order({}))).toHaveLength(0);
  });

  it('sin teléfono no hay alerta', () => {
    const idx = buildActiveDupIndex([order({ phone: '' })], [prog({})]);
    expect(dupAlertsFor(idx, order({ phone: '' }))).toHaveLength(0);
  });
});

describe('overchargeFor', () => {
  const map = new Map<string, number>([['100', 59.99]]);

  it('detecta sobreprecio contra el valor VIVO del pedido', () => {
    const r = overchargeFor(map, order({ externalId: '100', valor: 90 }));
    expect(r).not.toBeNull();
    expect(r!.shopifyTotal).toBe(59.99);
    expect(r!.overcharge).toBeCloseTo(30.01, 2);
  });

  it('desaparece apenas el valor local queda corregido', () => {
    expect(overchargeFor(map, order({ externalId: '100', valor: 59.99 }))).toBeNull();
  });

  it('no aplica a pedidos fuera del mapa', () => {
    expect(overchargeFor(map, order({ externalId: '999', valor: 90 }))).toBeNull();
  });
});

describe('parseValorInput', () => {
  it.each([
    ['26,99', 26.99],
    ['26.99', 26.99],
    ['59.900', 59900],
    ['59900', 59900],
    ['1.234.567', 1234567],
    ['1,234', 1234],
    ['$ 70.000', 70000],
    ['70000.5', 70000.5],
  ])('parsea %s → %s', (input, expected) => {
    expect(parseValorInput(input)).toBe(expected);
  });

  it('devuelve null para vacío o basura', () => {
    expect(parseValorInput('')).toBeNull();
    expect(parseValorInput('abc')).toBeNull();
    expect(parseValorInput('  ')).toBeNull();
  });
});

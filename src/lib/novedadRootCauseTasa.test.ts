import { describe, it, expect } from 'vitest';
import { conTasaDevolucion, type OperatorRootCause } from './novedadRootCause';

const op = (o: Partial<OperatorRootCause>): OperatorRootCause => ({
  operatorId: 'x', name: 'X', devoluciones: 0, evitables: 0,
  valorPerdido: 0, valorEvitable: 0, pctEvitable: null, ...o,
});

describe('conTasaDevolucion', () => {
  it('divide devoluciones ÷ confirmados (la medida justa)', () => {
    const ops = [
      op({ operatorId: 'estefano', devoluciones: 116 }),
      op({ operatorId: 'roberto', devoluciones: 17 }),
    ];
    const map = new Map([['estefano', 895], ['roberto', 104]]);
    const r = conTasaDevolucion(ops, map);
    // Estefano 116/895 = 12.96 → 13.0 ; Roberto 17/104 = 16.3
    expect(r[0].tasaDevolucion).toBe(13);
    expect(r[0].confirmados).toBe(895);
    expect(r[1].tasaDevolucion).toBe(16.3);
    // Roberto devuelve MÁS por pedido aunque tenga menos devoluciones absolutas.
    expect(r[1].tasaDevolucion! > r[0].tasaDevolucion!).toBe(true);
  });

  it('sin confirmados → tasa null, no inventa 0', () => {
    const r = conTasaDevolucion([op({ operatorId: 'a', devoluciones: 5 })], new Map());
    expect(r[0].tasaDevolucion).toBeNull();
    expect(r[0].confirmados).toBeNull();
  });

  it('operador null (carga directa) → tasa null', () => {
    const r = conTasaDevolucion([op({ operatorId: null, devoluciones: 3 })], new Map([['x', 10]]));
    expect(r[0].tasaDevolucion).toBeNull();
  });

  it('confirmados 0 → tasa null (no divide por cero)', () => {
    const r = conTasaDevolucion([op({ operatorId: 'a', devoluciones: 5 })], new Map([['a', 0]]));
    expect(r[0].tasaDevolucion).toBeNull();
  });
});

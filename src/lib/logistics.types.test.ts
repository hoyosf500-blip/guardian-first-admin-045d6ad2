import { describe, it, expect } from 'vitest';
import { isLogisticsSummary } from './logistics.types';

describe('isLogisticsSummary', () => {
  it('acepta un summary válido', () => {
    const sample = {
      total_pedidos: 1000,
      entregados: 700,
      devueltos: 100,
      en_transito: 200,
      tasa_entrega: 70.0,
      tasa_devolucion: 10.0,
      valor_entregado: 50000000,
      valor_perdido: 5000000,
    };
    expect(isLogisticsSummary(sample)).toBe(true);
  });

  it('rechaza objeto sin total_pedidos', () => {
    expect(isLogisticsSummary({ entregados: 0 })).toBe(false);
  });

  it('rechaza null', () => {
    expect(isLogisticsSummary(null)).toBe(false);
  });
});

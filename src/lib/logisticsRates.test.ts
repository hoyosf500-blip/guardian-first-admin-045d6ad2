import { describe, it, expect } from 'vitest';
import { deriveDeliveryMaturity, DELIVERY_MATURITY_THRESHOLD } from './logisticsRates';

describe('deriveDeliveryMaturity', () => {
  it('cohorte maduro: tasa sobre (entregados+devueltos), no sobre total', () => {
    // 80 entregados, 10 devueltos, 100 total (10 aún en tránsito)
    const m = deriveDeliveryMaturity(80, 10, 100);
    expect(m.resueltos).toBe(90);
    expect(m.tasaEntregaMadura).toBe(89);   // 80/90 = 88.9 → 89 (NO 80/100=80)
    expect(m.tasaDevolucionMadura).toBe(11); // 10/90
    expect(m.pctConcluido).toBe(90);
    expect(m.inmaduro).toBe(false);
  });

  it('cohorte inmaduro: pocos concluidos → gris', () => {
    // 2 entregados, 0 devueltos, 50 total (48 en tránsito)
    const m = deriveDeliveryMaturity(2, 0, 50);
    expect(m.tasaEntregaMadura).toBe(100); // 2/2 — pero...
    expect(m.pctConcluido).toBe(4);        // solo 4% concluido
    expect(m.inmaduro).toBe(true);         // no concluyente
  });

  it('sin resueltos → tasa null (N/A, no 0%)', () => {
    const m = deriveDeliveryMaturity(0, 0, 10);
    expect(m.tasaEntregaMadura).toBeNull();
    expect(m.tasaDevolucionMadura).toBeNull();
    expect(m.pctConcluido).toBe(0);
    expect(m.inmaduro).toBe(true);
  });

  it('total 0 → no divide por cero', () => {
    const m = deriveDeliveryMaturity(0, 0, 0);
    expect(m.pctConcluido).toBe(0);
    expect(m.tasaEntregaMadura).toBeNull();
  });

  it('umbral de madurez en 70%', () => {
    // 70 concluidos de 100 → justo en el umbral, concluyente
    const justMature = deriveDeliveryMaturity(70, 0, 100);
    expect(justMature.pctConcluido).toBe(70);
    expect(justMature.inmaduro).toBe(false);
    expect(DELIVERY_MATURITY_THRESHOLD).toBe(70);
    // 69 concluidos → inmaduro
    const justBelow = deriveDeliveryMaturity(69, 0, 100);
    expect(justBelow.pctConcluido).toBe(69);
    expect(justBelow.inmaduro).toBe(true);
  });

  it('coerce nulos/negativos a 0', () => {
    const m = deriveDeliveryMaturity(undefined as unknown as number, null as unknown as number, 0);
    expect(m.resueltos).toBe(0);
    expect(m.tasaEntregaMadura).toBeNull();
  });
});

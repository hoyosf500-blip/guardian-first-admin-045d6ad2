import { describe, it, expect } from 'vitest';
import { deriveDeliveryMaturity, DELIVERY_MATURITY_THRESHOLD, isRatePreliminary, MIN_RESUELTOS_CONFIABLE } from './logisticsRates';

describe('deriveDeliveryMaturity', () => {
  it('cohorte maduro: tasa sobre (entregados+devueltos), no sobre total', () => {
    // 80 entregados, 10 devueltos, 100 total (10 aún en tránsito)
    const m = deriveDeliveryMaturity(80, 10, 100);
    expect(m.resueltos).toBe(90);
    expect(m.tasaEntregaMadura).toBe(88);   // 80/90 = 88.9 → floor 88 (NO 80/100=80)
    expect(m.tasaDevolucionMadura).toBe(12); // 10/90 = 11.1 → ceil 12; 88+12=100
    expect(m.pctConcluido).toBe(90);
    expect(m.inmaduro).toBe(false);
  });

  it('rechazados (v4) salen de la tasa madura sin tocar los conteos', () => {
    // El server manda devueltos=20 que INCLUYE 10 rechazos del cliente.
    // Decisión dueño 2026-06-24: el rechazo no mide a la transportadora.
    const m = deriveDeliveryMaturity(80, 20, 110, 10);
    expect(m.resueltos).toBe(90);          // 80 + (20 − 10)
    expect(m.tasaEntregaMadura).toBe(88);  // 80/90 → floor
    // RPC vieja sin columna → rechazados omitido → comportamiento histórico.
    const legacy = deriveDeliveryMaturity(80, 20, 110);
    expect(legacy.resueltos).toBe(100);
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

  // GUARDIANA (auditoría 20-ago-2026, bug reportado por el dueño): un producto
  // con una devolución REAL mostraba "100%" de entrega porque Math.round
  // convertía 99.5 en 100. 100% solo puede significar CERO devueltos, y 0% de
  // devolución solo puede significar CERO devueltos.
  it('NUNCA 100% de entrega habiendo devueltos: 199+1 → 99, no 100', () => {
    const m = deriveDeliveryMaturity(199, 1, 200);
    expect(m.tasaEntregaMadura).toBe(99);
    expect(m.tasaDevolucionMadura).toBe(1);
  });

  it('NUNCA 0% de devolución habiendo devueltos: 1 de 250 → 1, no 0', () => {
    const m = deriveDeliveryMaturity(249, 1, 250);
    expect(m.tasaDevolucionMadura).toBe(1); // 0.4% → ceil 1
    expect(m.tasaEntregaMadura).toBe(99);   // 99.6% → floor 99
  });

  it('100% y 0% siguen existiendo cuando son verdad (cero devueltos)', () => {
    const m = deriveDeliveryMaturity(50, 0, 60);
    expect(m.tasaEntregaMadura).toBe(100);
    expect(m.tasaDevolucionMadura).toBe(0);
  });
});

describe('isRatePreliminary (auditoría de confianza 2026-07-03)', () => {
  it('true con muestra chica (< MIN concluidos): 1 entregado de 80 → 100% pero NO confiable', () => {
    const m = deriveDeliveryMaturity(1, 0, 80);
    expect(m.tasaEntregaMadura).toBe(100);
    expect(m.resueltos).toBeLessThan(MIN_RESUELTOS_CONFIABLE);
    expect(isRatePreliminary(m)).toBe(true);
  });

  it('true con cohorte inmaduro aunque haya >=5 resueltos: 2+2 de 100 → 50% devol sobre 4% concluido', () => {
    const m = deriveDeliveryMaturity(2, 2, 100);
    expect(m.tasaDevolucionMadura).toBe(50);
    expect(m.inmaduro).toBe(true);
    expect(isRatePreliminary(m)).toBe(true);
  });

  it('false con muestra suficiente Y cohorte maduro: 80+10 de 100', () => {
    const m = deriveDeliveryMaturity(80, 10, 100);
    expect(m.inmaduro).toBe(false);
    expect(m.resueltos).toBeGreaterThanOrEqual(MIN_RESUELTOS_CONFIABLE);
    expect(isRatePreliminary(m)).toBe(false);
  });

  it('true en el borde: 4 resueltos (< umbral) aun con cohorte maduro — la muestra chica manda', () => {
    const m = deriveDeliveryMaturity(4, 0, 5);
    expect(m.inmaduro).toBe(false);
    expect(m.resueltos).toBe(4);
    expect(isRatePreliminary(m)).toBe(true);
  });
});

describe('madurez del cohorte: nunca afirmar más concluido del que hay', () => {
  // Auditoría 23-ago-2026. Las TASAS ya usaban floor/ceil por esto mismo, pero
  // `pctConcluido` seguía con round: decía "100% concluido" con un pedido
  // todavía viajando, y en el borde del umbral apagaba el aviso de preliminar
  // sobre una tasa que aún no llegaba a la barra.
  it('199 de 200 concluidos NO es 100%', () => {
    const m = deriveDeliveryMaturity(199, 0, 200);
    expect(m.pctConcluido).toBe(99);
  });

  it('100% solo cuando no queda ninguno en curso', () => {
    expect(deriveDeliveryMaturity(200, 0, 200).pctConcluido).toBe(100);
  });

  it('no se redondea hacia arriba para cruzar el umbral de madurez', () => {
    // 799 de 1000 = 79,9% → con round daba 80 y podía darse por maduro.
    const m = deriveDeliveryMaturity(799, 0, 1000);
    expect(m.pctConcluido).toBe(79);
  });
});

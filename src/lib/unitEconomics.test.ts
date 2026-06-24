import { describe, it, expect } from 'vitest';
import { computeRealKpis, computeSimulation } from './unitEconomics';

describe('computeRealKpis', () => {
  it('tasa de entrega MADURA = entregados / (entregados + devoluciones), sin rechazos ni en-tránsito', () => {
    // 100 generados; despachados 90 = 68 entregados + 17 devoluciones + 5 rechazos.
    const k = computeRealKpis({
      generadosSinCancel: 100,
      despachados: 90,
      entregados: 68,
      devueltos: 17,
      rechazados: 5,
      valorEntregado: 4_073_200,
    });
    expect(k.tasaDespachos).toBeCloseTo(0.90, 5);                  // 90/100
    expect(k.tasaEntrega).toBeCloseTo(68 / 85, 5);                 // ÷ resueltos (68+17), NO ÷ despachados
    expect(k.pctDevolucion).toBeCloseTo(17 / 85, 5);              // devoluciones / resueltos
    expect(k.pctRechazo).toBeCloseTo(5 / 90, 5);                  // rechazos / despachados
    expect(k.pctNoEntregaSobreDespacho).toBeCloseTo(22 / 90, 5); // (dev+rech)/despachados (seed del simulador)
    expect(k.pctInefectividad).toBeCloseTo(0.32, 5);             // 1 − 68/100
    expect(k.ticketPromedio).toBeCloseTo(4_073_200 / 68, 2);
  });

  it('los rechazos NO bajan la tasa de entrega madura', () => {
    const base = { generadosSinCancel: 100, entregados: 68, devueltos: 17, valorEntregado: 0 };
    const sinRech = computeRealKpis({ ...base, despachados: 85, rechazados: 0 });
    const conRech = computeRealKpis({ ...base, despachados: 95, rechazados: 10 });
    expect(conRech.tasaEntrega).toBeCloseTo(sinRech.tasaEntrega, 5); // 68/85 en ambos
    expect(conRech.pctRechazo).toBeGreaterThan(sinRech.pctRechazo);
  });

  it('divisores en cero → 0 (no NaN/Infinity)', () => {
    const k = computeRealKpis({
      generadosSinCancel: 0,
      despachados: 0,
      entregados: 0,
      devueltos: 0,
      rechazados: 0,
      valorEntregado: 0,
    });
    expect(k.tasaDespachos).toBe(0);
    expect(k.tasaEntrega).toBe(0);
    expect(k.pctDevolucion).toBe(0);
    expect(k.pctRechazo).toBe(0);
    expect(k.pctNoEntregaSobreDespacho).toBe(0);
    expect(k.pctInefectividad).toBe(0);
    expect(k.ticketPromedio).toBe(0);
  });

  it('inefectividad nunca negativa', () => {
    const k = computeRealKpis({
      generadosSinCancel: 10,
      despachados: 10,
      entregados: 10,
      devueltos: 0,
      rechazados: 0,
      valorEntregado: 1000,
    });
    expect(k.pctInefectividad).toBe(0); // 1 − 10/10
  });
});

describe('computeSimulation', () => {
  it('cascada: facturado → despachado → entregado → devolución', () => {
    const r = computeSimulation({
      pedidos: 100,
      ticket: 59_900,
      tasaDespachos: 0.85,
      pctDevolucion: 0.2,
      costoProductoPct: 0.17,
      fletePct: 0.26,
      publicidadPct: 0.25,
      adminPct: 0.06,
      costoDevolucionUnit: 0,
    });
    expect(r.facturadoPedidos).toBe(100);
    expect(r.facturadoValor).toBe(5_990_000);
    expect(r.despachadoPedidos).toBeCloseTo(85, 5);
    expect(r.entregadoPedidos).toBeCloseTo(68, 5);   // 85 × 0.8
    expect(r.devueltoPedidos).toBeCloseTo(17, 5);    // 85 × 0.2
    expect(r.ingresos).toBeCloseTo(68 * 59_900, 2);
  });

  it('ganancia = ingresos − cogs − flete − pub − admin − costoDevolución', () => {
    const r = computeSimulation({
      pedidos: 100,
      ticket: 59_900,
      tasaDespachos: 0.85,
      pctDevolucion: 0.2,
      costoProductoPct: 0.167,
      fletePct: 0.259,
      publicidadPct: 0.2456,
      adminPct: 0.0602,
      costoDevolucionUnit: 15_500,
    });
    const ingresos = 68 * 59_900;
    const esperado =
      ingresos
      - ingresos * 0.167
      - ingresos * 0.259
      - ingresos * 0.2456
      - ingresos * 0.0602
      - 17 * 15_500;
    expect(r.gananciaNeta).toBeCloseTo(esperado, 0);
    // % utilidad neta va sobre FACTURADO, no sobre entregado
    expect(r.gananciaPct).toBeCloseTo(esperado / 5_990_000, 5);
  });

  it('clampea porcentajes fuera de [0,1]', () => {
    const r = computeSimulation({
      pedidos: 10,
      ticket: 1000,
      tasaDespachos: 1.5,   // → 1
      pctDevolucion: -0.3,  // → 0
      costoProductoPct: 2,  // → 1
      fletePct: 0,
      publicidadPct: 0,
      adminPct: 0,
      costoDevolucionUnit: 0,
    });
    expect(r.despachadoPedidos).toBe(10);   // tasaDespachos clamp 1
    expect(r.devueltoPedidos).toBe(0);      // pctDevolucion clamp 0
    expect(r.entregadoPedidos).toBe(10);
    expect(r.cogs).toBe(r.ingresos);        // costoProductoPct clamp 1
  });

  it('pedidos 0 → todo 0, sin NaN', () => {
    const r = computeSimulation({
      pedidos: 0, ticket: 59_900, tasaDespachos: 0.85, pctDevolucion: 0.2,
      costoProductoPct: 0.17, fletePct: 0.26, publicidadPct: 0.25, adminPct: 0.06,
      costoDevolucionUnit: 15_500,
    });
    expect(r.facturadoValor).toBe(0);
    expect(r.gananciaNeta).toBe(0);
    expect(r.gananciaPct).toBe(0);
    expect(r.margenEntregaPct).toBe(0);
  });
});

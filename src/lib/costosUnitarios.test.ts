// Costos unitarios — cuánto cuesta una entrega y cuánto una devolución.
//
// Los casos son los NÚMEROS REALES de Colombia, mayo–julio 2026, sacados de la
// base el 2026-08-06. Sirven para dos cosas: fijar la aritmética, y dejar escrito
// el estado de los datos en el momento en que se construyó esto — en particular
// que a la billetera de Colombia le faltaban ~9 de cada 10 cargos de devolución.

import { describe, it, expect } from 'vitest';
import {
  calcularCostosUnitarios,
  COBERTURA_CARGO_MINIMA,
  type CostosCrudos,
} from './costosUnitarios';

/** Julio 2026, Colombia. 220 entregados / 64 devueltos, flete nominal $23.146. */
const CO_JULIO: CostosCrudos = {
  entregados: 220,
  devueltos: 64,
  ingresos_entregados: 31_240_000,
  cogs_entregados: 9_500_000,
  flete_entregados: 5_092_120,   // 220 × 23.146
  flete_devueltos: 1_420_540,    // los que se pagaron y no llegaron
  cargo_devolucion_total: 374_752,
  devoluciones_con_cargo: 19,    // ← de 64 devoluciones. La billetera está coja.
  pauta_periodo: 8_000_000,
};

describe('costos unitarios — Colombia julio 2026', () => {
  const r = calcularCostosUnitarios(CO_JULIO)!;

  it('el flete nominal es el que factura la transportadora', () => {
    expect(Math.round(r.fletePorEntrega!)).toBe(23_146);
  });

  it('el flete REAL por entrega incluye el de los que se devolvieron', () => {
    // (5.092.120 + 1.420.540) ÷ 220 = 29.603. Son $6.457 más por cada entrega,
    // y no aparecían en ningún costo de Guardian.
    expect(Math.round(r.fleteRealPorEntrega!)).toBe(29_603);
    expect(r.fletePerdido).toBe(1_420_540);
  });

  it('el multiplicador del flete ES el inverso de la tasa de entrega', () => {
    // Esta es la relación que hace accionable el número: el flete no lo controla
    // la transportadora, lo controla la tasa de entrega.
    expect(r.tasaEntrega).toBeCloseTo(77.5, 1);
    expect(r.multiplicador).toBeCloseTo(1.28, 2);
    const inversoDeLaTasa = 1 / (r.tasaEntrega! / 100);
    expect(Math.abs(r.multiplicador! - inversoDeLaTasa)).toBeLessThan(0.02);
  });

  it('NO da por bueno el cargo mientras Dropi no termine de facturar', () => {
    // 19 devoluciones cobradas sobre 64 = 30% de cobertura. El promedio existe
    // pero es una PARTE, no un total: el costo real todavía va a subir.
    expect(r.devolucionesCobradas).toBe(19);
    expect(r.coberturaCargo).toBeCloseTo(19 / 64, 3);
    expect(r.coberturaCargo).toBeLessThan(COBERTURA_CARGO_MINIMA);
    expect(r.cargoDevolucionConfiable).toBe(false);
    expect(r.costoTotalPorDevolucion).toBeNull();
    // El promedio se calcula igual (la UI lo muestra con su cobertura al lado),
    // pero nadie puede confundirlo con una medición cerrada.
    expect(Math.round(r.cargoPorDevolucion!)).toBe(19_724);
  });

  it('con Dropi ya facturado SÍ emite el costo total por devolución', () => {
    const completo = { ...CO_JULIO, devoluciones_con_cargo: 64, cargo_devolucion_total: 64 * 22_000 };
    const c = calcularCostosUnitarios(completo)!;
    expect(c.cargoDevolucionConfiable).toBe(true);
    // flete del devuelto (1.420.540 ÷ 64 = 22.196) + cargo 22.000 = 44.196
    expect(Math.round(c.costoTotalPorDevolucion!)).toBe(44_196);
  });

  it('el margen por entrega descuenta el flete REAL, no el nominal', () => {
    // ticket 142.000 − cogs 43.182 − flete real 29.603 = 69.215 (sin cargo, que
    // no es confiable en este período).
    expect(Math.round(r.ticketPromedio!)).toBe(142_000);
    expect(Math.round(r.cogsPorEntrega!)).toBe(43_182);
    expect(Math.round(r.margenPorEntrega!)).toBe(69_215);
    // Con el flete nominal daría $6.457 más — el error clásico de COD.
    const margenIngenuo = r.ticketPromedio! - r.cogsPorEntrega! - r.fletePorEntrega!;
    expect(Math.round(margenIngenuo - r.margenPorEntrega!)).toBe(6_457);
  });

  it('el margen BAJA cuando el cargo de devolución entra en la cuenta', () => {
    const completo = { ...CO_JULIO, devoluciones_con_cargo: 64, cargo_devolucion_total: 64 * 22_000 };
    const c = calcularCostosUnitarios(completo)!;
    // 64 × 22.000 prorrateado entre 220 entregas = $6.400 menos por venta.
    expect(r.margenPorEntrega! - c.margenPorEntrega!).toBeCloseTo(6_400, 0);
  });

  it('el costo de conseguir cada venta entregada', () => {
    expect(Math.round(r.costoPorVenta!)).toBe(36_364); // 8.000.000 ÷ 220
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ecuador julio 2026 — cifras VERIFICADAS contra la API de Dropi el 2026-08-06.
// Se bajaron los 721 movimientos del mes: 39 cargos de devolución emitidos, y
// Guardian tenía esos mismos. La cobertura baja NO era pérdida de datos, era que
// Dropi cobra el cargo cuando el paquete vuelve al origen — semanas después.
// Este caso existe para que nadie vuelva a leer "cobertura baja" como "bug".
const EC_JULIO: CostosCrudos = {
  entregados: 514,
  devueltos: 234,
  ingresos_entregados: 15_413_86 / 100 * 10, // ~$15.413,86
  cogs_entregados: 0,
  flete_entregados: 3_541_46 / 100,   // 514 × $6,89
  flete_devueltos: 1_596_43 / 100,    // los que se pagaron y volvieron
  cargo_devolucion_total: 199.68,     // 39 × $5,12
  devoluciones_con_cargo: 39,
  pauta_periodo: 2_828,
};

describe('Ecuador julio 2026 — la cobertura baja NO es un bug', () => {
  const r = calcularCostosUnitarios(EC_JULIO)!;

  it('39 de 234 cobradas: es facturación pendiente, no datos perdidos', () => {
    expect(r.devolucionesCobradas).toBe(39);
    expect(Math.round(r.coberturaCargo * 100)).toBe(17);
    expect(r.cargoDevolucionConfiable).toBe(false);
    // Y por eso NO se emite un costo por devolución que sería parcial.
    expect(r.costoTotalPorDevolucion).toBeNull();
  });

  it('la ley del multiplicador también se cumple en Ecuador', () => {
    expect(r.tasaEntrega).toBeCloseTo(68.7, 1);
    expect(r.multiplicador).toBeCloseTo(1.45, 2);
    const inversoDeLaTasa = 1 / (r.tasaEntrega! / 100);
    expect(Math.abs(r.multiplicador! - inversoDeLaTasa)).toBeLessThan(0.02);
  });

  it('el flete real por entrega es 45% más alto que el facturado', () => {
    // Una décima de tolerancia: los insumos se reconstruyeron desde los totales
    // redondeados del reporte, no desde los centavos crudos de la base.
    expect(r.fletePorEntrega).toBeCloseTo(6.89, 2);
    expect(r.fleteRealPorEntrega).toBeCloseTo(10.0, 1);
    expect(r.fleteRealPorEntrega! - r.fletePorEntrega!).toBeCloseTo(3.1, 1);
  });
});

describe('mayo y junio — el mismo patrón con peor tasa', () => {
  const CO_MAYO: CostosCrudos = {
    entregados: 118, devueltos: 54,
    ingresos_entregados: 12_172_600, cogs_entregados: 0,
    flete_entregados: 2_702_318, flete_devueltos: 1_350_864,
    cargo_devolucion_total: 141_600, devoluciones_con_cargo: 5,
    pauta_periodo: 0,
  };

  it('con 68,6% de entrega el flete se multiplica por 1,5', () => {
    const r = calcularCostosUnitarios(CO_MAYO)!;
    expect(r.tasaEntrega).toBeCloseTo(68.6, 1);
    expect(Math.round(r.fletePorEntrega!)).toBe(22_901);
    expect(Math.round(r.fleteRealPorEntrega!)).toBe(34_349);
    expect(r.multiplicador).toBeCloseTo(1.5, 2);
  });

  it('mayo tenía 5 cargos sobre 54 devoluciones: nada confiable', () => {
    const r = calcularCostosUnitarios(CO_MAYO)!;
    expect(r.cargoDevolucionConfiable).toBe(false);
    expect(r.coberturaCargo).toBeLessThan(0.1);
  });
});

describe('bordes — nunca inventar una cifra', () => {
  it('sin entregas no hay costo por entrega', () => {
    const r = calcularCostosUnitarios({
      entregados: 0, devueltos: 0, ingresos_entregados: 0, cogs_entregados: 0,
      flete_entregados: 0, flete_devueltos: 0, cargo_devolucion_total: 0,
      devoluciones_con_cargo: 0, pauta_periodo: 0,
    })!;
    expect(r.fletePorEntrega).toBeNull();
    expect(r.fleteRealPorEntrega).toBeNull();
    expect(r.multiplicador).toBeNull();
    expect(r.ticketPromedio).toBeNull();
    expect(r.margenPorEntrega).toBeNull();
    expect(r.tasaEntrega).toBeNull();
  });

  it('sin devoluciones el flete real ES el nominal', () => {
    const r = calcularCostosUnitarios({
      entregados: 100, devueltos: 0, ingresos_entregados: 10_000_000, cogs_entregados: 0,
      flete_entregados: 2_000_000, flete_devueltos: 0, cargo_devolucion_total: 0,
      devoluciones_con_cargo: 0, pauta_periodo: 0,
    })!;
    expect(r.fleteRealPorEntrega).toBe(r.fletePorEntrega);
    expect(r.multiplicador).toBe(1);
    expect(r.tasaEntrega).toBe(100);
  });

  it('sin datos devuelve null, no un objeto en ceros', () => {
    expect(calcularCostosUnitarios(null)).toBeNull();
    expect(calcularCostosUnitarios(undefined)).toBeNull();
  });
});

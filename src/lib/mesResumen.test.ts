import { describe, it, expect } from 'vitest';
import { buildMesResumen, buildMesResumenFromBreakdown } from './mesResumen';
import type { LogisticsSummary } from './logistics.types';
import type { EstadoRow } from './estadoBuckets';

// Summary realista (estilo el mes que reportó el dueño: ~181 generados).
const base: LogisticsSummary = {
  total_pedidos: 175,        // excluye cancelados
  entregados: 69,
  devueltos: 40,
  en_transito: 30,
  tasa_entrega: 39.4,
  tasa_devolucion: 22.8,
  valor_entregado: 7_000_000,
  valor_perdido: 1_500_000,
  valor_en_transito: 3_200_000,
  pendientes_sin_despachar: 5,
  pendientes_por_confirmar: 10,
  valor_pendientes: 900_000,
  cancelados: 6,
  valor_cancelado: 400_000,
  novedades: 18,
  valor_novedades: 800_000,
};

describe('buildMesResumen', () => {
  it('devuelve null sin datos', () => {
    expect(buildMesResumen(null)).toBeNull();
  });

  it('generadoTotal = total_pedidos + cancelados (matchea "generados" de Dropi)', () => {
    const r = buildMesResumen(base)!;
    expect(r.generadoTotal).toBe(175 + 6); // 181
  });

  it('SIN HUECOS: la suma de counts de todos los buckets === generadoTotal', () => {
    const r = buildMesResumen(base)!;
    const sumaBuckets = r.buckets.reduce((acc, b) => acc + b.count, 0);
    expect(sumaBuckets).toBe(r.generadoTotal);
  });

  it('crea bucket "Otros" cuando hay estados sin clasificar', () => {
    // 175 no-cancelados; clasificados = 69+40+30+18+(5+10)=172 → residual 3
    const r = buildMesResumen(base)!;
    const otros = r.buckets.find((b) => b.key === 'otros');
    expect(otros).toBeDefined();
    expect(otros!.count).toBe(3);
  });

  it('NO crea bucket "Otros" cuando todo está clasificado', () => {
    const exacto: LogisticsSummary = {
      ...base,
      total_pedidos: 172, // = 69+40+30+18+15, sin residual
    };
    const r = buildMesResumen(exacto)!;
    expect(r.buckets.find((b) => b.key === 'otros')).toBeUndefined();
    const suma = r.buckets.reduce((a, b) => a + b.count, 0);
    expect(suma).toBe(r.generadoTotal); // 172 + 6 cancelados = 178
  });

  it('combina los dos pendientes en un bucket con su valor combinado', () => {
    const r = buildMesResumen(base)!;
    const pend = r.buckets.find((b) => b.key === 'pendientes')!;
    expect(pend.count).toBe(15); // 10 + 5
    expect(pend.valor).toBe(900_000);
    expect(pend.sublabel).toContain('10 por confirmar');
    expect(pend.sublabel).toContain('5 por despachar');
  });

  it('la cascada de valor balancea: generado − fugas = entregado', () => {
    const r = buildMesResumen(base)!;
    const fugas =
      r.valorEnTransito + r.valorNovedades + r.valorPendientes + r.valorPerdido + r.valorCancelado;
    expect(r.valorGenerado - fugas).toBe(r.valorEntregado);
  });

  it('pct se calcula sobre generadoTotal', () => {
    const r = buildMesResumen(base)!;
    const entregado = r.buckets.find((b) => b.key === 'entregado')!;
    expect(entregado.pct).toBeCloseTo((69 / 181) * 100, 5);
  });

  it('campos opcionales ausentes (RPC viejo) → 0, sin crashear', () => {
    const minimal = {
      total_pedidos: 10,
      entregados: 4,
      devueltos: 1,
      en_transito: 5,
      tasa_entrega: 40,
      tasa_devolucion: 10,
      valor_entregado: 100,
      valor_perdido: 20,
    } as LogisticsSummary;
    const r = buildMesResumen(minimal)!;
    expect(r.generadoTotal).toBe(10); // sin cancelados
    expect(r.valorGenerado).toBe(120); // entregado + perdido
    const suma = r.buckets.reduce((a, b) => a + b.count, 0);
    expect(suma).toBe(10);
  });
});

describe('buildMesResumenFromBreakdown', () => {
  const rows: EstadoRow[] = [
    { estado: 'ENTREGADO',              pedidos: 69, valor: 6_899_293, unidades: 86 },
    { estado: 'DEVOLUCION',             pedidos: 19, valor: 2_513_199, unidades: 22 },
    { estado: 'EN TRANSPORTE',          pedidos: 17, valor: 1_707_000, unidades: 20 },
    { estado: 'NOVEDAD',                pedidos: 4,  valor: 418_549,   unidades: 4 },
    { estado: 'PENDIENTE',              pedidos: 34, valor: 3_560_150, unidades: 38 },
    { estado: 'GUIA_GENERADA',          pedidos: 20, valor: 2_000_000, unidades: 24 },
    { estado: 'CONFIRMADO',             pedidos: 12, valor: 1_200_000, unidades: 14 },
    { estado: 'CANCELADO',              pedidos: 31, valor: 3_200_701, unidades: 33 },
  ];

  it('null → null', () => {
    expect(buildMesResumenFromBreakdown(null)).toBeNull();
  });

  it('tiles: generados sin/con cancelados, total vendido, unidades', () => {
    const r = buildMesResumenFromBreakdown(rows)!;
    expect(r.generadoTotal).toBe(206);
    expect(r.cancelados).toBe(31);
    expect(r.generadosSinCancel).toBe(175);
    expect(r.entregados).toBe(69);
    // Total vendido ALINEADO a Dropi = despachado y NO rechazado: excluye cancelado
    // (3.200.701) + pendiente (3.560.150) + preparación (GUIA_GENERADA 2M + CONFIRMADO
    // 1.2M = 3.200.000) + rechazo (0). = entregado + devolución + tránsito + novedad.
    const totalValor = rows.reduce((a, x) => a + x.valor, 0);
    expect(r.totalVendido).toBe(totalValor - 3_200_701 - 3_560_150 - 3_200_000);
    // Unidades vendidas = SUM(cantidad) sin cancelados
    const totalUnd = rows.reduce((a, x) => a + x.unidades, 0);
    expect(r.unidadesVendidas).toBe(totalUnd - 33);
  });

  it('RECHAZADO es bucket PROPIO (fuera de devueltos) y sale del "total vendido"', () => {
    const conRechazo: EstadoRow[] = [
      ...rows,
      { estado: 'RECHAZADO', pedidos: 7, valor: 700_000, unidades: 8 },
    ];
    const r = buildMesResumenFromBreakdown(conRechazo)!;
    // devueltos = SOLO DEVOLUCION (19), NO incluye los 7 rechazos
    expect(r.devueltos).toBe(19);
    expect(r.rechazados).toBe(7);
    expect(r.valorRechazos).toBe(700_000);
    // El embudo muestra "Rechazados" como bucket aparte de "Devueltos"
    const rechazoBucket = r.buckets.find((b) => b.key === 'rechazado');
    const devueltoBucket = r.buckets.find((b) => b.key === 'devuelto');
    expect(rechazoBucket?.count).toBe(7);
    expect(devueltoBucket?.count).toBe(19);
    // Total vendido NO incluye los rechazos (700k extra fuera)
    const totalValor = rows.reduce((a, x) => a + x.valor, 0);
    expect(r.totalVendido).toBe(totalValor - 3_200_701 - 3_560_150 - 3_200_000);
  });

  it('SIN HUECOS: Σ counts de buckets === generadoTotal', () => {
    const r = buildMesResumenFromBreakdown(rows)!;
    const suma = r.buckets.reduce((a, b) => a + b.count, 0);
    expect(suma).toBe(r.generadoTotal);
  });

  it('CONFIRMADO/GUIA_GENERADA aparecen como "En preparación", no como Otros', () => {
    const r = buildMesResumenFromBreakdown(rows)!;
    const prep = r.buckets.find((b) => b.key === 'preparacion')!;
    expect(prep).toBeDefined();
    expect(prep.count).toBe(32); // 20 + 12
    expect(r.valorOtros).toBe(0);
    expect(r.buckets.some((b) => b.key.startsWith('otros:'))).toBe(false);
  });

  it('estado desconocido → bucket propio POR NOMBRE (no "Otros" anónimo)', () => {
    const r = buildMesResumenFromBreakdown([
      ...rows,
      { estado: 'LIMBO_XYZ', pedidos: 5, valor: 1000, unidades: 5 },
    ])!;
    const limbo = r.buckets.find((b) => b.label === 'LIMBO_XYZ');
    expect(limbo).toBeDefined();
    expect(limbo!.count).toBe(5);
    expect(limbo!.tone).toBe('otros');
    const suma = r.buckets.reduce((a, b) => a + b.count, 0);
    expect(suma).toBe(r.generadoTotal);
  });

  it('cascada balancea: generado − fugas − otros = entregado', () => {
    const r = buildMesResumenFromBreakdown(rows)!;
    const fugas = r.valorEnTransito + r.valorNovedades + r.valorPreparacion
      + r.valorPendientes + r.valorPerdido + r.valorCancelado + r.valorOtros;
    expect(r.valorGenerado - fugas).toBe(r.valorEntregado);
  });
});

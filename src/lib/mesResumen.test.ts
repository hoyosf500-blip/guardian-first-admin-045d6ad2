import { describe, it, expect } from 'vitest';
import { buildMesResumen } from './mesResumen';
import type { LogisticsSummary } from './logistics.types';

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

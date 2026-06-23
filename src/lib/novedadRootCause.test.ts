import { describe, it, expect } from 'vitest';
import {
  evitableReasons,
  isEvitable,
  summarizeRootCause,
  RootCauseRow,
} from './novedadRootCause';

/** Helper: construye una fila con defaults sanos (no-evitable). */
function row(over: Partial<RootCauseRow> = {}): RootCauseRow {
  return {
    orderId: over.orderId ?? Math.random().toString(36).slice(2),
    novedad: null,
    validationDecision: 'green',
    addressKind: 'urban',
    valor: 0,
    transportadora: null,
    ciudad: null,
    confirmerId: null,
    confirmerName: null,
    tieneNovedad: false,
    ...over,
  };
}

describe('evitableReasons / isEvitable', () => {
  it('semáforo amarillo o rojo → motivo semaforo', () => {
    expect(evitableReasons(row({ validationDecision: 'yellow' }))).toContain('semaforo');
    expect(evitableReasons(row({ validationDecision: 'red' }))).toContain('semaforo');
    expect(isEvitable(row({ validationDecision: 'red' }))).toBe(true);
  });

  it('semáforo verde y dirección urbana → NO evitable', () => {
    expect(evitableReasons(row({ validationDecision: 'green', addressKind: 'urban' }))).toEqual([]);
    expect(isEvitable(row({ validationDecision: 'green' }))).toBe(false);
  });

  it('validación NULL (pre-validador) NO cuenta como evitable por semáforo', () => {
    expect(evitableReasons(row({ validationDecision: null, addressKind: 'urban' }))).toEqual([]);
    expect(isEvitable(row({ validationDecision: null, addressKind: 'urban' }))).toBe(false);
  });

  it('dirección rural o sin clasificar → motivo direccion', () => {
    expect(evitableReasons(row({ addressKind: 'rural' }))).toContain('direccion');
    expect(evitableReasons(row({ addressKind: 'unknown' }))).toContain('direccion');
  });

  it('pickup_office en cualquiera de los dos campos → motivo pickup', () => {
    expect(evitableReasons(row({ validationDecision: 'pickup_office' }))).toContain('pickup');
    expect(evitableReasons(row({ addressKind: 'pickup_office' }))).toContain('pickup');
  });

  it('acumula múltiples motivos', () => {
    const r = evitableReasons(row({ validationDecision: 'yellow', addressKind: 'rural' }));
    expect(r).toContain('semaforo');
    expect(r).toContain('direccion');
    expect(r.length).toBe(2);
  });

  it('insensible a mayúsculas/espacios', () => {
    expect(isEvitable(row({ validationDecision: ' YELLOW ' }))).toBe(true);
    expect(isEvitable(row({ addressKind: 'RURAL' }))).toBe(true);
  });
});

describe('summarizeRootCause — totales', () => {
  it('vacío → ceros y pct null', () => {
    const s = summarizeRootCause([]);
    expect(s.totalDevoluciones).toBe(0);
    expect(s.evitables).toBe(0);
    expect(s.pctEvitable).toBeNull();
    expect(s.valorPerdidoTotal).toBe(0);
    expect(s.porOperadora).toEqual([]);
    expect(s.porCategoria).toEqual([]);
  });

  it('cuenta evitables y calcula el %', () => {
    const s = summarizeRootCause([
      row({ validationDecision: 'red' }),      // evitable
      row({ validationDecision: 'yellow' }),   // evitable
      row({ validationDecision: 'green', addressKind: 'urban' }), // no
      row({ validationDecision: 'green', addressKind: 'urban' }), // no
    ]);
    expect(s.totalDevoluciones).toBe(4);
    expect(s.evitables).toBe(2);
    expect(s.pctEvitable).toBeCloseTo(0.5);
  });

  it('suma valor perdido total y el evitable por separado (null → 0)', () => {
    const s = summarizeRootCause([
      row({ validationDecision: 'red', valor: 100 }),   // evitable
      row({ validationDecision: 'green', valor: 50, addressKind: 'urban' }), // no
      row({ validationDecision: 'red', valor: null }),  // evitable, valor null
    ]);
    expect(s.valorPerdidoTotal).toBe(150);
    expect(s.valorPerdidoEvitable).toBe(100);
  });

  it('porReason cuenta cada motivo entre las evitables', () => {
    const s = summarizeRootCause([
      row({ validationDecision: 'yellow', addressKind: 'rural' }), // semaforo + direccion
      row({ validationDecision: 'pickup_office' }),                // pickup
    ]);
    expect(s.porReason.semaforo).toBe(1);
    expect(s.porReason.direccion).toBe(1);
    expect(s.porReason.pickup).toBe(1);
  });
});

describe('summarizeRootCause — ranking de operadoras', () => {
  it('agrupa por confirmador y ordena por evitables desc', () => {
    const s = summarizeRootCause([
      row({ confirmerId: 'a', confirmerName: 'Ana', validationDecision: 'red', valor: 10 }),
      row({ confirmerId: 'a', confirmerName: 'Ana', validationDecision: 'red', valor: 20 }),
      row({ confirmerId: 'b', confirmerName: 'Beto', validationDecision: 'green', addressKind: 'urban', valor: 5 }),
    ]);
    expect(s.porOperadora[0].name).toBe('Ana');
    expect(s.porOperadora[0].evitables).toBe(2);
    expect(s.porOperadora[0].valorEvitable).toBe(30);
    expect(s.porOperadora[0].pctEvitable).toBeCloseTo(1);
    const beto = s.porOperadora.find((o) => o.operatorId === 'b');
    expect(beto?.evitables).toBe(0);
  });

  it('devoluciones sin confirmador caen en un bucket "carga directa"', () => {
    const s = summarizeRootCause([
      row({ confirmerId: null, validationDecision: 'red' }),
    ]);
    const bucket = s.porOperadora[0];
    expect(bucket.operatorId).toBeNull();
    expect(bucket.devoluciones).toBe(1);
    expect(s.conConfirmador).toBe(0);
    expect(s.sinConfirmador).toBe(1);
  });
});

describe('summarizeRootCause — categorías de novedad', () => {
  it('agrupa por culpa+categoría usando la taxonomía', () => {
    const s = summarizeRootCause([
      row({ novedad: 'Dirección errada', validationDecision: 'red', valor: 10 }),
      row({ novedad: 'LA DIRECCION NO EXISTE', validationDecision: 'yellow', valor: 20 }),
      row({ novedad: 'Cliente no contesta', validationDecision: 'green', addressKind: 'urban', valor: 5 }),
    ]);
    const dir = s.porCategoria.find((c) => c.categoria === 'direccion_errada');
    expect(dir?.devoluciones).toBe(2);
    expect(dir?.evitables).toBe(2);
    expect(dir?.valorPerdido).toBe(30);
    expect(dir?.culpa).toBe('datos_nuestros');
    const noresp = s.porCategoria.find((c) => c.categoria === 'no_responde');
    expect(noresp?.devoluciones).toBe(1);
    expect(noresp?.evitables).toBe(0);
  });
});

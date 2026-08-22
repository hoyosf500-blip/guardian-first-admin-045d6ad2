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

describe('el sello al despachar manda sobre el semaforo vivo', () => {
  // `validation_decision` es MUTABLE: 10 sitios la escriben y 2 la ponen en
  // null al editar la direccion. Los pedidos MAS gestionados son justo los que
  // perdieron la marca roja, asi que leyendo el valor vivo el semaforo se ve
  // mejor de lo que es. Ver migracion 20260822180000.
  it('usa el sello cuando existe, aunque el valor vivo ya se haya limpiado', () => {
    expect(isEvitable({
      validationDecision: null, addressKind: null,
      validacionAlDespachar: 'red', addressKindAlDespachar: null,
    })).toBe(true);
  });

  it('un sello sano gana sobre un valor vivo en rojo', () => {
    expect(isEvitable({
      validationDecision: 'red', addressKind: null,
      validacionAlDespachar: 'green', addressKindAlDespachar: null,
    })).toBe(false);
  });

  it('sin sello (historico) cae al valor vivo, que es lo unico que hay', () => {
    expect(isEvitable({ validationDecision: 'yellow', addressKind: null })).toBe(true);
    expect(isEvitable({ validationDecision: 'green', addressKind: null })).toBe(false);
  });

  it('un sello vacio es un valor sellado, no una ausencia', () => {
    // '' quiere decir "se sello y no habia semaforo". Con `||` habria caido al
    // valor vivo y habria vuelto a leer el dato mutable.
    expect(isEvitable({
      validationDecision: 'red', addressKind: null,
      validacionAlDespachar: '', addressKindAlDespachar: '',
    })).toBe(false);
  });
});

describe('donde se devuelve, no por culpa de quien', () => {
  const fila = (ciudad: string | null, valor: number, vd: string | null = null) => ({
    orderId: `o-${ciudad}-${valor}`, novedad: null, validationDecision: vd,
    addressKind: null, valor, transportadora: null, ciudad,
    confirmerId: null, confirmerName: null, tieneNovedad: false,
  });

  it('agrupa por ciudad y ordena por cantidad', () => {
    const r = summarizeRootCause([
      fila('CUENCA', 10), fila('CUENCA', 20), fila('CUENCA', 30, 'red'),
      fila('QUITO', 40),
    ]);
    expect(r.porCiudad[0].ciudad).toBe('CUENCA');
    expect(r.porCiudad[0].devoluciones).toBe(3);
    expect(r.porCiudad[0].valorPerdido).toBe(60);
    expect(r.porCiudad[0].evitables).toBe(1);
    expect(r.porCiudad[1].ciudad).toBe('QUITO');
  });

  it('los que no tienen ciudad van a un bucket VISIBLE, no se esconden', () => {
    // Escondidos, la suma de la tabla no cuadraria con el total de arriba.
    const r = summarizeRootCause([fila(null, 5), fila('  ', 5), fila('LOJA', 5)]);
    const suma = r.porCiudad.reduce((n, c) => n + c.devoluciones, 0);
    expect(suma).toBe(r.totalDevoluciones);
    expect(r.porCiudad.map(c => c.ciudad)).toContain('Sin ciudad');
  });
});

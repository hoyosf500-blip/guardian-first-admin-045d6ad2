import { describe, it, expect } from 'vitest';
import { contarPorRiesgo, type NivelRiesgo } from './riesgoChat';

const idx = (pairs: Array<[string, NivelRiesgo]>) => new Map<string, NivelRiesgo>(pairs);

describe('contarPorRiesgo', () => {
  it('cuenta pendientes por etiqueta', () => {
    const items = [
      { dbId: 'a', result: null },
      { dbId: 'b', result: null },
      { dbId: 'c', result: null },
      { dbId: 'd', result: null },
    ];
    const index = idx([['a', 'mudo'], ['b', 'mudo'], ['c', 'tibio'], ['d', 'confirmado']]);
    const c = contarPorRiesgo(items, index);
    expect(c.mudo).toBe(2);
    expect(c.tibio).toBe(1);
    expect(c.confirmado).toBe(1);
    expect(c.total).toBe(4);
    expect(c.sinSenal).toBe(0);
  });

  it('NO cuenta los ya gestionados (con result)', () => {
    const items = [
      { dbId: 'a', result: null },
      { dbId: 'b', result: 'conf' },
      { dbId: 'c', result: 'noresp' },
    ];
    const c = contarPorRiesgo(items, idx([['a', 'mudo'], ['b', 'mudo'], ['c', 'tibio']]));
    expect(c.mudo).toBe(1);
    expect(c.total).toBe(1);
  });

  it('pendiente sin dbId o sin señal → sinSenal, nunca inventa etiqueta', () => {
    const items = [
      { dbId: null, result: null },
      { dbId: 'x', result: null }, // no está en el index
      { dbId: 'y', result: null },
    ];
    const c = contarPorRiesgo(items, idx([['y', 'tibio']]));
    expect(c.sinSenal).toBe(2);
    expect(c.tibio).toBe(1);
    expect(c.total).toBe(3);
  });

  it('cola vacía → todo en cero', () => {
    const c = contarPorRiesgo([], idx([]));
    expect(c).toEqual({ mudo: 0, frio: 0, tibio: 0, sin_dato: 0, confirmado: 0, sinSenal: 0, total: 0 });
  });
});

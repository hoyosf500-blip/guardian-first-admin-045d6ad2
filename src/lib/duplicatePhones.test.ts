import { describe, it, expect } from 'vitest';
import {
  buildDupMap, dupMatchesFor, isBlockedByDuplicate, uniquePhones,
  type ExistingOrder,
  repetidosEnElLote,
} from './duplicatePhones';

const ex = (phone_norm: string, external_id: string, estado = 'PENDIENTE'): ExistingOrder => ({
  phone_norm, external_id, estado, fecha: '2026-06-30', nombre: 'X', created_at: '2026-06-30T12:00:00Z',
});

describe('buildDupMap', () => {
  it('agrupa por teléfono normalizado', () => {
    const map = buildDupMap([ex('991234567', '500'), ex('991234567', '501'), ex('300555', '600')]);
    expect(map.get('991234567')!.map(o => o.external_id)).toEqual(['500', '501']);
    expect(map.get('300555')!.length).toBe(1);
  });
  it('ignora phone_norm vacío', () => {
    const map = buildDupMap([ex('', '999')]);
    expect(map.size).toBe(0);
  });
});

describe('dupMatchesFor', () => {
  const map = buildDupMap([ex('991234567', '500')]);
  it('normaliza el teléfono entrante antes de buscar (prefijo/espacios/0)', () => {
    expect(dupMatchesFor('+593 99 123 4567', map).map(o => o.external_id)).toEqual(['500']);
    expect(dupMatchesFor('0991234567', map).map(o => o.external_id)).toEqual(['500']);
  });
  it('sin match => []', () => {
    expect(dupMatchesFor('3009999999', map)).toEqual([]);
  });
  it('teléfono nulo/vacío => []', () => {
    expect(dupMatchesFor(null, map)).toEqual([]);
    expect(dupMatchesFor('', map)).toEqual([]);
  });
});

describe('isBlockedByDuplicate', () => {
  const map = buildDupMap([ex('991234567', '500')]);
  it('bloquea si hay match y no hay override', () => {
    expect(isBlockedByDuplicate({ id: 'a', phone: '991234567' }, map, new Set())).toBe(true);
  });
  it('NO bloquea si la asesora marcó "No es duplicado" (override por id)', () => {
    expect(isBlockedByDuplicate({ id: 'a', phone: '991234567' }, map, new Set(['a']))).toBe(false);
  });
  it('NO bloquea si no hay match de teléfono', () => {
    expect(isBlockedByDuplicate({ id: 'b', phone: '3001112222' }, map, new Set())).toBe(false);
  });
});

describe('uniquePhones', () => {
  it('normaliza y deduplica, descarta vacíos', () => {
    const out = uniquePhones([
      { phone: '+593 99 123 4567' },
      { phone: '0991234567' },     // mismo normalizado que el anterior
      { phone: '3001112222' },     // 10 dígitos → últimos 9 = '001112222'
      { phone: null },
      { phone: '' },
    ]);
    expect(out.sort()).toEqual(['001112222', '991234567'].sort());
  });
});

/**
 * ⛔ EL CASO DE COLOMBIA 2 (3-sep-2026). Dos guías con números consecutivos
 * para la misma clienta. Colombia 2 tiene el robot Shopify APAGADO, así que el
 * duplicado salió de "Subir todos": el filtro compara contra lo que YA está en
 * Dropi, y dos ventas nuevas del mismo teléfono no estaban ninguna.
 */
describe('los repetidos dentro del propio lote', () => {
  const p = (id: string, phone: string | null) => ({ id, phone });

  it('dos ventas con el mismo teléfono: sube la primera, la segunda espera', () => {
    const r = repetidosEnElLote([p('a', '3148664637'), p('b', '3148664637'), p('c', '3001112233')]);
    expect(r.has('a')).toBe(false);
    expect(r.has('b')).toBe(true);
    expect(r.has('c')).toBe(false);
  });

  it('compara por los últimos 9 dígitos: el indicativo no lo esconde', () => {
    expect(repetidosEnElLote([p('a', '+57 314 866 4637'), p('b', '3148664637')]).has('b')).toBe(true);
  });

  it('teléfonos distintos no se frenan entre sí', () => {
    expect(repetidosEnElLote([p('a', '3001112233'), p('b', '3009998877')]).size).toBe(0);
  });

  /** Sin teléfono no se puede afirmar que sean el mismo cliente. */
  it('sin teléfono no frena a nadie', () => {
    expect(repetidosEnElLote([p('a', null), p('b', ''), p('c', null)]).size).toBe(0);
  });

  /** La asesora miró los dos y decidió: el sistema no le discute. */
  it('"No es duplicado" manda: el pedido marcado no se frena', () => {
    const r = repetidosEnElLote([p('a', '3148664637'), p('b', '3148664637')], new Set(['b']));
    expect(r.has('b')).toBe(false);
  });

  /**
   * ⛔ EL OVERRIDE NO PUEDE DESARMAR EL CANDADO PARA EL OTRO. La primera
   * versión hacía `continue` ANTES de anotar el teléfono: con «No es duplicado»
   * puesto en A, B pasaba como «el primero de ese teléfono» y los DOS se
   * subían en el mismo lote — justo lo que este archivo existe para impedir.
   * Marcar A como legítimo no convierte a B en el primero.
   */
  it('con el primero overrideado, el segundo SIGUE frenado', () => {
    const r = repetidosEnElLote([p('a', '3148664637'), p('b', '3148664637')], new Set(['a']));
    expect(r.has('a')).toBe(false);
    expect(r.has('b')).toBe(true);
  });

  it('si los dos están overrideados, suben los dos: la asesora ya decidió', () => {
    const r = repetidosEnElLote([p('a', '3148664637'), p('b', '3148664637')], new Set(['a', 'b']));
    expect(r.size).toBe(0);
  });

  it('un lote vacío o de uno no frena nada', () => {
    expect(repetidosEnElLote([]).size).toBe(0);
    expect(repetidosEnElLote([p('a', '3148664637')]).size).toBe(0);
  });
});

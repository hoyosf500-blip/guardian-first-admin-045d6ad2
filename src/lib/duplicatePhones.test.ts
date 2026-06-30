import { describe, it, expect } from 'vitest';
import {
  buildDupMap, dupMatchesFor, isBlockedByDuplicate, uniquePhones,
  type ExistingOrder,
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

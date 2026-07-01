import { describe, it, expect } from 'vitest';
import { normalizeSearch, matchesQuery } from './textSearch';

describe('normalizeSearch', () => {
  it('quita acentos y baja a minúsculas', () => {
    expect(normalizeSearch('José PÉREZ')).toBe('jose perez');
    expect(normalizeSearch('  Bogotá  ')).toBe('bogota');
    expect(normalizeSearch('GUAYAQUIL')).toBe('guayaquil');
  });
});

describe('matchesQuery', () => {
  const parts = ['José Pérez', '3001112222', 'Bogotá', '#1442'];

  it('query vacía => true', () => {
    expect(matchesQuery(parts, '')).toBe(true);
    expect(matchesQuery(parts, '   ')).toBe(true);
  });
  it('matchea sin importar acentos', () => {
    expect(matchesQuery(parts, 'jose')).toBe(true);
    expect(matchesQuery(parts, 'perez')).toBe(true);
    expect(matchesQuery(parts, 'bogota')).toBe(true);
  });
  it('matchea por teléfono y por número de pedido', () => {
    expect(matchesQuery(parts, '30011')).toBe(true);
    expect(matchesQuery(parts, '1442')).toBe(true);
  });
  it('AND de tokens: todos deben aparecer', () => {
    expect(matchesQuery(parts, 'jose bogota')).toBe(true);
    expect(matchesQuery(parts, 'jose medellin')).toBe(false);
  });
  it('sin match => false', () => {
    expect(matchesQuery(parts, 'xyz')).toBe(false);
  });
  it('tolera null/undefined/number en las partes', () => {
    expect(matchesQuery([null, undefined, 28.98, 'Ana'], 'ana')).toBe(true);
    expect(matchesQuery([null, undefined, 28.98, 'Ana'], '28.98')).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import {
  itemKey,
  indexOfKey,
  nextUnmanagedKey,
  resolveFallbackIdx,
  type NavItem,
} from './callQueueNav';

// Helpers de construcción de cola mínima.
const ext = (externalId: string, result?: string): NavItem => ({ externalId, result });
const db = (dbId: string, result?: string): NavItem => ({ dbId, result });

describe('itemKey', () => {
  it('prioriza externalId sobre dbId', () => {
    expect(itemKey({ externalId: 'E1', dbId: 'D1' })).toBe('E1');
  });
  it('cae a dbId si no hay externalId', () => {
    expect(itemKey({ dbId: 'D1' })).toBe('D1');
  });
  it('devuelve null para undefined/null o sin ids', () => {
    expect(itemKey(undefined)).toBeNull();
    expect(itemKey(null)).toBeNull();
    expect(itemKey({})).toBeNull();
  });
});

describe('indexOfKey', () => {
  const items = [ext('A'), ext('B'), db('C')];
  it('encuentra por externalId', () => {
    expect(indexOfKey(items, 'B')).toBe(1);
  });
  it('encuentra por dbId cuando no hay externalId', () => {
    expect(indexOfKey(items, 'C')).toBe(2);
  });
  it('-1 si no está o key null', () => {
    expect(indexOfKey(items, 'Z')).toBe(-1);
    expect(indexOfKey(items, null)).toBe(-1);
  });
});

describe('nextUnmanagedKey', () => {
  it('devuelve el próximo sin gestionar después de fromIdx', () => {
    const items = [ext('A'), ext('B'), ext('C')];
    expect(nextUnmanagedKey(items, 0)).toBe('B');
  });
  it('salta los ya gestionados (result seteado)', () => {
    const items = [ext('A'), ext('B', 'conf'), ext('C', 'canc'), ext('D')];
    expect(nextUnmanagedKey(items, 0)).toBe('D');
  });
  it('null cuando no hay siguiente sin gestionar', () => {
    const items = [ext('A'), ext('B', 'conf')];
    expect(nextUnmanagedKey(items, 0)).toBeNull();
  });
  it('opera sobre la cola PASADA (sin stale): dos arrays distintos, dos resultados', () => {
    const fromIdx = 0;
    const stale = [ext('A'), ext('B'), ext('C')];
    const fresh = [ext('A'), ext('X'), ext('C')]; // B fue reemplazado por X
    expect(nextUnmanagedKey(stale, fromIdx)).toBe('B');
    expect(nextUnmanagedKey(fresh, fromIdx)).toBe('X');
  });
});

describe('resolveFallbackIdx', () => {
  it('cola vacía → 0', () => {
    expect(resolveFallbackIdx([], 5)).toBe(0);
  });
  it('desde lastGoodIdx a mitad, devuelve el vecino pendiente (NO el tope)', () => {
    // El pedido en idx 2 desapareció; lastGoodIdx=2 → el que ocupa ese lugar.
    const items = [ext('A'), ext('B'), ext('C'), ext('D')];
    expect(resolveFallbackIdx(items, 2)).toBe(2); // C, no 0
  });
  it('salta gestionados desde el anchor hacia adelante', () => {
    const items = [ext('A'), ext('B'), ext('C', 'conf'), ext('D')];
    expect(resolveFallbackIdx(items, 2)).toBe(3); // C gestionado → D
  });
  it('primer load (lastGoodIdx=0) → primer pendiente', () => {
    const items = [ext('A', 'conf'), ext('B'), ext('C')];
    expect(resolveFallbackIdx(items, 0)).toBe(1); // A gestionado → B
  });
  it('sin pendientes desde el anchor → primer pendiente global', () => {
    const items = [ext('A'), ext('B'), ext('C', 'conf'), ext('D', 'conf')];
    expect(resolveFallbackIdx(items, 3)).toBe(0); // desde 3 no hay → global A
  });
  it('todos gestionados → clamp del anchor', () => {
    const items = [ext('A', 'conf'), ext('B', 'conf')];
    expect(resolveFallbackIdx(items, 5)).toBe(1); // clamp a length-1
  });
  it('lastGoodIdx negativo se trata como 0', () => {
    const items = [ext('A'), ext('B')];
    expect(resolveFallbackIdx(items, -3)).toBe(0);
  });
});

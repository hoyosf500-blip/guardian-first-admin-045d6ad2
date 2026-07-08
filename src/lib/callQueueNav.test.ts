import { describe, it, expect } from 'vitest';
import {
  itemKey,
  indexOfKey,
  nextUnmanagedKey,
  resolveFallbackIdx,
  isLockedByOther,
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

describe('isLockedByOther', () => {
  const ME = 'me-uuid';
  const OTHER = 'other-uuid';
  // nowMs fijo para tests deterministas (Date.now() no se usa dentro del helper).
  const NOW = 1_700_000_000_000;
  const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

  it('libre (sin lockedBy) → false', () => {
    expect(isLockedByOther({ lockedBy: null, lockedAt: null }, ME, NOW)).toBe(false);
  });
  it('lockeado por MÍ → false (lo sigo viendo)', () => {
    expect(isLockedByOther({ lockedBy: ME, lockedAt: iso(60_000) }, ME, NOW)).toBe(false);
  });
  it('lockeado por OTRA, fresco (<15min) → true (se esconde)', () => {
    expect(isLockedByOther({ lockedBy: OTHER, lockedAt: iso(5 * 60_000) }, ME, NOW)).toBe(true);
  });
  it('lockeado por OTRA pero VIEJO (>15min) → false (lock caducó)', () => {
    expect(isLockedByOther({ lockedBy: OTHER, lockedAt: iso(16 * 60_000) }, ME, NOW)).toBe(false);
  });
  it('lockedBy presente pero lockedAt null → false (no se puede fechar el lock)', () => {
    expect(isLockedByOther({ lockedBy: OTHER, lockedAt: null }, ME, NOW)).toBe(false);
  });
  it('lockedAt malformado → false', () => {
    expect(isLockedByOther({ lockedBy: OTHER, lockedAt: 'no-es-fecha' }, ME, NOW)).toBe(false);
  });
  it('sin myUserId (null): un lock ajeno fresco se trata como ajeno → true', () => {
    expect(isLockedByOther({ lockedBy: OTHER, lockedAt: iso(60_000) }, null, NOW)).toBe(true);
  });
  it('exactamente en el borde de 15min → sigue vigente (true)', () => {
    expect(isLockedByOther({ lockedBy: OTHER, lockedAt: iso(15 * 60_000) }, ME, NOW)).toBe(true);
  });
});

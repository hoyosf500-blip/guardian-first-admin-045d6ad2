import { describe, it, expect } from 'vitest';
import { deriveStatus } from './useImporchatSyncHealth';

describe('deriveStatus — salud del sync de ImporChat', () => {
  it('sin corridas = never (gris, no verde)', () => {
    expect(deriveStatus(null)).toBe('never');
  });

  it('corrió hace poco y sin error = fresh', () => {
    expect(deriveStatus(1, 'success')).toBe('fresh');
    expect(deriveStatus(0.2, 'warn')).toBe('fresh'); // warn no es error
  });

  it('una corrida fallida manda sobre la frescura (aunque sea de hace 5 min)', () => {
    expect(deriveStatus(0.1, 'error')).toBe('failing');
  });

  it('3h a 12h sin correr = stale (amarillo)', () => {
    expect(deriveStatus(5, 'success')).toBe('stale');
  });

  it('más de 12h sin correr = critical (el inbound puede estar muerto)', () => {
    expect(deriveStatus(20, 'success')).toBe('critical');
  });
});

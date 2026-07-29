import { describe, it, expect } from 'vitest';
import { courierName } from './dropiCouriers';

describe('courierName', () => {
  it('Ecuador: IDs verificados', () => {
    expect(courierName('EC', 1)).toBe('LAARCOURIER');
    expect(courierName('EC', 2)).toBe('SERVIENTREGA');
    expect(courierName('EC', 3)).toBe('VELOCES');
    expect(courierName('EC', 4)).toBe('GINTRACOM');
  });

  it('ID desconocido → fallback honesto, no inventa un nombre', () => {
    expect(courierName('EC', 99)).toBe('Transportadora #99');
    expect(courierName('CO', 7)).toBe('Transportadora #7');
  });

  it('país nulo/raro cae a CO sin romper', () => {
    expect(courierName(null, 3)).toBe('Transportadora #3');
    expect(courierName('ec', 1)).toBe('LAARCOURIER'); // case-insensitive
  });
});

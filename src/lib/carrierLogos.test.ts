import { describe, it, expect } from 'vitest';
import { carrierLogo } from './carrierLogos';

describe('carrierLogo', () => {
  it('matchea las transportadoras EC con logo empaquetado', () => {
    expect(carrierLogo('LAARCOURIER')?.fit).toBe('wide');
    expect(carrierLogo('SERVIENTREGA')?.fit).toBe('contain');
    expect(carrierLogo('GINTRACOM')?.fit).toBe('cover');
  });

  it('matchea variantes de escritura (espacios, acentos, casing)', () => {
    expect(carrierLogo('Inter Rapidísimo')).not.toBeNull();
    expect(carrierLogo('servientrega ec')).not.toBeNull();
    expect(carrierLogo('Laar Courier')).not.toBeNull();
  });

  it('sin logo → null (VELOCES es interna de Dropi, fallback CO numerado)', () => {
    expect(carrierLogo('VELOCES')).toBeNull();
    expect(carrierLogo('Transportadora #7')).toBeNull();
    expect(carrierLogo('')).toBeNull();
    expect(carrierLogo(null)).toBeNull();
    expect(carrierLogo(undefined)).toBeNull();
  });

  it('todos los src son strings no vacíos (assets resueltos por el bundler)', () => {
    for (const name of ['SERVIENTREGA', 'LAARCOURIER', 'GINTRACOM', 'COORDINADORA', 'ENVIA', 'TCC', 'DOMINA', 'INTERRAPIDISIMO']) {
      const logo = carrierLogo(name);
      expect(logo, name).not.toBeNull();
      expect(typeof logo!.src).toBe('string');
      expect(logo!.src.length).toBeGreaterThan(0);
    }
  });
});

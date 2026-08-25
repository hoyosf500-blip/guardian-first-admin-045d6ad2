import { describe, it, expect } from 'vitest';
import { siguienteRacha, hitoDeRacha, RACHA_UMBRAL_SEG } from './rachaRapida';

const MIN = 60_000;

describe('siguienteRacha', () => {
  it('primera marca del turno → arranca en 1', () => {
    expect(siguienteRacha(0, null, 1000)).toBe(1);
  });
  it('hueco ≤ 3 min → sube la racha', () => {
    expect(siguienteRacha(5, 0, 2 * MIN)).toBe(6);
    expect(siguienteRacha(5, 0, RACHA_UMBRAL_SEG * 1000)).toBe(6); // justo 3 min cuenta
  });
  it('hueco > 3 min → se reinicia a 1', () => {
    expect(siguienteRacha(9, 0, 4 * MIN)).toBe(1);
  });
  it('reloj corrido (hueco negativo) → 1, sin premiar', () => {
    expect(siguienteRacha(9, 5 * MIN, 0)).toBe(1);
  });
});

describe('hitoDeRacha', () => {
  it('celebra múltiplos de 10', () => {
    expect(hitoDeRacha(10)).toContain('10');
    expect(hitoDeRacha(20)).toContain('20');
  });
  it('no celebra los demás', () => {
    expect(hitoDeRacha(0)).toBe('');
    expect(hitoDeRacha(7)).toBe('');
    expect(hitoDeRacha(11)).toBe('');
  });
});

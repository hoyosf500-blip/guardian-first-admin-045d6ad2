import { describe, it, expect } from 'vitest';
import { formatMMSS, seDemora, UMBRAL_PEDIDO_SEG } from './tiempoEnPedido';

describe('formatMMSS', () => {
  it('formatea segundos a M:SS', () => {
    expect(formatMMSS(0)).toBe('0:00');
    expect(formatMMSS(7)).toBe('0:07');
    expect(formatMMSS(154)).toBe('2:34');
    expect(formatMMSS(723)).toBe('12:03');
  });
  it('negativos → 0:00', () => {
    expect(formatMMSS(-5)).toBe('0:00');
  });
});

describe('seDemora', () => {
  it('bajo el umbral → false', () => {
    expect(seDemora(120)).toBe(false);
    expect(seDemora(UMBRAL_PEDIDO_SEG - 1)).toBe(false);
  });
  it('en o sobre el umbral → true', () => {
    expect(seDemora(UMBRAL_PEDIDO_SEG)).toBe(true);
    expect(seDemora(600)).toBe(true);
  });
  it('el umbral por defecto son 3 min', () => {
    expect(UMBRAL_PEDIDO_SEG).toBe(180);
  });
});

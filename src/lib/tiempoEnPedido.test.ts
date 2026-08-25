import { describe, it, expect } from 'vitest';
import { formatMMSS, seDemora, sobreOptimo, nivelTiempo, UMBRAL_PEDIDO_SEG, UMBRAL_OPTIMO_SEG } from './tiempoEnPedido';

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

describe('seDemora (alerta roja a los 5 min)', () => {
  it('bajo el umbral → false', () => {
    expect(seDemora(120)).toBe(false);
    expect(seDemora(UMBRAL_PEDIDO_SEG - 1)).toBe(false);
  });
  it('en o sobre el umbral → true', () => {
    expect(seDemora(UMBRAL_PEDIDO_SEG)).toBe(true);
    expect(seDemora(600)).toBe(true);
  });
  it('la alerta roja es a los 5 min', () => {
    expect(UMBRAL_PEDIDO_SEG).toBe(300);
  });
});

describe('óptimo (ámbar a los 3 min) y nivelTiempo', () => {
  it('el óptimo es 3 min', () => {
    expect(UMBRAL_OPTIMO_SEG).toBe(180);
  });
  it('sobreOptimo se pasa a los 3 min', () => {
    expect(sobreOptimo(179)).toBe(false);
    expect(sobreOptimo(180)).toBe(true);
  });
  it('nivelTiempo: ok <3min · optimo_pasado 3-5 · alerta 5+', () => {
    expect(nivelTiempo(0)).toBe('ok');
    expect(nivelTiempo(179)).toBe('ok');
    expect(nivelTiempo(180)).toBe('optimo_pasado');
    expect(nivelTiempo(299)).toBe('optimo_pasado');
    expect(nivelTiempo(300)).toBe('alerta');
    expect(nivelTiempo(600)).toBe('alerta');
  });
});

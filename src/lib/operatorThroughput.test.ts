import { describe, it, expect } from 'vitest';
import {
  gestionesPorHora,
  tiempoPorClienteSeg,
  densidadTurno,
  esMouseVivoNoProduce,
  ritmoEsJuzgable,
  ritmoTone,
  MIN_WORK_SECONDS_TO_JUDGE,
  MIN_GESTIONES_POR_HORA,
  MIN_INTENTOS_POR_HORA,
  UMBRAL_ACTIVA_FLAG_SEG,
  TIEMPO_CLIENTE_META_SEG,
} from './operatorThroughput';

describe('gestionesPorHora', () => {
  it('caza al presente-pero-improductivo: 12 gestiones en 6h = 2/hora', () => {
    expect(gestionesPorHora(12, 6 * 3600)).toBeCloseTo(2, 5);
  });
  it('buen ritmo: 60 gestiones en 4h = 15/hora', () => {
    expect(gestionesPorHora(60, 4 * 3600)).toBeCloseTo(15, 5);
  });
  it('< 30 min trabajado → null (muestra insuficiente, no juzgar)', () => {
    expect(gestionesPorHora(5, 20 * 60)).toBeNull();
    expect(gestionesPorHora(5, MIN_WORK_SECONDS_TO_JUDGE)).not.toBeNull();
  });
  it('dato faltante/invalido → null', () => {
    expect(gestionesPorHora(null, 3600)).toBeNull();
    expect(gestionesPorHora(10, null)).toBeNull();
    expect(gestionesPorHora(10, NaN)).toBeNull();
  });
});

describe('tiempoPorClienteSeg (inverso de gestionesPorHora)', () => {
  it('6h trabajadas ÷ 12 gestiones = 1800 s (30 min/cliente = lentísima)', () => {
    expect(tiempoPorClienteSeg(6 * 3600, 12)).toBe(1800);
  });
  it('umbral 10/hora ⟺ 360 s por cliente', () => {
    expect(TIEMPO_CLIENTE_META_SEG).toBe(360);
    // 3600/10 = 360; el inverso reconcilia con el ritmo
    expect(tiempoPorClienteSeg(3600, 10)).toBe(TIEMPO_CLIENTE_META_SEG);
  });
  it('sin gestiones → null (no divide por 0)', () => {
    expect(tiempoPorClienteSeg(3600, 0)).toBeNull();
    expect(tiempoPorClienteSeg(3600, null)).toBeNull();
  });
});

describe('densidadTurno', () => {
  it('trabajó 4h20 de un turno de 8h ≈ 0.54', () => {
    expect(densidadTurno((4 * 60 + 20) * 60, 8 * 3600)).toBeCloseTo(0.5417, 3);
  });
  it('clamp: worked > span → 1 (relojes desfasados, nunca > 100%)', () => {
    expect(densidadTurno(9 * 3600, 8 * 3600)).toBe(1);
  });
  it('span 0 o dato faltante → null', () => {
    expect(densidadTurno(3600, 0)).toBeNull();
    expect(densidadTurno(3600, null)).toBeNull();
  });
});

describe('esMouseVivoNoProduce', () => {
  it('mouse 6h activa pero 12 gestiones = 2/hora-mouse < 10 → 🚩 true', () => {
    expect(esMouseVivoNoProduce({ activeSeconds: 6 * 3600, atendidos: 12 })).toBe(true);
  });
  it('mouse 6h activa y 60 gestiones = 10/hora-mouse → false (produce)', () => {
    expect(esMouseVivoNoProduce({ activeSeconds: 6 * 3600, atendidos: 60 })).toBe(false);
  });
  it('mouse bajo (< 2h) → false aunque gestione poco (no molestar temprano)', () => {
    expect(esMouseVivoNoProduce({ activeSeconds: UMBRAL_ACTIVA_FLAG_SEG - 1, atendidos: 0 })).toBe(false);
  });
  it('dato faltante → false (sin evidencia no se acusa)', () => {
    expect(esMouseVivoNoProduce({ activeSeconds: null, atendidos: 12 })).toBe(false);
    expect(esMouseVivoNoProduce({ activeSeconds: 6 * 3600, atendidos: null })).toBe(false);
  });
  it('respeta umbral custom', () => {
    // 30 gestiones ÷ 6h-mouse = 5/hora-mouse. Con umbral 6 → 5 < 6 → 🚩 true.
    expect(esMouseVivoNoProduce({ activeSeconds: 6 * 3600, atendidos: 30, umbralGestionesHora: 6 })).toBe(true);
    // Con umbral 4 → 5 >= 4 → false.
    expect(esMouseVivoNoProduce({ activeSeconds: 6 * 3600, atendidos: 30, umbralGestionesHora: 4 })).toBe(false);
  });
});

describe('ritmoEsJuzgable / ritmoTone', () => {
  it('juzgable solo con 30 min+ de trabajo', () => {
    expect(ritmoEsJuzgable(20 * 60)).toBe(false);
    expect(ritmoEsJuzgable(MIN_WORK_SECONDS_TO_JUDGE)).toBe(true);
    expect(ritmoEsJuzgable(null)).toBe(false);
  });
  it('tono: rojo < umbral, ámbar cerca, verde ok', () => {
    expect(ritmoTone(2)).toBe('danger');
    expect(ritmoTone(MIN_GESTIONES_POR_HORA - 0.1)).toBe('danger');
    expect(ritmoTone(12)).toBe('warning');   // 10..15
    expect(ritmoTone(15)).toBe('success');
    expect(ritmoTone(null)).toBe('muted');
  });

  it('umbral de intentos (esfuerzo) = 10/hora — el 🔴 vive sobre marcadas, no clientes', () => {
    expect(MIN_INTENTOS_POR_HORA).toBe(10);
    // Día de muchos no-contesta: 40 intentos en 4h = 10/h → NO rojo (siguió marcando).
    expect(ritmoTone(gestionesPorHora(40, 4 * 3600), MIN_INTENTOS_POR_HORA)).not.toBe('danger');
    // Casi no marca: 20 intentos en 6h = 3.3/h → rojo.
    expect(ritmoTone(gestionesPorHora(20, 6 * 3600), MIN_INTENTOS_POR_HORA)).toBe('danger');
  });
});

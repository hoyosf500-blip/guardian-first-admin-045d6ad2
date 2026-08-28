import { describe, it, expect } from 'vitest';
import {
  pausaVigente, minutosDePausa, etiquetaMotivo, MOTIVOS_PAUSA, PAUSA_MAX_MS,
} from './pausaTrabajo';

const AHORA = Date.parse('2026-08-27T15:00:00-05:00');

describe('pausaVigente', () => {
  it('una pausa recién abierta cubre ahora', () => {
    expect(pausaVigente({ motivo: 'agencia', inicio: AHORA - 5 * 60_000 }, AHORA)).toBe(true);
  });

  it('una pausa cerrada NO cubre, por reciente que sea', () => {
    expect(pausaVigente(
      { motivo: 'agencia', inicio: AHORA - 60_000, fin: AHORA - 30_000 },
      AHORA,
    )).toBe(false);
  });

  it('⛔ pasado el tope deja de valer aunque nadie la haya cerrado', () => {
    // Es la defensa contra el escondite: lo más probable en una pausa de 3 h no
    // es una reunión de 3 h, es que se olvidaron de apagarla.
    expect(pausaVigente({ motivo: 'llamada', inicio: AHORA - PAUSA_MAX_MS - 1 }, AHORA)).toBe(false);
    expect(pausaVigente({ motivo: 'llamada', inicio: AHORA - PAUSA_MAX_MS + 1000 }, AHORA)).toBe(true);
  });

  it('sin pausa no hay excusa', () => {
    expect(pausaVigente(null, AHORA)).toBe(false);
    expect(pausaVigente(undefined, AHORA)).toBe(false);
  });

  it('una fecha corrupta no habilita la excusa (fail-closed)', () => {
    expect(pausaVigente({ motivo: 'otro', inicio: Number.NaN }, AHORA)).toBe(false);
  });
});

describe('minutosDePausa', () => {
  it('cuenta hasta ahora si sigue abierta', () => {
    expect(minutosDePausa({ motivo: 'agencia', inicio: AHORA - 12 * 60_000 }, AHORA)).toBe(12);
  });

  it('cuenta hasta el cierre si ya cerró — no sigue corriendo', () => {
    expect(minutosDePausa(
      { motivo: 'agencia', inicio: AHORA - 30 * 60_000, fin: AHORA - 20 * 60_000 },
      AHORA,
    )).toBe(10);
  });

  it('nunca da negativo aunque el reloj del cliente esté corrido', () => {
    expect(minutosDePausa({ motivo: 'otro', inicio: AHORA + 60_000 }, AHORA)).toBe(0);
  });
});

describe('etiquetaMotivo', () => {
  it('traduce los motivos conocidos', () => {
    expect(etiquetaMotivo('agencia')).toBe('Revisando guías en la agencia');
  });

  it('un motivo desconocido se muestra CRUDO, no cae a "Otra cosa"', () => {
    // Inventarle etiqueta escondería que hay un motivo que esta versión del
    // cliente no conoce (guardado por una versión más nueva).
    expect(etiquetaMotivo('capacitacion')).toBe('capacitacion');
  });

  it('vacío se dice, no se disfraza', () => {
    expect(etiquetaMotivo('')).toBe('Sin motivo');
    expect(etiquetaMotivo(null)).toBe('Sin motivo');
  });
});

describe('MOTIVOS_PAUSA', () => {
  it('ningún value se repite: son la clave del histórico', () => {
    const vals = MOTIVOS_PAUSA.map((m) => m.value);
    expect(new Set(vals).size).toBe(vals.length);
  });

  it('todos tienen etiqueta traducible', () => {
    for (const m of MOTIVOS_PAUSA) expect(etiquetaMotivo(m.value)).toBe(m.label);
  });
});

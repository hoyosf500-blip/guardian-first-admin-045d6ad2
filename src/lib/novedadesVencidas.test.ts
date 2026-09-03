import { describe, it, expect } from 'vitest';
import { contarNovedadesVencidas, HORAS_NOVEDAD_VENCIDA } from './novedadesVencidas';

const AHORA = Date.parse('2026-09-03T18:00:00.000Z');
const haceHoras = (h: number) => new Date(AHORA - h * 3_600_000).toISOString();

describe('las novedades que pasaron las 24 horas', () => {
  it('la vara es la que puso el dueño', () => {
    expect(HORAS_NOVEDAD_VENCIDA).toBe(24);
  });

  it('cuenta solo las que pasaron la vara', () => {
    const r = contarNovedadesVencidas(
      [{ lastMovementAt: haceHoras(30) }, { lastMovementAt: haceHoras(48) }, { lastMovementAt: haceHoras(2) }],
      AHORA,
    );
    expect(r).toBe(2);
  });

  it('sin novedades la respuesta es CERO, no "no sé": ese es el estado que se busca', () => {
    expect(contarNovedadesVencidas([], AHORA)).toBe(0);
    expect(contarNovedadesVencidas(null, AHORA)).toBe(0);
  });

  /**
   * ⛔ EL CORAZÓN DEL ARCHIVO. Sobre este número el dueño habla con una persona.
   * Una cola llena sin una sola fecha legible NO es "cero vencidas": es "no se
   * pudo medir". Afirmar el cero es la mentira que este proyecto ya pagó tres
   * veces.
   */
  it('con la cola llena y ninguna fecha legible NO afirma un cero', () => {
    expect(contarNovedadesVencidas([{ lastMovementAt: null }, {}], AHORA)).toBeNull();
    expect(contarNovedadesVencidas([{ lastMovementAt: 'no-es-fecha' }], AHORA)).toBeNull();
  });

  it('una fecha rota no tapa a las que sí se pueden medir', () => {
    const r = contarNovedadesVencidas(
      [{ lastMovementAt: 'roto' }, { lastMovementAt: haceHoras(30) }],
      AHORA,
    );
    expect(r).toBe(1);
  });

  it('justo en el borde de las 24 h ya cuenta', () => {
    expect(contarNovedadesVencidas([{ lastMovementAt: haceHoras(24) }], AHORA)).toBe(1);
    expect(contarNovedadesVencidas([{ lastMovementAt: haceHoras(23.9) }], AHORA)).toBe(0);
  });

  it('la vara se puede mover sin tocar el resto', () => {
    expect(contarNovedadesVencidas([{ lastMovementAt: haceHoras(10) }], AHORA, 6)).toBe(1);
  });
});

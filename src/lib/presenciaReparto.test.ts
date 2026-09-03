import { describe, it, expect } from 'vitest';
import { presentesActivos, MINUTOS_SIN_ACTIVIDAD } from './presenciaReparto';

const AHORA = Date.parse('2026-09-03T20:00:00.000Z');
const haceMin = (m: number) => new Date(AHORA - m * 60_000).toISOString();

const fila = (id: string, entradaMin: number, activaMin: number | null) => ({
  operator_id: id,
  first_action_at: haceMin(entradaMin),
  last_active_at: activaMin === null ? null : haceMin(activaMin),
});

describe('a quién se le puede asignar trabajo', () => {
  it('la que está trabajando ahora recibe', () => {
    const s = presentesActivos([fila('ana', 300, 2)], AHORA)!;
    expect(s.has('ana')).toBe(true);
  });

  /**
   * ⛔ EL CASO QUE ORIGINÓ ESTO. Marcó entrada a las 8, se fue a las 9 y no
   * volvió: hasta hoy seguía recibiendo un tercio de la cola a las 3 de la
   * tarde, y ese tercio no lo trabajaba nadie.
   */
  it('la que marcó entrada pero hace horas que no da señal, NO recibe', () => {
    const s = presentesActivos([fila('beto', 480, 300)], AHORA)!;
    expect(s.has('beto')).toBe(false);
  });

  it('el corte es a los 30 minutos', () => {
    const justoAntes = presentesActivos([fila('a', 300, MINUTOS_SIN_ACTIVIDAD - 1)], AHORA)!;
    const justoDespues = presentesActivos([fila('a', 300, MINUTOS_SIN_ACTIVIDAD + 1)], AHORA)!;
    expect(justoAntes.has('a')).toBe(true);
    expect(justoDespues.has('a')).toBe(false);
  });

  /**
   * Media hora y no seis minutos: quien está en una llamada larga con un
   * cliente difícil no puede dejar de recibir su parte de la cola justo por
   * estar haciendo bien su trabajo.
   */
  it('una llamada larga NO la saca del reparto', () => {
    const s = presentesActivos([fila('ana', 300, 25)], AHORA)!;
    expect(s.has('ana')).toBe(true);
  });

  it('sin marca de entrada no está en el turno', () => {
    const s = presentesActivos(
      [{ operator_id: 'x', first_action_at: null, last_active_at: haceMin(1) }],
      AHORA,
    )!;
    expect(s.has('x')).toBe(false);
  });

  /**
   * ⛔ Sin `last_active_at` NO se asume actividad. Antes la presencia solo
   * miraba la marca de entrada, y ése era el bug: dar por trabajando a quien
   * solo había abierto el CRM.
   */
  it('sin última señal legible no se asume que está activa', () => {
    for (const v of [null, 'no-es-una-fecha', '']) {
      const s = presentesActivos(
        [{ operator_id: 'x', first_action_at: haceMin(60), last_active_at: v }],
        AHORA,
      )!;
      expect(s.has('x'), `con last_active_at = ${JSON.stringify(v)}`).toBe(false);
    }
  });

  it('un reloj adelantado no descarta a quien acaba de marcar', () => {
    const s = presentesActivos([fila('a', 300, -2)], AHORA)!;
    expect(s.has('a')).toBe(true);
  });

  /**
   * ⛔ LA DISTINCIÓN QUE SOSTIENE TODO. «No se pudo leer» tiene que poder
   * separarse de «nadie está trabajando»: el primero obliga a repartir entre
   * todas (no dejar sin trabajo a quien sí vino), el segundo obliga a NO
   * repartir. Meterlos en la misma bolsa es lo que hacía el código viejo.
   */
  it('no se pudo leer devuelve null, nadie activo devuelve un conjunto vacío', () => {
    expect(presentesActivos(null, AHORA)).toBeNull();
    expect(presentesActivos(undefined, AHORA)).toBeNull();
    const vacio = presentesActivos([fila('beto', 480, 300)], AHORA);
    expect(vacio).not.toBeNull();
    expect(vacio!.size).toBe(0);
  });

  it('reparte solo entre las activas cuando hay de las dos', () => {
    const s = presentesActivos(
      [fila('ana', 300, 3), fila('beto', 480, 300), fila('cami', 200, 10)],
      AHORA,
    )!;
    expect([...s].sort()).toEqual(['ana', 'cami']);
  });
});

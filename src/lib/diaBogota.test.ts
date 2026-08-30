import { describe, it, expect, afterEach, vi } from 'vitest';
import { bogotaToday } from './utils';

/**
 * ⛔ GUARDIÁN — el día Bogotá calculado con DOBLE conversión de zona.
 *
 * El idiom que había en `useSegAsignaciones` y en el auto-reparto de
 * `SeguimientoTab` era:
 *
 *   new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }))
 *     .toISOString().slice(0, 10)
 *
 * `toLocaleString` devuelve el texto YA en Bogotá; `new Date(texto)` lo vuelve
 * a interpretar en la zona del NAVEGADOR y `toISOString()` lo pasa otra vez a
 * UTC. El desplazamiento se aplica DOS veces y solo se cancela antes de las
 * 19:00 — a partir de esa hora devuelve el día SIGUIENTE.
 *
 * Costó dos cosas distintas:
 *  - `useSegAsignaciones` pedía las asignaciones de mañana → «Solo las mías»
 *    vacío y el panel del turno con todas en 0 en las dos últimas horas del
 *    turno, que es cuando se cierra el día.
 *  - el auto-reparto sellaba en localStorage la llave de MAÑANA → desde el día
 *    siguiente el reparto quedaba apagado PARA SIEMPRE, sin ningún error.
 *
 * Estas pruebas fijan las horas donde el error aparece. Sin ellas el idiom
 * vuelve: es correcto durante el 80% de la jornada y por eso pasó la revisión.
 */
describe('⛔ día Bogotá: el idiom de doble conversión daba MAÑANA después de las 19:00', () => {
  afterEach(() => { vi.useRealTimers(); });

  /** El idiom viejo, tal cual estaba en el código. */
  const idiomRoto = () =>
    new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }))
      .toISOString().slice(0, 10);

  // 2026-08-30 en Bogotá (UTC-5) a las horas de la tabla, expresado en UTC.
  const enBogota = (hh: number, mm = 0) =>
    new Date(Date.UTC(2026, 7, 30, hh + 5, mm, 0));

  it.each([
    ['09:00', 9],
    ['13:30', 13],
    ['18:59', 18],
  ])('a las %s el día es el 30 (acá el idiom viejo también acertaba)', (_etiqueta, hora) => {
    vi.useFakeTimers();
    vi.setSystemTime(enBogota(hora, hora === 18 ? 59 : 0));
    expect(bogotaToday()).toBe('2026-08-30');
  });

  it.each([
    ['19:00', 19],
    ['21:00', 21],
    ['23:59', 23],
  ])('a las %s SIGUE siendo el 30 — el idiom viejo devolvía el 31', (_etiqueta, hora) => {
    vi.useFakeTimers();
    vi.setSystemTime(enBogota(hora, hora === 23 ? 59 : 0));
    expect(bogotaToday()).toBe('2026-08-30');
  });

  it('demuestra el error: con el navegador en Bogotá, a las 21:00 el idiom viejo adelanta un día', () => {
    // Solo corre donde el navegador de prueba está efectivamente en Bogotá
    // (o en cualquier zona con el mismo offset). En otra zona el idiom falla
    // en OTRA hora, que es justamente por qué no se puede confiar en él.
    const offsetLocal = -new Date(Date.UTC(2026, 7, 30, 2, 0, 0)).getTimezoneOffset() / 60;
    if (offsetLocal !== -5) return;
    vi.useFakeTimers();
    vi.setSystemTime(enBogota(21));
    expect(idiomRoto()).toBe('2026-08-31');   // ⛔ el bug
    expect(bogotaToday()).toBe('2026-08-30'); // ✔ lo correcto
  });
});

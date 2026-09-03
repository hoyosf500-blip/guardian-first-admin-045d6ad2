import { describe, it, expect } from 'vitest';
import { rangoDiaBogota, horaBogota, correrDia } from './diaBitacora';

describe('el día operativo de la bitácora', () => {
  it('va de las 05:00 UTC a las 05:00 UTC del día siguiente', () => {
    expect(rangoDiaBogota('2026-09-03')).toEqual({
      desdeIso: '2026-09-03T05:00:00.000Z',
      hastaIso: '2026-09-04T05:00:00.000Z',
    });
  });

  it('cruza bien el fin de mes y el fin de año', () => {
    expect(rangoDiaBogota('2026-08-31')?.hastaIso).toBe('2026-09-01T05:00:00.000Z');
    expect(rangoDiaBogota('2026-12-31')?.hastaIso).toBe('2027-01-01T05:00:00.000Z');
  });

  it('una fecha que no es una fecha devuelve null, no un día inventado', () => {
    expect(rangoDiaBogota('ayer')).toBeNull();
    expect(rangoDiaBogota('2026-9-3')).toBeNull();
    expect(rangoDiaBogota('')).toBeNull();
  });
});

/**
 * ⛔ EL BUG QUE YA APAGÓ EL AUTO-REPARTO. Convertir con
 * `new Date(x.toLocaleString('en-US', {timeZone}))` convierte DOS veces y
 * después de las 19:00 hora Bogotá devuelve MAÑANA. Estas pruebas fijan que
 * acá no pasa: un evento de las 23:40 de Bogotá tiene que caer en SU día.
 */
describe('la noche no se pasa al día siguiente', () => {
  it('23:40 de Bogotá (04:40 UTC del día siguiente) pertenece al día anterior', () => {
    const r = rangoDiaBogota('2026-09-03')!;
    const evento = Date.parse('2026-09-04T04:40:00.000Z'); // = 23:40 del 3 en Bogotá
    expect(evento).toBeGreaterThanOrEqual(Date.parse(r.desdeIso));
    expect(evento).toBeLessThan(Date.parse(r.hastaIso));
  });

  it('00:10 de Bogotá ya es el día nuevo', () => {
    const r = rangoDiaBogota('2026-09-04')!;
    const evento = Date.parse('2026-09-04T05:10:00.000Z'); // = 00:10 del 4 en Bogotá
    expect(evento).toBeGreaterThanOrEqual(Date.parse(r.desdeIso));
  });
});

describe('la hora que lee la asesora', () => {
  it('muestra la hora de Bogotá, no la UTC', () => {
    expect(horaBogota('2026-09-03T19:53:00.000Z')).toBe('14:53');
    expect(horaBogota('2026-09-04T04:40:00.000Z')).toBe('23:40');
  });

  it('una fecha rota no inventa una hora', () => {
    expect(horaBogota('vaya uno a saber')).toBe('--:--');
  });
});

describe('moverse de día', () => {
  it('ayer y mañana, cruzando meses', () => {
    expect(correrDia('2026-09-01', -1)).toBe('2026-08-31');
    expect(correrDia('2026-08-31', 1)).toBe('2026-09-01');
    expect(correrDia('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('una fecha rota se devuelve igual en vez de convertirse en otra', () => {
    expect(correrDia('ayer', -1)).toBe('ayer');
  });
});

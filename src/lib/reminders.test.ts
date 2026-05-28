import { describe, it, expect } from 'vitest';
import { isReminderDue, summarizeReminder } from './reminders';

// Punto de referencia fijo: jueves 2026-05-28, 3:00 pm en Bogota (UTC-5).
const NOW = new Date('2026-05-28T15:00:00-05:00');

describe('isReminderDue', () => {
  it('null/undefined/cadena vacía → false', () => {
    expect(isReminderDue(null, NOW)).toBe(false);
    expect(isReminderDue(undefined, NOW)).toBe(false);
    expect(isReminderDue('', NOW)).toBe(false);
  });

  it('fecha futura → false', () => {
    expect(isReminderDue('2026-05-28T16:00:00-05:00', NOW)).toBe(false);
  });

  it('fecha pasada → true', () => {
    expect(isReminderDue('2026-05-28T14:59:59-05:00', NOW)).toBe(true);
  });

  it('exactamente ahora → true (umbral inclusivo)', () => {
    expect(isReminderDue('2026-05-28T15:00:00-05:00', NOW)).toBe(true);
  });

  it('Date object también funciona', () => {
    expect(isReminderDue(new Date('2026-05-28T10:00:00-05:00'), NOW)).toBe(true);
    expect(isReminderDue(new Date('2026-05-28T20:00:00-05:00'), NOW)).toBe(false);
  });

  it('cadena inválida → false (no rompe la UI)', () => {
    expect(isReminderDue('not a date', NOW)).toBe(false);
  });
});

describe('summarizeReminder', () => {
  it('null → cadena vacía', () => {
    expect(summarizeReminder(null, NOW)).toBe('');
  });

  it('mismo día Bogota → "hoy <hora>"', () => {
    const r = summarizeReminder('2026-05-28T18:30:00-05:00', NOW);
    expect(r).toMatch(/^hoy /);
    // "6:30 p. m." en es-CO; aceptamos variantes con/sin puntos.
    expect(r).toMatch(/6:30 p/);
  });

  it('día siguiente → "mañana <hora>"', () => {
    const r = summarizeReminder('2026-05-29T10:00:00-05:00', NOW);
    expect(r).toMatch(/^mañana /);
    expect(r).toMatch(/10:00 a/);
  });

  it('otro día → "<dia> <num> <mes>, <hora>"', () => {
    const r = summarizeReminder('2026-05-30T15:00:00-05:00', NOW);
    expect(r).toMatch(/30 may/);
    expect(r).toMatch(/3:00 p/);
    // No empieza con "hoy" ni "mañana"
    expect(r).not.toMatch(/^hoy /);
    expect(r).not.toMatch(/^mañana /);
  });

  it('día anterior (recordatorio vencido) sigue formateando bien', () => {
    // Hoy 2026-05-28; un remind_at de ayer cae en "otro día".
    const r = summarizeReminder('2026-05-27T10:00:00-05:00', NOW);
    expect(r).toMatch(/27 may/);
    expect(r).toMatch(/10:00 a/);
  });
});

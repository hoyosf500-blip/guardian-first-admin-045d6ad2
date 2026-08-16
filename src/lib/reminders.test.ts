import { describe, it, expect } from 'vitest';
import { isReminderDue, summarizeReminder, REAGENDA_PRESETS, buildReagendaDate, proximaFechaDePago } from './reminders';

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

describe('presets de REAGENDA', () => {
  // Fechas construidas en hora LOCAL a propósito: los presets usan setHours,
  // igual que QUICK_REMINDERS de NotesPanel — un recordatorio "a las 9" tiene
  // que sonar a las 9 de la asesora, y CO/EC/GT no comparten offset.
  const local = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h);

  it('todos los presets caen a futuro y a las 9 de la mañana', () => {
    const ahora = local(2026, 8, 10, 14);
    for (const p of REAGENDA_PRESETS) {
      const d = p.build(ahora);
      expect(d.getTime(), p.key).toBeGreaterThan(ahora.getTime());
      expect(d.getHours(), p.key).toBe(9);
      expect(d.getMinutes(), p.key).toBe(0);
    }
  });

  it('las claves son únicas y buildReagendaDate las resuelve todas', () => {
    const keys = REAGENDA_PRESETS.map(p => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(buildReagendaDate(k, local(2026, 8, 10))).toBeInstanceOf(Date);
  });

  it('una clave inventada devuelve null en vez de una fecha basura', () => {
    // @ts-expect-error probamos a propósito una clave fuera del union
    expect(buildReagendaDate('no_existe', local(2026, 8, 10))).toBeNull();
  });

  it('"mañana" es el día siguiente', () => {
    const d = buildReagendaDate('manana', local(2026, 8, 10, 16))!;
    expect(d.getDate()).toBe(11);
    expect(d.getMonth()).toBe(7); // agosto
  });

  it('"mañana" cruza bien el fin de mes', () => {
    const d = buildReagendaDate('manana', local(2026, 8, 31, 16))!;
    expect(d.getDate()).toBe(1);
    expect(d.getMonth()).toBe(8); // septiembre
  });
});

describe('proximaFechaDePago — "cuando cobre"', () => {
  // Es el preset que más se va a usar: en COD "ahora no tengo plata" casi
  // siempre significa "hasta que cobre", y se cobra el 15 y el fin de mes.
  const local = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h);

  it('antes del 15 apunta al 15 de este mes', () => {
    const d = proximaFechaDePago(local(2026, 8, 3));
    expect(d.getDate()).toBe(15);
    expect(d.getMonth()).toBe(7);
    expect(d.getHours()).toBe(9);
  });

  it('el mismo día 15 NO agenda para hoy: salta al fin de mes', () => {
    // Un recordatorio para "hoy" no es un reagendamiento.
    const d = proximaFechaDePago(local(2026, 8, 15, 10));
    expect(d.getDate()).toBe(31);
    expect(d.getMonth()).toBe(7);
  });

  it('después del 15 apunta al último día del mes', () => {
    const d = proximaFechaDePago(local(2026, 8, 20));
    expect(d.getDate()).toBe(31);
  });

  it('el último día del mes salta al 15 del mes siguiente', () => {
    const d = proximaFechaDePago(local(2026, 8, 31, 18));
    expect(d.getDate()).toBe(15);
    expect(d.getMonth()).toBe(8); // septiembre
  });

  it('respeta los meses de 30 días', () => {
    const d = proximaFechaDePago(local(2026, 9, 20)); // septiembre
    expect(d.getDate()).toBe(30);
  });

  it('respeta febrero (28) y el febrero bisiesto (29)', () => {
    expect(proximaFechaDePago(local(2026, 2, 20)).getDate()).toBe(28);
    expect(proximaFechaDePago(local(2028, 2, 20)).getDate()).toBe(29);
  });

  it('cruza bien el fin de año', () => {
    const d = proximaFechaDePago(local(2026, 12, 31, 20));
    expect(d.getDate()).toBe(15);
    expect(d.getMonth()).toBe(0);   // enero
    expect(d.getFullYear()).toBe(2027);
  });

  it('siempre devuelve una fecha a futuro', () => {
    for (const dia of [1, 5, 14, 15, 16, 27, 28, 29, 30, 31]) {
      const ahora = local(2026, 8, Math.min(dia, 31), 23);
      expect(proximaFechaDePago(ahora).getTime()).toBeGreaterThan(ahora.getTime());
    }
  });
});

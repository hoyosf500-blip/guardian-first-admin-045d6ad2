import { describe, it, expect } from 'vitest';
import {
  attemptLabel,
  attemptTone,
  attemptClock,
  attemptDaySuffix,
  intentosDeHoy,
  esIntentoDeLlamada,
  type AttemptRow,
} from './attemptFormat';

describe('esIntentoDeLlamada — separa llamadas de toques de auditoría', () => {
  it('conf/canc/noresp son llamadas', () => {
    expect(esIntentoDeLlamada('conf')).toBe(true);
    expect(esIntentoDeLlamada('canc')).toBe(true);
    expect(esIntentoDeLlamada('noresp')).toBe(true);
  });
  it('ediciones y cambio de transportadora NO son llamadas', () => {
    // Es la regla que evita que "Intentos previos (5)" cuente 3 llamadas + 2
    // ediciones. El dueño se guía por ese número para saber si ya llamaron.
    expect(esIntentoDeLlamada('edicion_orden')).toBe(false);
    expect(esIntentoDeLlamada('edicion_completa')).toBe(false);
    expect(esIntentoDeLlamada('cambio_transportadora')).toBe(false);
    expect(esIntentoDeLlamada('reagendado')).toBe(false);
    expect(esIntentoDeLlamada('')).toBe(false);
  });
});

describe('attemptLabel', () => {
  it('mapea los resultados conocidos', () => {
    expect(attemptLabel('conf')).toBe('confirmó');
    expect(attemptLabel('canc')).toBe('canceló');
    expect(attemptLabel('noresp')).toBe('no contestó');
  });
  it('desconocido → devuelve el crudo o fallback', () => {
    expect(attemptLabel('otro')).toBe('otro');
    expect(attemptLabel('')).toBe('gestión');
  });
});

describe('attemptTone', () => {
  it('conf=green, canc=red, noresp=yellow, resto=muted', () => {
    expect(attemptTone('conf')).toBe('green');
    expect(attemptTone('canc')).toBe('red');
    expect(attemptTone('noresp')).toBe('yellow');
    expect(attemptTone('x')).toBe('muted');
  });
});

describe('attemptClock', () => {
  it('prefiere result_time HH:mm (recortado a 5)', () => {
    expect(attemptClock({ result: 'noresp', result_time: '14:30:05' })).toBe('14:30');
    expect(attemptClock({ result: 'noresp', result_time: '9:05' })).toBe('9:05');
  });
  it('result_time inválido → cae a created_at', () => {
    const row: AttemptRow = { result: 'conf', result_time: 'xx', created_at: '2026-07-07T19:30:00Z' };
    expect(attemptClock(row)).toMatch(/\d{2}:\d{2}/);
  });
  it('sin nada fechable → string vacío', () => {
    expect(attemptClock({ result: 'conf' })).toBe('');
    expect(attemptClock({ result: 'conf', created_at: 'no-fecha' })).toBe('');
  });
});

describe('attemptDaySuffix', () => {
  const TODAY = '2026-07-07';
  it('mismo día → vacío', () => {
    expect(attemptDaySuffix({ result: 'conf', result_date: '2026-07-07' }, TODAY)).toBe('');
  });
  it('día anterior → "ayer"', () => {
    expect(attemptDaySuffix({ result: 'conf', result_date: '2026-07-06' }, TODAY)).toBe('ayer');
  });
  it('varios días atrás → fecha corta', () => {
    expect(attemptDaySuffix({ result: 'conf', result_date: '2026-07-02' }, TODAY)).toBe('2 jul');
  });
  it('usa created_at si no hay result_date', () => {
    expect(attemptDaySuffix({ result: 'conf', created_at: '2026-07-06T10:00:00Z' }, TODAY)).toBe('ayer');
  });
  it('sin fecha → vacío', () => {
    expect(attemptDaySuffix({ result: 'conf' }, TODAY)).toBe('');
  });
});

describe('intentosDeHoy — "¿cuántas llamadas le quedan a este cliente hoy?"', () => {
  const HOY = '2026-07-31';

  it('cuenta solo las de HOY, no las de los 7 días', () => {
    expect(intentosDeHoy([
      { result: 'noresp', result_date: HOY },
      { result: 'noresp', result_date: HOY },
      { result: 'noresp', result_date: '2026-07-30' },
      { result: 'conf', result_date: '2026-07-29' },
    ], HOY)).toBe(2);
  });

  it('las filas de auditoría NO gastan intento', () => {
    // Editar el pedido o cambiarle la transportadora no es haber llamado: si
    // contaran, la pantalla diría "3 de 3" y la asesora dejaría de llamar a un
    // cliente al que nadie marcó.
    expect(intentosDeHoy([
      { result: 'edicion_orden', result_date: HOY },
      { result: 'cambio_transportadora', result_date: HOY },
      { result: 'noresp', result_date: HOY },
    ], HOY)).toBe(1);
  });

  it('usa created_at cuando no hay result_date', () => {
    expect(intentosDeHoy([{ result: 'conf', created_at: '2026-07-31T14:00:00Z' }], HOY)).toBe(1);
  });

  it('sin intentos devuelve 0', () => {
    expect(intentosDeHoy([], HOY)).toBe(0);
    expect(intentosDeHoy(null, HOY)).toBe(0);
    expect(intentosDeHoy(undefined, HOY)).toBe(0);
  });

  it('cuenta conf y canc además de noresp (todos gastan llamada)', () => {
    expect(intentosDeHoy([
      { result: 'noresp', result_date: HOY },
      { result: 'canc', result_date: HOY },
      { result: 'conf', result_date: HOY },
    ], HOY)).toBe(3);
  });
});

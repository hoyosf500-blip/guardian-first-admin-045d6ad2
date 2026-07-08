import { describe, it, expect } from 'vitest';
import {
  attemptLabel,
  attemptTone,
  attemptClock,
  attemptDaySuffix,
  type AttemptRow,
} from './attemptFormat';

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

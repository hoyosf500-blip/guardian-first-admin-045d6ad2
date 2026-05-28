import { describe, it, expect } from 'vitest';
import { formatDurationHM, formatTimeBogota } from './timeFormat';

describe('formatDurationHM', () => {
  it('null/undefined → "—"', () => {
    expect(formatDurationHM(null)).toBe('—');
    expect(formatDurationHM(undefined)).toBe('—');
  });
  it('0 → "—"', () => {
    expect(formatDurationHM(0)).toBe('—');
  });
  it('< 60s → "<1m"', () => {
    expect(formatDurationHM(1)).toBe('<1m');
    expect(formatDurationHM(59)).toBe('<1m');
  });
  it('60s → "1m"', () => {
    expect(formatDurationHM(60)).toBe('1m');
  });
  it('3599 → "59m"', () => {
    expect(formatDurationHM(3599)).toBe('59m');
  });
  it('3600 → "1h 0m"', () => {
    expect(formatDurationHM(3600)).toBe('1h 0m');
  });
  it('7320 → "2h 2m"', () => {
    expect(formatDurationHM(7320)).toBe('2h 2m');
  });
  it('NaN/negativo → "—"', () => {
    expect(formatDurationHM(NaN)).toBe('—');
    expect(formatDurationHM(-100)).toBe('—');
  });
});

describe('formatTimeBogota', () => {
  it('null/undefined/inválido → "—"', () => {
    expect(formatTimeBogota(null)).toBe('—');
    expect(formatTimeBogota(undefined)).toBe('—');
    expect(formatTimeBogota('not-a-date')).toBe('—');
  });
  it('ISO válido devuelve string no vacío con hora', () => {
    // 2026-05-28T13:34:00Z = 08:34 a. m. Bogotá (UTC-5)
    const out = formatTimeBogota('2026-05-28T13:34:00Z');
    // Acepta variantes "08:34 a. m." / "08:34 a.m." según ICU del entorno
    expect(out).toMatch(/08:34/);
    expect(out.toLowerCase()).toMatch(/a\.?\s?m\.?/);
  });
  it('medianoche Bogotá', () => {
    // 2026-05-28T05:00:00Z = 12:00 a. m. Bogotá
    const out = formatTimeBogota('2026-05-28T05:00:00Z');
    expect(out).toMatch(/12:00/);
  });
});

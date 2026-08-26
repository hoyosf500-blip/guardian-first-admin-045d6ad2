import { describe, it, expect } from 'vitest';
import {
  ritmoVivo, repartirPorHora, serieHoraria, entroTarde,
  RITMO_VIVO_META, RITMO_VIVO_ALERTA,
} from './ritmoEnVivo';

describe('ritmoVivo (vara estricta 25/15)', () => {
  const now = 1_700_000_000_000;
  it('sin primera marca → todo null (no inventa ritmo)', () => {
    const r = ritmoVivo({ gestionados: 0, desdeMs: null, nowMs: now });
    expect(r.porHora).toBeNull();
    expect(r.vaLento).toBe(false);
  });
  it('30/hora → verde (sobre el óptimo 25)', () => {
    // 30 gestiones en 60 min = 30/h
    const r = ritmoVivo({ gestionados: 30, desdeMs: now - 60 * 60_000, nowMs: now });
    expect(r.porHora).toBe(30);
    expect(r.vaLento).toBe(false);
    expect(r.bajoOptimo).toBe(false);
  });
  it('20/hora → ámbar (bajo el óptimo 25 pero sobre la alerta 15)', () => {
    const r = ritmoVivo({ gestionados: 20, desdeMs: now - 60 * 60_000, nowMs: now });
    expect(r.porHora).toBe(20);
    expect(r.bajoOptimo).toBe(true);
    expect(r.vaLento).toBe(false);
  });
  it('12/hora → rojo (bajo la alerta 15) — con 20/12 esto NO sería rojo', () => {
    const r = ritmoVivo({ gestionados: 12, desdeMs: now - 60 * 60_000, nowMs: now });
    expect(r.porHora).toBe(12);
    expect(r.vaLento).toBe(true);
  });
  it('umbrales del dueño', () => {
    expect(RITMO_VIVO_META).toBe(25);
    expect(RITMO_VIVO_ALERTA).toBe(15);
  });
});

describe('repartirPorHora', () => {
  it('cuenta por hora y ordena', () => {
    expect(repartirPorHora([9, 9, 10, 9, 11, 10])).toEqual([
      { hora: 9, cantidad: 3 },
      { hora: 10, cantidad: 2 },
      { hora: 11, cantidad: 1 },
    ]);
  });
  it('descarta horas fuera de rango sin reventar', () => {
    expect(repartirPorHora([9, -1, 24, 9])).toEqual([{ hora: 9, cantidad: 2 }]);
  });
  it('vacío → []', () => {
    expect(repartirPorHora([])).toEqual([]);
  });
});

describe('serieHoraria (rellena 0 en horas vacías)', () => {
  it('densa entre desde y hasta', () => {
    const buckets = [{ hora: 9, cantidad: 3 }, { hora: 11, cantidad: 1 }];
    expect(serieHoraria(buckets, 9, 12)).toEqual([
      { hora: 9, cantidad: 3 },
      { hora: 10, cantidad: 0 },
      { hora: 11, cantidad: 1 },
      { hora: 12, cantidad: 0 },
    ]);
  });
  it('clampa a 0-23 y no explota si hasta < desde', () => {
    expect(serieHoraria([], 20, 5)).toEqual([{ hora: 20, cantidad: 0 }]);
  });
});

describe('entroTarde', () => {
  const inicio = 8 * 3600; // 08:00
  it('a las 08:05 con gracia 10 min → NO tarde', () => {
    expect(entroTarde(8 * 3600 + 5 * 60, inicio, 600)).toBe(false);
  });
  it('a las 08:30 → tarde', () => {
    expect(entroTarde(8 * 3600 + 30 * 60, inicio, 600)).toBe(true);
  });
  it('sin señal → no acusa', () => {
    expect(entroTarde(null, inicio)).toBe(false);
  });
});

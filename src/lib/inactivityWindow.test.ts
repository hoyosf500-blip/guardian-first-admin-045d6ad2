import { describe, it, expect } from 'vitest';
import {
  isWithinAlertWindow,
  workingSecondsLost,
  bogotaMinutesOfDay,
  formatLostTime,
  scheduleFromMinutes,
  DEFAULT_SCHEDULE,
} from './inactivityWindow';

// Bogotá = UTC-5 (sin DST). Una hora wall-clock Bogotá T equivale a UTC T+5.
// Helper: construye un instante a partir de hora Bogotá del 2026-06-26.
const bog = (hh: number, mm = 0, day = 26) =>
  new Date(Date.UTC(2026, 5, day, hh + 5, mm, 0));
// Con segundos, para probar la precisión del umbral.
const bogS = (hh: number, mm: number, ss: number, day = 26) =>
  new Date(Date.UTC(2026, 5, day, hh + 5, mm, ss));

describe('bogotaMinutesOfDay', () => {
  it('convierte a minuto-del-día en hora Bogotá', () => {
    expect(bogotaMinutesOfDay(bog(9, 0))).toBe(540);
    expect(bogotaMinutesOfDay(bog(12, 30))).toBe(750);
    expect(bogotaMinutesOfDay(bog(0, 0))).toBe(0);
  });
});

describe('isWithinAlertWindow', () => {
  it('dentro del horario laboral (9–17) → true', () => {
    expect(isWithinAlertWindow(bog(9, 0))).toBe(true);   // borde inicio inclusivo
    expect(isWithinAlertWindow(bog(10, 0))).toBe(true);
    expect(isWithinAlertWindow(bog(16, 59))).toBe(true);
  });

  it('antes de las 9 o desde las 17 → false (no molestar)', () => {
    expect(isWithinAlertWindow(bog(8, 59))).toBe(false);
    expect(isWithinAlertWindow(bog(17, 0))).toBe(false);  // borde fin exclusivo
    expect(isWithinAlertWindow(bog(17, 30))).toBe(false);
  });

  it('durante el almuerzo (12:30–13:30) → false', () => {
    expect(isWithinAlertWindow(bog(12, 30))).toBe(false); // inicio almuerzo inclusivo
    expect(isWithinAlertWindow(bog(12, 45))).toBe(false);
    expect(isWithinAlertWindow(bog(13, 29))).toBe(false);
    expect(isWithinAlertWindow(bog(13, 30))).toBe(true);  // fin almuerzo → vuelve a contar
  });
});

describe('workingSecondsLost', () => {
  it('idle simple dentro de la jornada', () => {
    expect(workingSecondsLost(bog(10, 0), bog(10, 6))).toBe(6 * 60);
    expect(workingSecondsLost(bog(10, 0), bog(10, 3))).toBe(3 * 60); // < umbral, pero la fn igual lo calcula
  });

  it('excluye el almuerzo del tiempo perdido', () => {
    // 12:00 → 13:45 = 105 min reales, menos 60 min de almuerzo (12:30–13:30) = 45 min
    expect(workingSecondsLost(bog(12, 0), bog(13, 45))).toBe(45 * 60);
  });

  it('recorta lo que cae antes de las 9 o desde las 17', () => {
    expect(workingSecondsLost(bog(8, 0), bog(9, 10))).toBe(10 * 60);   // solo 9:00–9:10
    expect(workingSecondsLost(bog(16, 50), bog(17, 40))).toBe(10 * 60); // solo 16:50–17:00
    expect(workingSecondsLost(bog(17, 10), bog(17, 40))).toBe(0);       // todo después de las 17
    expect(workingSecondsLost(bog(8, 0), bog(8, 50))).toBe(0);          // todo antes de las 9
  });

  it('cruce de día (Bogotá) → 0 (no es inactividad de jornada)', () => {
    expect(workingSecondsLost(bog(16, 59, 26), bog(9, 5, 27))).toBe(0);
  });

  it('precisión de SEGUNDOS: 10:04:59 → 10:09:01 son 242 s (NO 5 min)', () => {
    // Antes (precisión de minuto) esto daba 5 min = 300 s y disparaba falso.
    expect(workingSecondsLost(bogS(10, 4, 59), bogS(10, 9, 1))).toBe(242);
  });
});

describe('horario configurable por tienda', () => {
  // Turno nocturno 14:00–22:00 con almuerzo/cena 18:00–19:00.
  const noche = scheduleFromMinutes({
    work_start_min: 14 * 60,
    work_end_min: 22 * 60,
    lunch_start_min: 18 * 60,
    lunch_end_min: 19 * 60,
  });

  it('scheduleFromMinutes convierte minutos → segundos', () => {
    expect(noche).toEqual({
      workStartSec: 14 * 3600,
      workEndSec: 22 * 3600,
      lunchStartSec: 18 * 3600,
      lunchEndSec: 19 * 3600,
    });
  });

  it('DEFAULT_SCHEDULE = 9–17 / 12:30–13:30 (histórico)', () => {
    expect(DEFAULT_SCHEDULE).toEqual({
      workStartSec: 9 * 3600,
      workEndSec: 17 * 3600,
      lunchStartSec: 12 * 3600 + 30 * 60,
      lunchEndSec: 13 * 3600 + 30 * 60,
    });
  });

  it('con horario nocturno, las 8 p. m. cuentan y las 10 a. m. NO', () => {
    expect(isWithinAlertWindow(bog(20, 0), noche)).toBe(true);   // dentro del turno noche
    expect(isWithinAlertWindow(bog(10, 0), noche)).toBe(false);  // fuera (era laboral con 9–17)
    expect(isWithinAlertWindow(bog(18, 30), noche)).toBe(false); // cena excluida
  });

  it('tiempo perdido se mide contra el horario de la tienda, no contra 9–17', () => {
    // 19:00 → 20:10 dentro del turno noche = 70 min; con el default (fin 17) daría 0.
    expect(workingSecondsLost(bog(19, 0), bog(20, 10), noche)).toBe(70 * 60);
    expect(workingSecondsLost(bog(19, 0), bog(20, 10))).toBe(0); // default 9–17
  });
});

describe('formatLostTime', () => {
  it('formatea minutos/segundos', () => {
    expect(formatLostTime(45)).toBe('45 segundos');
    expect(formatLostTime(60)).toBe('1 minuto');
    expect(formatLostTime(12 * 60)).toBe('12 minutos');
    expect(formatLostTime(6 * 60 + 30)).toBe('6 min 30 s');
  });
});

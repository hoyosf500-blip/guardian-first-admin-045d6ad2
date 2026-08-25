import { describe, it, expect } from 'vitest';
import { minutosSinGestion, mayorHuecoMin, mayorHuecoEntreBloques, debeAvisarSinGestion, UMBRAL_SIN_GESTION_MIN } from './huecosGestion';

// Helper: hora Bogotá (UTC-5) → ms. 10:00 Bogotá = 15:00 UTC.
const bog = (hhmm: string) => Date.parse(`2026-08-25T${String(Number(hhmm.slice(0, 2)) + 5).padStart(2, '0')}:${hhmm.slice(3)}:00Z`);

describe('minutosSinGestion', () => {
  it('cuenta los minutos laborales desde la última marca', () => {
    expect(minutosSinGestion(bog('10:00'), bog('10:25'))).toBe(25);
  });
  it('null si nunca marcó', () => {
    expect(minutosSinGestion(null, bog('10:25'))).toBeNull();
  });
  it('descuenta el almuerzo (12:30–13:30)', () => {
    // 12:20 → 13:40 = 80 min de reloj, pero el almuerzo (60 min) no cuenta → 20.
    expect(minutosSinGestion(bog('12:20'), bog('13:40'))).toBe(20);
  });
  it('marca de otro día → 0 (no es un hueco, es día nuevo)', () => {
    const ayer = Date.parse('2026-08-24T20:00:00Z');
    expect(minutosSinGestion(ayer, bog('10:00'))).toBe(0);
  });
});

describe('mayorHuecoMin', () => {
  it('el mayor hueco entre marcas consecutivas', () => {
    expect(mayorHuecoMin([bog('10:00'), bog('10:05'), bog('10:35')])).toBe(30);
  });
  it('desordenadas: igual encuentra el mayor', () => {
    expect(mayorHuecoMin([bog('10:35'), bog('10:00'), bog('10:05')])).toBe(30);
  });
  it('menos de 2 marcas → null', () => {
    expect(mayorHuecoMin([bog('10:00')])).toBeNull();
    expect(mayorHuecoMin([])).toBeNull();
  });
});

describe('mayorHuecoEntreBloques', () => {
  it('el mayor hueco entre el fin de un bloque y el inicio del siguiente', () => {
    // bloque 10:00-10:10, hueco 25min, bloque 10:35-10:45, hueco 15min, bloque 11:00-11:10
    const bloques = [
      { startMs: bog('10:00'), endMs: bog('10:10') },
      { startMs: bog('10:35'), endMs: bog('10:45') },
      { startMs: bog('11:00'), endMs: bog('11:10') },
    ];
    expect(mayorHuecoEntreBloques(bloques)).toBe(25);
  });
  it('menos de 2 bloques → null', () => {
    expect(mayorHuecoEntreBloques([{ startMs: bog('10:00'), endMs: bog('10:10') }])).toBeNull();
    expect(mayorHuecoEntreBloques([])).toBeNull();
  });
});

describe('debeAvisarSinGestion', () => {
  const base = { hayTrabajo: true, ultimoAvisoMs: null as number | null };
  it('avisa a los 20 min sin marcar, en horario, con trabajo', () => {
    expect(debeAvisarSinGestion({ ...base, lastMarkMs: bog('10:00'), nowMs: bog('10:20') })).toBe(true);
  });
  it('NO avisa a los 15 min (bajo el umbral)', () => {
    expect(debeAvisarSinGestion({ ...base, lastMarkMs: bog('10:00'), nowMs: bog('10:15') })).toBe(false);
  });
  it('NO avisa si no hay trabajo pendiente', () => {
    expect(debeAvisarSinGestion({ ...base, hayTrabajo: false, lastMarkMs: bog('10:00'), nowMs: bog('10:30') })).toBe(false);
  });
  it('NO avisa fuera de horario (08:00)', () => {
    expect(debeAvisarSinGestion({ ...base, lastMarkMs: bog('07:40'), nowMs: bog('08:10') })).toBe(false);
  });
  it('NO avisa si nunca marcó (lastMark null)', () => {
    expect(debeAvisarSinGestion({ ...base, lastMarkMs: null, nowMs: bog('10:30') })).toBe(false);
  });
  it('no repite el aviso antes de otro ciclo de umbral', () => {
    // Avisó hace 15 min (< 20) → todavía no repite, aunque el hueco ya sea largo.
    expect(debeAvisarSinGestion({
      ...base, lastMarkMs: bog('09:50'), nowMs: bog('10:25'), ultimoAvisoMs: bog('10:10'),
    })).toBe(false);
  });
  it('el umbral por defecto son 20 min', () => {
    expect(UMBRAL_SIN_GESTION_MIN).toBe(20);
  });
});

import { describe, it, expect } from 'vitest';
import {
  computeJornadaReal,
  shouldAlertSinConfirmar,
  asWorkedBlocks,
  sumWorkedSeconds,
  blockRangeLabel,
  computeEnSuPuestoSec,
  UMBRAL_HUECO_MIN,
  UMBRAL_DESCONECTADA_MIN,
  UMBRAL_SIN_CONF_MIN,
} from './jornadaMath';
import { DEFAULT_SCHEDULE } from './inactivityWindow';

// Timestamps del caso REAL de producción (2026-07-01): empezó 7:27 Bogotá,
// última actividad 9:07 → 100 min transcurridos, heartbeat solo 42 min.
const STARTED = '2026-07-01T12:27:00Z'; // 7:27 a. m. Bogotá
const LAST = '2026-07-01T14:07:00Z';    // 9:07 a. m. Bogotá
const NOW = Date.parse('2026-07-01T14:22:00Z'); // 15 min después de LAST

describe('computeJornadaReal', () => {
  it('caso producción: 100 min de ventana, 42 min de heartbeat → hueco 58 y % real 41 (no 98)', () => {
    // active 41m + idle 1m = 42m de heartbeat. El % viejo daba 2460/2520 ≈ 98%.
    const j = computeJornadaReal({
      startedAt: STARTED,
      lastActivityAt: LAST,
      activeSeconds: 2460,
      idleSeconds: 60,
      nowMs: NOW,
    });
    expect(j.elapsedMin).toBe(100);
    expect(j.activoMin).toBe(41);
    expect(j.inactivoMin).toBe(1);
    expect(j.huecoMin).toBe(58);
    expect(j.pctActivaReal).toBeCloseTo(0.41, 2);
    expect(j.desconectadaMin).toBe(15);
  });

  it('sin hueco: heartbeat cubre toda la ventana → hueco 0 y % real = % viejo', () => {
    const j = computeJornadaReal({
      startedAt: STARTED,
      lastActivityAt: LAST,
      activeSeconds: 4800, // 80m
      idleSeconds: 1200,   // 20m
      nowMs: NOW,
    });
    expect(j.elapsedMin).toBe(100);
    expect(j.huecoMin).toBe(0);
    expect(j.pctActivaReal).toBeCloseTo(0.8, 5);
  });

  it('startedAt null → campos de ventana null, pero desconectadaMin sigue saliendo', () => {
    const j = computeJornadaReal({
      startedAt: null,
      lastActivityAt: LAST,
      activeSeconds: 600,
      idleSeconds: 60,
      nowMs: NOW,
    });
    expect(j.elapsedMin).toBeNull();
    expect(j.huecoMin).toBeNull();
    expect(j.pctActivaReal).toBeNull();
    expect(j.activoMin).toBe(10);
    expect(j.desconectadaMin).toBe(15);
  });

  it('lastActivityAt null/inválido → ventana y desconectada null', () => {
    for (const last of [null, undefined, 'not-a-date'] as const) {
      const j = computeJornadaReal({
        startedAt: STARTED,
        lastActivityAt: last,
        activeSeconds: 600,
        idleSeconds: 0,
        nowMs: NOW,
      });
      expect(j.elapsedMin).toBeNull();
      expect(j.huecoMin).toBeNull();
      expect(j.pctActivaReal).toBeNull();
      expect(j.desconectadaMin).toBeNull();
    }
  });

  it('last < started (dato corrupto) → clamp: ventana = heartbeat, hueco 0, nunca negativo', () => {
    const j = computeJornadaReal({
      startedAt: LAST,        // invertidos a propósito
      lastActivityAt: STARTED,
      activeSeconds: 1800,    // 30m
      idleSeconds: 600,       // 10m
      nowMs: NOW,
    });
    expect(j.elapsedMin).toBe(40);           // clampeado a activo+inactivo
    expect(j.huecoMin).toBe(0);              // jamás negativo
    expect(j.pctActivaReal).toBeCloseTo(0.75, 5); // 30/40
  });

  it('activo+inactivo > ventana → clamp: hueco 0 y pct <= 1', () => {
    // Ventana real de 10 min pero heartbeat reporta 30 min (relojes desfasados).
    const j = computeJornadaReal({
      startedAt: '2026-07-01T12:00:00Z',
      lastActivityAt: '2026-07-01T12:10:00Z',
      activeSeconds: 1800,
      idleSeconds: 0,
      nowMs: NOW,
    });
    expect(j.elapsedMin).toBe(30);
    expect(j.huecoMin).toBe(0);
    expect(j.pctActivaReal).toBe(1);
  });

  it('día vacío: started === last y heartbeat 0 → ventana 0, pct 0 (no NaN)', () => {
    const j = computeJornadaReal({
      startedAt: STARTED,
      lastActivityAt: STARTED,
      activeSeconds: 0,
      idleSeconds: 0,
      nowMs: NOW,
    });
    expect(j.elapsedMin).toBe(0);
    expect(j.huecoMin).toBe(0);
    expect(j.pctActivaReal).toBe(0);
  });

  it('segundos null/NaN/negativos → activo/inactivo null o 0, sin romper la ventana', () => {
    const j = computeJornadaReal({
      startedAt: STARTED,
      lastActivityAt: LAST,
      activeSeconds: null,
      idleSeconds: NaN,
      nowMs: NOW,
    });
    expect(j.activoMin).toBeNull();
    expect(j.inactivoMin).toBeNull();
    // Heartbeat faltante se trata como 0 → toda la ventana es hueco.
    expect(j.huecoMin).toBe(100);
    expect(j.pctActivaReal).toBe(0);

    const neg = computeJornadaReal({
      startedAt: STARTED,
      lastActivityAt: LAST,
      activeSeconds: -300,
      idleSeconds: -1,
      nowMs: NOW,
    });
    expect(neg.activoMin).toBe(0);
    expect(neg.inactivoMin).toBe(0);
    expect(neg.huecoMin).toBe(100);
  });

  it('nowMs anterior a la última actividad → desconectadaMin clamp a 0', () => {
    const j = computeJornadaReal({
      startedAt: STARTED,
      lastActivityAt: LAST,
      activeSeconds: 600,
      idleSeconds: 0,
      nowMs: Date.parse(STARTED), // "ahora" antes de la última actividad
    });
    expect(j.desconectadaMin).toBe(0);
  });
});

describe('shouldAlertSinConfirmar', () => {
  const base = {
    conf: 0,
    entrantes: 20,
    pendientesSinTocar: 0,
    startedAt: STARTED,
  };

  it('conf=0 + entrantes>0 + 3h de jornada → true', () => {
    const now = Date.parse(STARTED) + 3 * 60 * 60 * 1000;
    expect(shouldAlertSinConfirmar({ ...base, nowMs: now })).toBe(true);
  });

  it('conf>0 → false aunque haya cola y horas', () => {
    const now = Date.parse(STARTED) + 5 * 60 * 60 * 1000;
    expect(shouldAlertSinConfirmar({ ...base, conf: 1, nowMs: now })).toBe(false);
  });

  it('conf null/undefined (dato faltante) → false, no alertar sin evidencia', () => {
    const now = Date.parse(STARTED) + 5 * 60 * 60 * 1000;
    expect(shouldAlertSinConfirmar({ ...base, conf: null, nowMs: now })).toBe(false);
    expect(shouldAlertSinConfirmar({ ...base, conf: undefined, nowMs: now })).toBe(false);
  });

  it('startedAt null o inválido → false (sin dato de actividad no se alerta)', () => {
    const now = Date.parse(STARTED) + 5 * 60 * 60 * 1000;
    expect(shouldAlertSinConfirmar({ ...base, startedAt: null, nowMs: now })).toBe(false);
    expect(shouldAlertSinConfirmar({ ...base, startedAt: 'garbage', nowMs: now })).toBe(false);
  });

  it('lleva menos del umbral (120 min default) → false; justo en el umbral → true', () => {
    const started = Date.parse(STARTED);
    expect(shouldAlertSinConfirmar({ ...base, nowMs: started + 119 * 60 * 1000 })).toBe(false);
    expect(shouldAlertSinConfirmar({ ...base, nowMs: started + UMBRAL_SIN_CONF_MIN * 60 * 1000 })).toBe(true);
  });

  it('sin cola (entrantes=0 y pendientes=0) → false', () => {
    const now = Date.parse(STARTED) + 5 * 60 * 60 * 1000;
    expect(shouldAlertSinConfirmar({ ...base, entrantes: 0, pendientesSinTocar: 0, nowMs: now })).toBe(false);
    expect(shouldAlertSinConfirmar({ ...base, entrantes: null, pendientesSinTocar: undefined, nowMs: now })).toBe(false);
  });

  it('pendientesSinTocar>0 alcanza aunque entrantes sea 0', () => {
    const now = Date.parse(STARTED) + 5 * 60 * 60 * 1000;
    expect(shouldAlertSinConfirmar({ ...base, entrantes: 0, pendientesSinTocar: 3, nowMs: now })).toBe(true);
  });

  it('umbralMin custom se respeta', () => {
    const started = Date.parse(STARTED);
    expect(shouldAlertSinConfirmar({ ...base, umbralMin: 30, nowMs: started + 31 * 60 * 1000 })).toBe(true);
    expect(shouldAlertSinConfirmar({ ...base, umbralMin: 30, nowMs: started + 29 * 60 * 1000 })).toBe(false);
  });
});

describe('worked blocks (horas reales por evidencia)', () => {
  const B1 = { start: '2026-07-03T14:12:00Z', end: '2026-07-03T18:40:00Z', events: 22, sec: 16080 };
  const B2 = { start: '2026-07-03T23:30:00Z', end: '2026-07-04T01:18:00Z', events: 9, sec: 6480 };

  it('asWorkedBlocks: array válido pasa tal cual', () => {
    expect(asWorkedBlocks([B1, B2])).toEqual([B1, B2]);
  });

  it('asWorkedBlocks: null/undefined/no-array → [] (migration no aplicada, sin romper)', () => {
    expect(asWorkedBlocks(null)).toEqual([]);
    expect(asWorkedBlocks(undefined)).toEqual([]);
    expect(asWorkedBlocks('nope')).toEqual([]);
    expect(asWorkedBlocks({})).toEqual([]);
  });

  it('asWorkedBlocks: filtra entradas con shape inválida, conserva las buenas', () => {
    const mixed = [
      B1,
      { start: 'x' },                                   // faltan campos
      { start: 1, end: 2, events: 3, sec: 4 },          // tipos malos
      { start: 'a', end: 'b', events: NaN, sec: 5 },    // NaN
      B2,
    ];
    expect(asWorkedBlocks(mixed)).toEqual([B1, B2]);
  });

  it('sumWorkedSeconds: suma segundos e ignora negativos', () => {
    expect(sumWorkedSeconds([B1, B2])).toBe(22560);
    expect(sumWorkedSeconds([])).toBe(0);
    expect(sumWorkedSeconds([{ ...B1, sec: -100 }])).toBe(0);
  });

  it('blockRangeLabel: usa el formateador inyectado y une con " · "', () => {
    const fmt = (iso: string) => iso.slice(11, 16); // HH:MM del ISO (determinístico)
    expect(blockRangeLabel([B1, B2], fmt)).toBe('14:12–18:40 · 23:30–01:18');
    expect(blockRangeLabel([], fmt)).toBe('');
  });
});

describe('constantes de umbral', () => {
  it('valores acordados con negocio', () => {
    expect(UMBRAL_HUECO_MIN).toBe(10);
    expect(UMBRAL_DESCONECTADA_MIN).toBe(10);
    expect(UMBRAL_SIN_CONF_MIN).toBe(120);
  });
});

describe('computeEnSuPuestoSec', () => {
  // Bogotá = UTC-5. 9:15 a. m. Bogotá = 14:15Z; 4:02 p. m. Bogotá = 21:02Z.
  const T0915 = '2026-07-17T14:15:00Z';
  const T1602 = '2026-07-17T21:02:00Z';

  it('caso Mayra: turno 9:15→16:02, almuerzo excluido, −59m inactividad = 4h48m', () => {
    // presencia laboral = (9:15→16:02 dentro de 9–17) − almuerzo 12:30–13:30
    //   = 6h47m − 1h = 5h47m = 20820 s; menos 59m (3540 s) = 17280 s = 4h48m.
    expect(
      computeEnSuPuestoSec({
        turnoStart: T0915,
        turnoEnd: T1602,
        inactivityLostSec: 3540,
        workedSec: 6780, // 1h53m marcando — queda por debajo, no es el piso
        schedule: DEFAULT_SCHEDULE,
      }),
    ).toBe(17280);
  });

  it('resta la inactividad de la presencia laboral', () => {
    // Turno 9:00→17:00 completo = 8h − 1h almuerzo = 7h (25200 s); −1h inactividad.
    expect(
      computeEnSuPuestoSec({
        turnoStart: '2026-07-17T14:00:00Z', // 9:00
        turnoEnd: '2026-07-17T22:00:00Z',   // 17:00
        inactivityLostSec: 3600,
        workedSec: 0,
        schedule: DEFAULT_SCHEDULE,
      }),
    ).toBe(21600);
  });

  it('piso = worked_seconds: trabajo fuera del horario (noche) no cae por debajo de la evidencia', () => {
    // 18:00→20:00 Bogotá: fuera del horario 9–17 → presencia laboral 0, pero marcó
    // 1h → devuelve la evidencia (3600), nunca menos.
    expect(
      computeEnSuPuestoSec({
        turnoStart: '2026-07-17T23:00:00Z', // 18:00 Bogotá
        turnoEnd: '2026-07-18T01:00:00Z',   // 20:00 Bogotá (mismo día Bogotá)
        inactivityLostSec: 0,
        workedSec: 3600,
        schedule: DEFAULT_SCHEDULE,
      }),
    ).toBe(3600);
  });

  it('rango multi-día (turno en fechas Bogotá distintas) → cae al piso worked (suma del rango)', () => {
    expect(
      computeEnSuPuestoSec({
        turnoStart: '2026-07-10T14:00:00Z',
        turnoEnd: '2026-07-17T21:00:00Z',
        inactivityLostSec: 0,
        workedSec: 36000, // 10h sumadas en el rango
        schedule: DEFAULT_SCHEDULE,
      }),
    ).toBe(36000);
  });

  it('inactividad mayor que la presencia → 0 (clamp), nunca negativo', () => {
    // 9:15→9:30 = 900 s de presencia; −1h inactividad → clamp a 0 (sin evidencia).
    expect(
      computeEnSuPuestoSec({
        turnoStart: '2026-07-17T14:15:00Z',
        turnoEnd: '2026-07-17T14:30:00Z',
        inactivityLostSec: 3600,
        workedSec: 0,
        schedule: DEFAULT_SCHEDULE,
      }),
    ).toBe(0);
  });

  it('sin ventana válida y sin evidencia → null; con evidencia → devuelve la evidencia', () => {
    expect(
      computeEnSuPuestoSec({
        turnoStart: null,
        turnoEnd: null,
        inactivityLostSec: 0,
        workedSec: 0,
        schedule: DEFAULT_SCHEDULE,
      }),
    ).toBeNull();
    expect(
      computeEnSuPuestoSec({
        turnoStart: null,
        turnoEnd: null,
        inactivityLostSec: 0,
        workedSec: 6780,
        schedule: DEFAULT_SCHEDULE,
      }),
    ).toBe(6780);
  });
});

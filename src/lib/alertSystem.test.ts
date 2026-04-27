import { describe, it, expect } from 'vitest';
import {
  getCarrierDeadline,
  getSegStage,
  getAlertLevel,
  getFreshness,
  needsAction,
  getSuggestedAction,
  calcCarrierStats,
  calcToxicCities,
  calcPriority,
  getPriorityLevel,
} from './alertSystem';

describe('getCarrierDeadline', () => {
  it('returns known carrier deadlines', () => {
    expect(getCarrierDeadline('INTERRAPIDISIMO')).toBe(5);
    expect(getCarrierDeadline('COORDINADORA')).toBe(15);
    expect(getCarrierDeadline('TCC')).toBe(7);
    expect(getCarrierDeadline('SERVIENTREGA')).toBe(7);
  });

  it('is case-insensitive', () => {
    expect(getCarrierDeadline('interrapidisimo')).toBe(5);
    expect(getCarrierDeadline('Coordinadora')).toBe(15);
  });

  it('returns 7 as default for unknown carriers', () => {
    expect(getCarrierDeadline('DESCONOCIDA')).toBe(7);
    expect(getCarrierDeadline('')).toBe(7);
  });
});

describe('getSegStage', () => {
  it('categorizes novedad states', () => {
    expect(getSegStage('NOVEDAD')).toBe('novedad');
    expect(getSegStage('INTENTO DE ENTREGA')).toBe('novedad');
  });

  it('categorizes oficina states', () => {
    expect(getSegStage('RECLAME EN OFICINA')).toBe('oficina');
  });

  it('categorizes devolucion states', () => {
    expect(getSegStage('DEVOLUCION')).toBe('devolucion');
  });

  it('categorizes bodega states', () => {
    expect(getSegStage('PENDIENTE')).toBe('bodega');
    expect(getSegStage('ALISTAMIENTO')).toBe('bodega');
    expect(getSegStage('EN BODEGA DROPI')).toBe('bodega');
  });

  it('categorizes transito states', () => {
    expect(getSegStage('EN REPARTO')).toBe('transito');
    expect(getSegStage('EN DISTRIBUCION')).toBe('transito');
    expect(getSegStage('ADMITIDA')).toBe('transito');
  });

  it('returns otro for unknown states', () => {
    expect(getSegStage('ENTREGADO')).toBe('otro');
    expect(getSegStage('CANCELADO')).toBe('otro');
  });
});

describe('getAlertLevel', () => {
  it('returns null for negative sinEscaneo', () => {
    // sinEscaneo = diasConf > 0 ? diasConf : dias; both must be negative
    expect(getAlertLevel(-1, -1, 'EN REPARTO', 'TCC')).toBeNull();
  });

  it('returns ok for 0 days', () => {
    const result = getAlertLevel(0, 0, 'EN REPARTO', 'TCC');
    expect(result).not.toBeNull();
    expect(result!.level).toBe('ok');
  });

  it('returns watch for 1 day', () => {
    const result = getAlertLevel(1, 1, 'EN REPARTO', 'TCC');
    expect(result).not.toBeNull();
    expect(result!.level).toBe('watch');
  });

  it('returns alert for 2 days', () => {
    const result = getAlertLevel(2, 2, 'EN REPARTO', 'TCC');
    expect(result!.level).toBe('alert');
  });

  it('returns critical for 3-4 days', () => {
    expect(getAlertLevel(3, 3, 'EN REPARTO', 'TCC')!.level).toBe('critical');
    expect(getAlertLevel(4, 4, 'EN REPARTO', 'TCC')!.level).toBe('critical');
  });

  it('returns lost for 5+ days', () => {
    expect(getAlertLevel(5, 5, 'EN REPARTO', 'TCC')!.level).toBe('lost');
    expect(getAlertLevel(10, 10, 'EN REPARTO', 'TCC')!.level).toBe('lost');
  });

  it('prefers diasConf over dias when diasConf > 0', () => {
    const result = getAlertLevel(3, 10, 'EN REPARTO', 'TCC');
    expect(result!.sinEscaneo).toBe(3);
    expect(result!.level).toBe('critical');
  });

  it('falls back to dias when diasConf is 0', () => {
    const result = getAlertLevel(0, 2, 'EN REPARTO', 'TCC');
    // diasConf=0 means not > 0, so sinEscaneo falls back to dias=2
    expect(result!.sinEscaneo).toBe(2);
    expect(result!.level).toBe('alert');
  });

  it('sets officeCD for oficina-like states', () => {
    const result = getAlertLevel(2, 2, 'RECLAME EN OFICINA', 'COORDINADORA');
    expect(result!.officeCD).not.toBeNull();
    expect(result!.officeCD!.deadline).toBe(15);
    expect(result!.officeCD!.remaining).toBe(13);
    expect(result!.officeCD!.carrier).toBe('COORDINADORA');
  });

  it('sets novedadW for novedad states with 3-day window', () => {
    const result = getAlertLevel(1, 1, 'NOVEDAD', 'TCC');
    expect(result!.novedadW).not.toBeNull();
    expect(result!.novedadW!.remaining).toBe(2);
  });

  it('clamps novedadW remaining to 0', () => {
    const result = getAlertLevel(5, 5, 'NOVEDAD', 'TCC');
    expect(result!.novedadW!.remaining).toBe(0);
  });
});

describe('getFreshness', () => {
  it('returns fresh for <4 hours', () => {
    const recent = Date.now() - 2 * 3600000; // 2 hours ago
    const result = getFreshness(recent, 0);
    expect(result.level).toBe('fresh');
  });

  it('returns pending for 4-24 hours', () => {
    const sixHoursAgo = Date.now() - 6 * 3600000;
    const result = getFreshness(sixHoursAgo, 0);
    expect(result.level).toBe('pending');
  });

  it('returns stale for 24-48 hours', () => {
    const thirtyHoursAgo = Date.now() - 30 * 3600000;
    const result = getFreshness(thirtyHoursAgo, 0);
    expect(result.level).toBe('stale');
  });

  it('returns critical for >48 hours', () => {
    const threeDaysAgo = Date.now() - 72 * 3600000;
    const result = getFreshness(threeDaysAgo, 0);
    expect(result.level).toBe('critical');
  });

  it('falls back to dias * 24 when no lastTouchTime', () => {
    const result = getFreshness(null, 3);
    expect(result.level).toBe('critical'); // 72 hours
  });
});

describe('needsAction', () => {
  it('returns false if resolved', () => {
    expect(needsAction('NOVEDAD', 5, 5, true, null)).toBe(false);
  });

  it('returns false for bodega/guia stages', () => {
    expect(needsAction('PENDIENTE', 5, 5, false, null)).toBe(false);
    expect(needsAction('GUIA_GENERADA', 5, 5, false, null)).toBe(false);
  });

  it('returns true for novedad older than 12h with no recent touch', () => {
    const oldTouch = Date.now() - 13 * 3600000;
    expect(needsAction('NOVEDAD', 1, 1, false, oldTouch)).toBe(true);
  });

  it('returns false for novedad with recent touch', () => {
    const recentTouch = Date.now() - 6 * 3600000;
    expect(needsAction('NOVEDAD', 1, 1, false, recentTouch)).toBe(false);
  });
});

describe('getSuggestedAction', () => {
  it('suggests office pickup for oficina states', () => {
    const action = getSuggestedAction('RECLAME EN OFICINA', '', 'COORDINADORA', 2);
    expect(action).toContain('oficina');
    expect(action).toContain('COORDINADORA');
  });

  it('suggests address correction for direction-related novedades', () => {
    const action = getSuggestedAction('NOVEDAD', 'Dirección incorrecta', 'TCC', 1);
    expect(action).toContain('dirección');
  });

  it('suggests reclamar for old dispatched orders', () => {
    const action = getSuggestedAction('EN REPARTO', '', 'SERVIENTREGA', 4);
    expect(action).toContain('Reclamar');
    expect(action).toContain('4d');
  });
});

describe('calcCarrierStats', () => {
  it('computes stats per carrier', () => {
    const orders = [
      { estado: 'ENTREGADO', transportadora: 'TCC' },
      { estado: 'ENTREGADO', transportadora: 'TCC' },
      { estado: 'DEVOLUCION', transportadora: 'TCC' },
      { estado: 'NOVEDAD', transportadora: 'SERVIENTREGA' },
    ];
    const stats = calcCarrierStats(orders);
    const tcc = stats.find(s => s.carrier === 'TCC');
    expect(tcc).toBeDefined();
    expect(tcc!.total).toBe(3);
    expect(tcc!.entregado).toBe(2);
    expect(tcc!.devol).toBe(1);
    expect(tcc!.efectividad).toBe(67);
  });

  it('skips orders without carrier', () => {
    const stats = calcCarrierStats([{ estado: 'ENTREGADO', transportadora: '' }]);
    expect(stats).toHaveLength(0);
  });
});

describe('calcToxicCities', () => {
  it('filters cities with fewer than 3 orders', () => {
    const orders = [
      { estado: 'DEVOLUCION', ciudad: 'Bogotá' },
      { estado: 'DEVOLUCION', ciudad: 'Bogotá' },
    ];
    const result = calcToxicCities(orders);
    expect(result).toHaveLength(0);
  });

  it('calculates risk correctly', () => {
    const orders = [
      { estado: 'DEVOLUCION', ciudad: 'Cúcuta' },
      { estado: 'DEVOLUCION', ciudad: 'Cúcuta' },
      { estado: 'ENTREGADO', ciudad: 'Cúcuta' },
    ];
    const result = calcToxicCities(orders);
    expect(result).toHaveLength(1);
    expect(result[0].risk).toBe(67); // 2/3 = 67%
  });
});

describe('calcPriority', () => {
  it('returns low score for fresh order in transit', () => {
    const score = calcPriority({ diasConf: 0, dias: 0, estado: 'EN REPARTO', transportadora: 'TCC' });
    expect(score).toBe(5); // transito stage = 5 pts
  });

  it('scores higher for older orders', () => {
    const fresh = calcPriority({ diasConf: 0, dias: 0, estado: 'EN REPARTO', transportadora: 'TCC' });
    const old = calcPriority({ diasConf: 3, dias: 5, estado: 'EN REPARTO', transportadora: 'TCC' });
    expect(old).toBeGreaterThan(fresh);
  });

  it('gives max SLA score to 5+ day orders', () => {
    const score = calcPriority({ diasConf: 6, dias: 6, estado: 'EN REPARTO', transportadora: 'TCC' });
    expect(score).toBeGreaterThanOrEqual(50);
  });

  it('boosts unresolved novedades', () => {
    const novedad = calcPriority({ diasConf: 2, dias: 2, estado: 'NOVEDAD', transportadora: 'TCC', novedadSol: false });
    const normal = calcPriority({ diasConf: 2, dias: 2, estado: 'EN REPARTO', transportadora: 'TCC' });
    expect(novedad).toBeGreaterThan(normal);
  });

  it('does not boost resolved novedades', () => {
    const resolved = calcPriority({ diasConf: 2, dias: 2, estado: 'NOVEDAD', transportadora: 'TCC', novedadSol: true });
    const unresolved = calcPriority({ diasConf: 2, dias: 2, estado: 'NOVEDAD', transportadora: 'TCC', novedadSol: false });
    expect(unresolved).toBeGreaterThan(resolved);
  });

  it('boosts high-value orders', () => {
    const cheap = calcPriority({ diasConf: 2, dias: 2, estado: 'EN REPARTO', transportadora: 'TCC', valor: 30000 });
    const expensive = calcPriority({ diasConf: 2, dias: 2, estado: 'EN REPARTO', transportadora: 'TCC', valor: 250000 });
    expect(expensive).toBeGreaterThan(cheap);
  });

  it('adds rescue window bonus for expiring novedades', () => {
    const expiring = calcPriority({ diasConf: 2, dias: 2, estado: 'NOVEDAD', transportadora: 'TCC', novedadSol: false });
    const fresh = calcPriority({ diasConf: 0, dias: 0, estado: 'NOVEDAD', transportadora: 'TCC', novedadSol: false });
    expect(expiring).toBeGreaterThan(fresh);
  });

  it('boosts oficina orders about to expire', () => {
    const expiring = calcPriority({ diasConf: 4, dias: 4, estado: 'RECLAME EN OFICINA', transportadora: 'INTERRAPIDISIMO' });
    const fresh = calcPriority({ diasConf: 1, dias: 1, estado: 'RECLAME EN OFICINA', transportadora: 'INTERRAPIDISIMO' });
    expect(expiring).toBeGreaterThan(fresh);
  });
});

describe('getPriorityLevel', () => {
  it('returns critical for score >= 50', () => {
    expect(getPriorityLevel(50)).toBe('critical');
    expect(getPriorityLevel(80)).toBe('critical');
  });

  it('returns high for 30-49', () => {
    expect(getPriorityLevel(30)).toBe('high');
    expect(getPriorityLevel(49)).toBe('high');
  });

  it('returns medium for 15-29', () => {
    expect(getPriorityLevel(15)).toBe('medium');
    expect(getPriorityLevel(29)).toBe('medium');
  });

  it('returns low for < 15', () => {
    expect(getPriorityLevel(0)).toBe('low');
    expect(getPriorityLevel(14)).toBe('low');
  });
});

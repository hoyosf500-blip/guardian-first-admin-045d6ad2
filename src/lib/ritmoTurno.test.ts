import { describe, it, expect } from 'vitest';
import { calcularRitmo, RITMO_META_POR_HORA } from './ritmoTurno';

const MIN = 60_000;

describe('calcularRitmo', () => {
  it('sin primera gestión → todo null (aún no arrancó)', () => {
    const r = calcularRitmo({ gestionados: 0, desdeMs: null, nowMs: 0, faltan: 100 });
    expect(r.porHora).toBeNull();
    expect(r.vaLento).toBe(false);
  });

  it('muy temprano (<10 min) → no calcula ritmo (evita números fantasiosos)', () => {
    const r = calcularRitmo({ gestionados: 3, desdeMs: 0, nowMs: 4 * MIN, faltan: 100 });
    expect(r.porHora).toBeNull();
  });

  it('37 gestionados en 3 horas = ~12,3/hora, va lento (bajo la meta de 15)', () => {
    const r = calcularRitmo({ gestionados: 37, desdeMs: 0, nowMs: 180 * MIN, faltan: 104 });
    expect(r.porHora).toBe(12.3);
    expect(r.vaLento).toBe(true);
  });

  it('proyección de fin: a 12,3/h, 104 pendientes ≈ 507 min', () => {
    const r = calcularRitmo({ gestionados: 37, desdeMs: 0, nowMs: 180 * MIN, faltan: 104 });
    // 104 / 12.33 * 60 ≈ 506
    expect(r.etaMin).toBeGreaterThan(490);
    expect(r.etaMin).toBeLessThan(520);
  });

  it('a buen ritmo (20/h) NO va lento', () => {
    const r = calcularRitmo({ gestionados: 40, desdeMs: 0, nowMs: 120 * MIN, faltan: 50 });
    expect(r.porHora).toBe(20);
    expect(r.vaLento).toBe(false);
  });

  it('cola vacía (faltan 0) → eta 0', () => {
    const r = calcularRitmo({ gestionados: 30, desdeMs: 0, nowMs: 120 * MIN, faltan: 0 });
    expect(r.etaMin).toBe(0);
  });

  it('la meta por defecto es 15/hora', () => {
    expect(RITMO_META_POR_HORA).toBe(15);
  });
});

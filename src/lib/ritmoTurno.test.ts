import { describe, it, expect } from 'vitest';
import { calcularRitmo, RITMO_META_POR_HORA, RITMO_ALERTA_POR_HORA } from './ritmoTurno';

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

  it('37 en 3h = ~12,3/h → ámbar (bajo el óptimo 20 pero sobre la alerta 12), NO rojo', () => {
    const r = calcularRitmo({ gestionados: 37, desdeMs: 0, nowMs: 180 * MIN, faltan: 104 });
    expect(r.porHora).toBe(12.3);
    expect(r.vaLento).toBe(false);
    expect(r.bajoOptimo).toBe(true);
  });

  it('18 en 3h = 6/h → rojo (bajo la alerta de 12 = 5 min/pedido)', () => {
    const r = calcularRitmo({ gestionados: 18, desdeMs: 0, nowMs: 180 * MIN, faltan: 100 });
    expect(r.porHora).toBe(6);
    expect(r.vaLento).toBe(true);
    expect(r.bajoOptimo).toBe(false);
  });

  it('proyección de fin: a 12,3/h, 104 pendientes ≈ 507 min', () => {
    const r = calcularRitmo({ gestionados: 37, desdeMs: 0, nowMs: 180 * MIN, faltan: 104 });
    // 104 / 12.33 * 60 ≈ 506
    expect(r.etaMin).toBeGreaterThan(490);
    expect(r.etaMin).toBeLessThan(520);
  });

  it('justo en el óptimo (20/h = 3 min/pedido) → verde (ni rojo ni ámbar)', () => {
    const r = calcularRitmo({ gestionados: 40, desdeMs: 0, nowMs: 120 * MIN, faltan: 50 });
    expect(r.porHora).toBe(20);
    expect(r.vaLento).toBe(false);
    expect(r.bajoOptimo).toBe(false);
  });

  it('por encima del óptimo (25/h) → verde', () => {
    const r = calcularRitmo({ gestionados: 50, desdeMs: 0, nowMs: 120 * MIN, faltan: 50 });
    expect(r.porHora).toBe(25);
    expect(r.vaLento).toBe(false);
    expect(r.bajoOptimo).toBe(false);
  });

  it('cola vacía (faltan 0) → eta 0', () => {
    const r = calcularRitmo({ gestionados: 30, desdeMs: 0, nowMs: 120 * MIN, faltan: 0 });
    expect(r.etaMin).toBe(0);
  });

  it('el óptimo es 20/h (3 min) y la alerta roja 12/h (5 min)', () => {
    expect(RITMO_META_POR_HORA).toBe(20);
    expect(RITMO_ALERTA_POR_HORA).toBe(12);
  });
});

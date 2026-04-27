import { describe, it, expect } from 'vitest';
import { calcBadge, estadoColor } from './customerUtils';

describe('calcBadge', () => {
  it('returns null for fewer than 3 orders', () => {
    expect(calcBadge(2, 2, 0)).toBeNull();
    expect(calcBadge(1, 0, 1)).toBeNull();
  });

  it('returns VIP for >=80% effectiveness with 3+ orders', () => {
    const badge = calcBadge(5, 4, 0);
    expect(badge).not.toBeNull();
    expect(badge!.kind).toBe('vip');
    expect(badge!.label).toContain('VIP');
  });

  it('returns VIP at exactly 80%', () => {
    const badge = calcBadge(5, 4, 1);
    expect(badge!.kind).toBe('vip');
  });

  it('returns risk for <50% with 2+ devoluciones', () => {
    const badge = calcBadge(5, 1, 3);
    expect(badge).not.toBeNull();
    expect(badge!.kind).toBe('risk');
    expect(badge!.label).toContain('RIESGO');
  });

  it('returns null for <50% but fewer than 2 devoluciones', () => {
    const badge = calcBadge(3, 1, 1);
    expect(badge).toBeNull();
  });

  it('returns recurrent for 5+ orders without VIP or risk', () => {
    const badge = calcBadge(5, 3, 0);
    expect(badge).not.toBeNull();
    expect(badge!.kind).toBe('recurrent');
  });

  it('VIP takes priority over recurrent for 5+ orders with high effectiveness', () => {
    const badge = calcBadge(10, 9, 0);
    expect(badge!.kind).toBe('vip');
  });

  it('risk takes priority over recurrent', () => {
    const badge = calcBadge(6, 2, 3);
    expect(badge!.kind).toBe('risk');
  });

  it('returns null for exactly 3 orders at 67% (no special badge)', () => {
    // 3 total, 2 delivered, 0 devol = 67% effectiveness, <5 orders
    expect(calcBadge(3, 2, 0)).toBeNull();
  });
});

describe('estadoColor', () => {
  it('returns emerald for ENTREGADO', () => {
    expect(estadoColor('ENTREGADO')).toContain('emerald');
  });

  it('returns rose for DEVOLUCION', () => {
    expect(estadoColor('DEVOLUCION')).toContain('rose');
    expect(estadoColor('EN DEVOLUCION')).toContain('rose');
  });

  it('returns orange for NOVEDAD', () => {
    expect(estadoColor('NOVEDAD')).toContain('orange');
  });

  it('returns orange for INTENTO DE ENTREGA', () => {
    expect(estadoColor('INTENTO DE ENTREGA')).toContain('orange');
  });

  it('returns yellow for OFICINA states', () => {
    expect(estadoColor('RECLAME EN OFICINA')).toContain('yellow');
  });

  it('returns gray for PENDIENTE CONFIRMACION', () => {
    expect(estadoColor('PENDIENTE CONFIRMACION')).toContain('gray');
  });

  it('returns blue as default for unknown states', () => {
    expect(estadoColor('EN REPARTO')).toContain('blue');
    expect(estadoColor('PENDIENTE')).toContain('blue');
  });

  it('returns muted for null', () => {
    expect(estadoColor(null)).toContain('muted');
  });

  it('returns muted for empty string', () => {
    // Empty string is falsy
    expect(estadoColor('')).toContain('muted');
  });
});

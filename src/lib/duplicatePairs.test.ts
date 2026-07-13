import { describe, it, expect } from 'vitest';
import { detectDuplicatePairs, phoneKey9, type DupPairOrder } from './duplicatePairs';

const mk = (
  externalId: string,
  phone: string | null,
  estado: string | null,
  createdAt: string | null = null,
): DupPairOrder => ({ externalId, phone, estado, createdAt });

describe('phoneKey9', () => {
  it('toma los últimos 9 dígitos ignorando prefijos y formato', () => {
    // EC local (0 inicial) vs internacional (593) → misma clave
    expect(phoneKey9('0991234567')).toBe('991234567');
    expect(phoneKey9('+593 99 123 4567')).toBe('991234567');
    // CO 10 dígitos → últimos 9
    expect(phoneKey9('3001234567')).toBe('001234567');
  });

  it('devuelve null para phones null, vacíos o basura corta', () => {
    expect(phoneKey9(null)).toBeNull();
    expect(phoneKey9(undefined)).toBeNull();
    expect(phoneKey9('')).toBeNull();
    expect(phoneKey9('123')).toBeNull();
  });
});

describe('detectDuplicatePairs', () => {
  it('detecta un par activo del mismo teléfono → viejo/nuevo por externalId', () => {
    // Caso real Alicia Chancay: stub viejo + reenvío nuevo, ambos activos.
    const pairs = detectDuplicatePairs([
      mk('6083663', '593991234567', 'PENDIENTE', '2026-07-10T10:00:00Z'),
      mk('6078098', '0991234567', 'PENDIENTE', '2026-07-08T10:00:00Z'),
      mk('7000001', '0987654321', 'PENDIENTE CONFIRMACION', '2026-07-10T09:00:00Z'),
    ]);
    expect(pairs.size).toBe(1);
    const pair = pairs.get('991234567');
    expect(pair).toBeDefined();
    expect(pair!.viejo.externalId).toBe('6078098');
    expect(pair!.nuevo.externalId).toBe('6083663');
  });

  it('trío del mismo teléfono → devuelve los extremos (más viejo y más nuevo)', () => {
    const pairs = detectDuplicatePairs([
      mk('200', '0991112223', 'PENDIENTE', '2026-07-09T00:00:00Z'),
      mk('300', '0991112223', 'PENDIENTE CONFIRMACION', '2026-07-10T00:00:00Z'),
      mk('100', '0991112223', 'PENDIENTE', '2026-07-08T00:00:00Z'),
    ]);
    expect(pairs.size).toBe(1);
    const pair = pairs.get('991112223')!;
    expect(pair.viejo.externalId).toBe('100');
    expect(pair.nuevo.externalId).toBe('300');
  });

  it('sin par: pedido único o acompañado solo de estados no activos → vacío', () => {
    const pairs = detectDuplicatePairs([
      // único activo de su teléfono
      mk('500', '0993334445', 'PENDIENTE'),
      // mismo teléfono pero el otro ya terminó / no es activo
      mk('600', '0995556667', 'PENDIENTE CONFIRMACION'),
      mk('601', '0995556667', 'ENTREGADO'),
      mk('602', '0995556667', 'CANCELADO'),
    ]);
    expect(pairs.size).toBe(0);
  });

  it('phones null o inválidos se ignoran sin romper', () => {
    const pairs = detectDuplicatePairs([
      mk('700', null, 'PENDIENTE'),
      mk('701', null, 'PENDIENTE'),
      mk('702', '12', 'PENDIENTE'),
      mk('703', '12', 'PENDIENTE'),
    ]);
    expect(pairs.size).toBe(0);
  });

  it('la misma orden repetida (cola + progressed mezclados) no cuenta como par', () => {
    const pairs = detectDuplicatePairs([
      mk('800', '0998887776', 'PENDIENTE CONFIRMACION', '2026-07-10T00:00:00Z'),
      mk('800', '0998887776', 'PENDIENTE CONFIRMACION', '2026-07-10T00:00:00Z'),
    ]);
    expect(pairs.size).toBe(0);
  });

  it('sin externalId no participa (no habría # que señalar)', () => {
    const pairs = detectDuplicatePairs([
      mk('', '0990001112', 'PENDIENTE'),
      mk('900', '0990001112', 'PENDIENTE'),
    ]);
    expect(pairs.size).toBe(0);
  });

  it('ids no numéricos caen al fallback por createdAt', () => {
    const pairs = detectDuplicatePairs([
      mk('SHOP-B', '0991230000', 'PENDIENTE', '2026-07-10T12:00:00Z'),
      mk('SHOP-A', '0991230000', 'PENDIENTE', '2026-07-08T12:00:00Z'),
    ]);
    const pair = pairs.get('991230000')!;
    expect(pair.viejo.externalId).toBe('SHOP-A');
    expect(pair.nuevo.externalId).toBe('SHOP-B');
  });
});

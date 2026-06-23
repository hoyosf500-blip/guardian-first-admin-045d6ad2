import { describe, it, expect, vi } from 'vitest';

// Mocks mínimos para importar el módulo sin tocar supabase real (mismo patrón que
// useOrdersSyncHealth.test.ts). Solo testeamos la función PURA deriveStatus.
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: vi.fn() },
}));

import { deriveStatus } from './useWalletSyncHealth';

describe('deriveStatus (liveness del cron del wallet)', () => {
  it('sin corridas (null) → never', () => {
    expect(deriveStatus(null)).toBe('never');
  });

  it('corrió hace < 8h → fresh', () => {
    expect(deriveStatus(0)).toBe('fresh');
    expect(deriveStatus(6)).toBe('fresh');     // cadencia normal del cron (cada 6h)
    expect(deriveStatus(7.99)).toBe('fresh');
  });

  it('corrió hace 8h-24h → stale (warning)', () => {
    expect(deriveStatus(8)).toBe('stale');
    expect(deriveStatus(20)).toBe('stale');
    expect(deriveStatus(23.99)).toBe('stale');
  });

  it('corrió hace > 24h → critical (cron caído)', () => {
    expect(deriveStatus(24)).toBe('critical');
    expect(deriveStatus(100)).toBe('critical');
  });

  it('REGRESIÓN: tienda sin movimientos nuevos pero con cron sano NO es stale', () => {
    // El bug original: max(fecha) viejo (sin movimientos nuevos) dominaba el color
    // y daba stale/critical aunque el cron corriera cada 6h. Ahora el color depende
    // SOLO de cuándo corrió el sync → 6h = fresh, sin importar la edad del último
    // movimiento.
    expect(deriveStatus(6)).toBe('fresh');
  });
});

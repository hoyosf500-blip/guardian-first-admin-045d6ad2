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

  describe('REGRESIÓN 2026-07-21 — el cron podía FALLAR EN VERDE', () => {
    // El cron del wallet corría puntual cada 6h y fallaba en TODAS las corridas
    // (`invalid input syntax for type uuid: ""`). Como sólo se miraba la HORA de
    // la corrida, el badge decía "Sincronizado hace 2h" en verde mientras la
    // billetera llevaba 15 días congelada. Ahora una corrida en error manda.
    it('corrida reciente pero fallida → failing, NO fresh', () => {
      expect(deriveStatus(2, 'error')).toBe('failing');
      expect(deriveStatus(0.1, 'error')).toBe('failing');
    });

    it('la falla manda incluso sobre stale y critical', () => {
      expect(deriveStatus(12, 'error')).toBe('failing');
      expect(deriveStatus(100, 'error')).toBe('failing');
    });

    it('corrida exitosa reciente sigue siendo fresh', () => {
      expect(deriveStatus(2, 'success')).toBe('fresh');
    });

    it("status 'warn' no es error: no dispara failing", () => {
      expect(deriveStatus(2, 'warn')).toBe('fresh');
    });

    it('sin corridas gana never, aunque se pase un status', () => {
      expect(deriveStatus(null, 'error')).toBe('never');
    });

    it('compatibilidad: sin el segundo argumento se comporta como antes', () => {
      expect(deriveStatus(2)).toBe('fresh');
      expect(deriveStatus(12)).toBe('stale');
      expect(deriveStatus(30)).toBe('critical');
    });
  });

  it('REGRESIÓN: tienda sin movimientos nuevos pero con cron sano NO es stale', () => {
    // El bug original: max(fecha) viejo (sin movimientos nuevos) dominaba el color
    // y daba stale/critical aunque el cron corriera cada 6h. Ahora el color depende
    // SOLO de cuándo corrió el sync → 6h = fresh, sin importar la edad del último
    // movimiento.
    expect(deriveStatus(6)).toBe('fresh');
  });
});

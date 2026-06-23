import { describe, it, expect, vi } from 'vitest';

// Mocks mínimos para que importar el módulo no toque supabase real ni StoreContext
// (mismo patrón que useGananciaNetaDropi.test.ts). Solo testeamos la función PURA.
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: vi.fn() },
}));
vi.mock('@/contexts/StoreContext', () => ({
  useActiveStoreId: () => 'store-test',
}));

import { deriveOrdersStatus } from './useOrdersSyncHealth';

const NOW = Date.parse('2026-06-23T12:00:00Z');
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const hrsAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function row(over: Partial<{ status: string; synced_count: number; created_at: string; error_message: string | null }> = {}) {
  return {
    status: 'success',
    synced_count: 5,
    total_count: 5,
    created_at: minsAgo(2),
    error_message: null,
    ...over,
  };
}

describe('deriveOrdersStatus', () => {
  it('sin filas → hidden (sin corridas o sin permiso RLS)', () => {
    const r = deriveOrdersStatus([], NOW);
    expect(r.status).toBe('hidden');
    expect(r.lastSuccessAt).toBeNull();
    expect(r.lastAttemptAt).toBeNull();
  });

  it('success reciente con synced_count>0 → fresh + lastSuccessAt correcto', () => {
    const created = minsAgo(5);
    const r = deriveOrdersStatus([row({ status: 'success', synced_count: 5, created_at: created })], NOW);
    expect(r.status).toBe('fresh');
    expect(r.lastSuccessAt?.toISOString()).toBe(new Date(created).toISOString());
  });

  it('última fila status=error → error + error_message + lastSuccessAt null', () => {
    const r = deriveOrdersStatus(
      [row({ status: 'error', synced_count: 0, created_at: minsAgo(2), error_message: 'boom' })],
      NOW,
    );
    expect(r.status).toBe('error');
    expect(r.lastErrorMessage).toBe('boom');
    expect(r.lastSuccessAt).toBeNull();
  });

  it('último intento > 60 min → error (aunque haya sido success)', () => {
    const r = deriveOrdersStatus([row({ status: 'success', synced_count: 5, created_at: hrsAgo(3) })], NOW);
    expect(r.status).toBe('error');
    // El success viejo igual queda como lastSuccessAt.
    expect(r.lastSuccessAt).not.toBeNull();
  });

  it('última hora con todas synced_count=0 → stale (zombie)', () => {
    const r = deriveOrdersStatus(
      [
        row({ status: 'success', synced_count: 0, created_at: minsAgo(5) }),
        row({ status: 'success', synced_count: 0, created_at: minsAgo(30) }),
      ],
      NOW,
    );
    expect(r.status).toBe('stale');
  });

  it('última hora con status=warn → stale', () => {
    const r = deriveOrdersStatus([row({ status: 'warn', synced_count: 0, created_at: minsAgo(4) })], NOW);
    expect(r.status).toBe('stale');
  });
});

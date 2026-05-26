import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useGananciaNetaDropi, aggregateMovements } from './useGananciaNetaDropi';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: vi.fn(),
    from: vi.fn(),
  },
}));

// La billetera es por tienda: el hook lee la tienda activa. En el test la
// fijamos para que la query corra (enabled) y el filtro .eq('store_id') exista.
vi.mock('@/contexts/StoreContext', () => ({
  useActiveStoreId: () => 'store-test',
}));

import { supabase } from '@/integrations/supabase/client';

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);
}

/** Mockea el RPC `wallet_ganancia_neta` devolviendo una fila agregada. */
function mockRpc(row: Record<string, number> | null, error: unknown = null) {
  (supabase as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc = vi.fn(() =>
    Promise.resolve({ data: row ? [row] : null, error }),
  );
}

/** Mockea el fallback: from().select().eq().gte().lte() */
function mockFallbackMovs(data: unknown[]) {
  const fromFn = vi.fn(() => ({
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        gte: vi.fn(() => ({
          lte: vi.fn(() => Promise.resolve({ data, error: null })),
        })),
      })),
    })),
  }));
  (supabase as unknown as { from: typeof fromFn }).from = fromFn;
}

// ── Función pura aggregateMovements (lógica de categorías) ──────────
describe('aggregateMovements', () => {
  it('suma entradas operativas y resta salidas', () => {
    const r = aggregateMovements([
      { categoria: 'ganancia_dropshipper', monto: 50000 },
      { categoria: 'ganancia_dropshipper', monto: 30000 },
      { categoria: 'flete_inicial', monto: 8000 },
      { categoria: 'costo_devolucion', monto: 5000 },
    ]);
    expect(r.total_entradas).toBe(80000);
    expect(r.total_salidas).toBe(13000);
    expect(r.ganancia_neta).toBe(67000);
    expect(r.movimientos_count).toBe(4);
  });

  it('IGNORA retiros, depositos y otros (no afectan ganancia operativa)', () => {
    const r = aggregateMovements([
      { categoria: 'ganancia_dropshipper', monto: 100000 },
      { categoria: 'retiro', monto: 50000 },
      { categoria: 'deposito', monto: 200000 },
      { categoria: 'otro', monto: 9999 },
      { categoria: 'transferencia_externa', monto: 333000 },
    ]);
    expect(r.total_entradas).toBe(100000);
    expect(r.total_salidas).toBe(0);
    expect(r.ganancia_neta).toBe(100000);
    expect(r.movimientos_count).toBe(1);
  });

  it('rango vacío: retorna ceros', () => {
    const r = aggregateMovements([]);
    expect(r.ganancia_neta).toBe(0);
    expect(r.total_entradas).toBe(0);
    expect(r.total_salidas).toBe(0);
    expect(r.movimientos_count).toBe(0);
  });

  it('reembolso_flete e indemnizacion suman como entradas operativas', () => {
    const r = aggregateMovements([
      { categoria: 'reembolso_flete', monto: 8000 },
      { categoria: 'indemnizacion', monto: 21980 },
      { categoria: 'mantenimiento_tarjeta', monto: 12500 },
    ]);
    expect(r.total_entradas).toBe(29980);
    expect(r.total_salidas).toBe(12500);
    expect(r.ganancia_neta).toBe(17480);
    expect(r.desglose.reembolso_flete).toBe(8000);
    expect(r.desglose.indemnizacion).toBe(21980);
    expect(r.desglose.mantenimiento_tarjeta).toBe(12500);
  });

  it('toma valor absoluto del monto (las salidas pueden venir negativas)', () => {
    const r = aggregateMovements([
      { categoria: 'flete_inicial', monto: -8000 },
      { categoria: 'ganancia_dropshipper', monto: 50000 },
    ]);
    expect(r.total_salidas).toBe(8000);
    expect(r.ganancia_neta).toBe(42000);
  });
});

// ── Hook: RPC-first + fallback ──────────────────────────────────────
describe('useGananciaNetaDropi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('usa el RPC wallet_ganancia_neta cuando está disponible', async () => {
    mockRpc({
      total_entradas: 80000, total_salidas: 13000, ganancia_neta: 67000, movimientos_count: 4,
      ganancia_dropshipper: 80000, ganancia_proveedor: 0, reembolso_flete: 0, indemnizacion: 0,
      flete_inicial: 8000, costo_devolucion: 5000, comision_referidos: 0,
      mantenimiento_tarjeta: 0, orden_sin_recaudo: 0,
    });
    const { result } = renderHook(
      () => useGananciaNetaDropi('2026-04-01', '2026-04-30'),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.total_entradas).toBe(80000);
    expect(result.current.data?.ganancia_neta).toBe(67000);
    expect(result.current.data?.desglose.flete_inicial).toBe(8000);
    // No debió tocar el fallback (from)
    expect((supabase as unknown as { from: ReturnType<typeof vi.fn> }).from).not.toHaveBeenCalled();
  });

  it('cae al SELECT directo si el RPC no está desplegado (PGRST202)', async () => {
    mockRpc(null, { code: 'PGRST202', message: 'function does not exist' });
    mockFallbackMovs([
      { categoria: 'ganancia_dropshipper', monto: 100000, tipo: 'ENTRADA' },
      { categoria: 'flete_inicial', monto: 8000, tipo: 'SALIDA' },
    ]);
    const { result } = renderHook(
      () => useGananciaNetaDropi('2026-04-01', '2026-04-30'),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.total_entradas).toBe(100000);
    expect(result.current.data?.total_salidas).toBe(8000);
    expect(result.current.data?.ganancia_neta).toBe(92000);
    expect((supabase as unknown as { from: ReturnType<typeof vi.fn> }).from).toHaveBeenCalled();
  });
});

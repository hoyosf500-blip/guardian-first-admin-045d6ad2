import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useGananciaNetaDropi } from './useGananciaNetaDropi';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
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

function mockMovs(data: unknown[]) {
  // Cadena: from().select().eq('store_id').gte().lte()
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

describe('useGananciaNetaDropi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('suma entradas operativas y resta salidas', async () => {
    mockMovs([
      { categoria: 'ganancia_dropshipper', monto: 50000, tipo: 'ENTRADA' },
      { categoria: 'ganancia_dropshipper', monto: 30000, tipo: 'ENTRADA' },
      { categoria: 'flete_inicial', monto: 8000, tipo: 'SALIDA' },
      { categoria: 'costo_devolucion', monto: 5000, tipo: 'SALIDA' },
    ]);
    const { result } = renderHook(
      () => useGananciaNetaDropi('2026-04-01', '2026-04-30'),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.total_entradas).toBe(80000);
    expect(result.current.data?.total_salidas).toBe(13000);
    expect(result.current.data?.ganancia_neta).toBe(67000);
    expect(result.current.data?.movimientos_count).toBe(4);
  });

  it('IGNORA retiros, depositos y otros (no afectan ganancia operativa)', async () => {
    mockMovs([
      { categoria: 'ganancia_dropshipper', monto: 100000, tipo: 'ENTRADA' },
      { categoria: 'retiro', monto: 50000, tipo: 'SALIDA' }, // ignorado
      { categoria: 'deposito', monto: 200000, tipo: 'ENTRADA' }, // ignorado
      { categoria: 'otro', monto: 9999, tipo: 'SALIDA' }, // ignorado
      { categoria: 'transferencia_externa', monto: 333000, tipo: 'SALIDA' }, // ignorado
    ]);
    const { result } = renderHook(
      () => useGananciaNetaDropi('2026-04-01', '2026-04-30'),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.total_entradas).toBe(100000);
    expect(result.current.data?.total_salidas).toBe(0);
    expect(result.current.data?.ganancia_neta).toBe(100000);
    expect(result.current.data?.movimientos_count).toBe(1);
  });

  it('rango vacío: retorna ceros', async () => {
    mockMovs([]);
    const { result } = renderHook(
      () => useGananciaNetaDropi('2026-04-01', '2026-04-30'),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.ganancia_neta).toBe(0);
    expect(result.current.data?.total_entradas).toBe(0);
    expect(result.current.data?.total_salidas).toBe(0);
    expect(result.current.data?.movimientos_count).toBe(0);
  });

  it('reembolso_flete e indemnizacion suman como entradas operativas', async () => {
    mockMovs([
      { categoria: 'reembolso_flete', monto: 8000, tipo: 'ENTRADA' },
      { categoria: 'indemnizacion', monto: 21980, tipo: 'ENTRADA' },
      { categoria: 'mantenimiento_tarjeta', monto: 12500, tipo: 'SALIDA' },
    ]);
    const { result } = renderHook(
      () => useGananciaNetaDropi('2026-04-01', '2026-04-30'),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.total_entradas).toBe(29980);
    expect(result.current.data?.total_salidas).toBe(12500);
    expect(result.current.data?.ganancia_neta).toBe(17480);
    expect(result.current.data?.desglose.reembolso_flete).toBe(8000);
    expect(result.current.data?.desglose.indemnizacion).toBe(21980);
    expect(result.current.data?.desglose.mantenimiento_tarjeta).toBe(12500);
  });

  it('toma valor absoluto del monto (las salidas pueden venir negativas)', async () => {
    mockMovs([
      { categoria: 'flete_inicial', monto: -8000, tipo: 'SALIDA' },
      { categoria: 'ganancia_dropshipper', monto: 50000, tipo: 'ENTRADA' },
    ]);
    const { result } = renderHook(
      () => useGananciaNetaDropi('2026-04-01', '2026-04-30'),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.data).toBeDefined());
    // La salida debe contar como 8000 (absoluto), no -8000
    expect(result.current.data?.total_salidas).toBe(8000);
    expect(result.current.data?.ganancia_neta).toBe(42000);
  });
});

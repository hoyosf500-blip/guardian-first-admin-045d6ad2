import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useLogisticsStats } from './useLogisticsStats';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: vi.fn().mockImplementation((fn: string) => {
      if (fn === 'logistics_summary') {
        return Promise.resolve({
          data: [{
            total_pedidos: 100, entregados: 70, devueltos: 10,
            en_transito: 20, tasa_entrega: 70, tasa_devolucion: 10,
            valor_entregado: 1000, valor_perdido: 100,
          }],
          error: null,
        });
      }
      return Promise.resolve({ data: [], error: null });
    }),
  },
}));

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return React.createElement(QueryClientProvider, { client: qc }, children);
};

describe('useLogisticsStats', () => {
  it('devuelve summary tras la query', async () => {
    const { result } = renderHook(
      () => useLogisticsStats({ fromDate: '2026-04-01', toDate: '2026-04-27', minOrders: 5 }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.summary.isSuccess).toBe(true));
    expect(result.current.summary.data?.total_pedidos).toBe(100);
  });

  it('expone loading mientras espera', () => {
    const { result } = renderHook(
      () => useLogisticsStats({ fromDate: '2026-04-01', toDate: '2026-04-27', minOrders: 5 }),
      { wrapper },
    );
    expect(result.current.summary.isLoading).toBe(true);
  });
});

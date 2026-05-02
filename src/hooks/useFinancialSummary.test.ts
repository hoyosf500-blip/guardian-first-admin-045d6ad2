import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useFinancialSummary } from './useFinancialSummary';

// Mock del cliente Supabase. Captura los args para aserción.
const rpcMock = vi.fn();

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (fn: string, args: Record<string, unknown>) => rpcMock(fn, args),
  },
}));

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return React.createElement(QueryClientProvider, { client: qc }, children);
};

describe('useFinancialSummary', () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  it('llama al RPC financial_summary con args p_from_date / p_to_date', async () => {
    rpcMock.mockResolvedValueOnce({
      data: {
        ingresos_brutos: 1000000,
        cogs: 400000,
        flete_entregadas: 80000,
        flete_devoluciones: 20000,
        costo_devoluciones: 10000,
        comision_referidos: 5000,
        ganancia_markup: 30000,
        valor_cancelado: 250000,
        total_cancelados: 8,
        tasa_cancelacion_pct: 8,
        utilidad_bruta: 485000,
        total_ordenes: 100,
        total_entregadas: 70,
        total_devueltas: 10,
        tasa_entrega_pct: 70,
        ticket_promedio: 14285,
        wallet_neto: 50000,
      },
      error: null,
    });

    const { result } = renderHook(
      () => useFinancialSummary('2026-04-01', '2026-04-30'),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(rpcMock).toHaveBeenCalledWith('financial_summary', {
      p_from_date: '2026-04-01',
      p_to_date: '2026-04-30',
    });
    expect(result.current.data?.utilidad_bruta).toBe(485000);
    expect(result.current.data?.ingresos_brutos).toBe(1000000);
    expect(result.current.data?.tasa_entrega_pct).toBe(70);
    expect(result.current.data?.comision_referidos).toBe(5000);
    expect(result.current.data?.ganancia_markup).toBe(30000);
    expect(result.current.data?.valor_cancelado).toBe(250000);
    expect(result.current.data?.total_cancelados).toBe(8);
    expect(result.current.data?.tasa_cancelacion_pct).toBe(8);
  });

  it('coerce strings numéricas a number (Postgres NUMERIC puede venir como string)', async () => {
    rpcMock.mockResolvedValueOnce({
      data: {
        ingresos_brutos: '1500000.00',
        cogs: '600000',
        flete_entregadas: '0',
        flete_devoluciones: '0',
        costo_devoluciones: '0',
        comision_referidos: '12345.50',
        ganancia_markup: '7500',
        valor_cancelado: '180000.00',
        total_cancelados: '4',
        tasa_cancelacion_pct: '8.00',
        utilidad_bruta: '900000',
        total_ordenes: '50',
        total_entregadas: '40',
        total_devueltas: '5',
        tasa_entrega_pct: '80.00',
        ticket_promedio: '37500',
        wallet_neto: '0',
      },
      error: null,
    });

    const { result } = renderHook(
      () => useFinancialSummary('2026-04-01', '2026-04-30'),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.ingresos_brutos).toBe(1500000);
    expect(typeof result.current.data?.utilidad_bruta).toBe('number');
    expect(result.current.data?.utilidad_bruta).toBe(900000);
    expect(typeof result.current.data?.comision_referidos).toBe('number');
    expect(result.current.data?.comision_referidos).toBe(12345.5);
    expect(result.current.data?.ganancia_markup).toBe(7500);
    expect(typeof result.current.data?.valor_cancelado).toBe('number');
    expect(result.current.data?.valor_cancelado).toBe(180000);
    expect(result.current.data?.total_cancelados).toBe(4);
    expect(result.current.data?.tasa_cancelacion_pct).toBe(8);
  });

  it('propaga error si el RPC falla', async () => {
    rpcMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'Solo administradores' },
    });

    const { result } = renderHook(
      () => useFinancialSummary('2026-04-01', '2026-04-30'),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it('queda disabled si from/to son strings vacíos', () => {
    const { result } = renderHook(
      () => useFinancialSummary('', ''),
      { wrapper },
    );
    // enabled=false → fetchStatus 'idle' y nunca se llama el RPC
    expect(rpcMock).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('parsea payload nulo / vacío sin romper', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: null });
    const { result } = renderHook(
      () => useFinancialSummary('2026-04-01', '2026-04-30'),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.utilidad_bruta).toBe(0);
    expect(result.current.data?.ingresos_brutos).toBe(0);
    expect(result.current.data?.comision_referidos).toBe(0);
    expect(result.current.data?.ganancia_markup).toBe(0);
    expect(result.current.data?.valor_cancelado).toBe(0);
    expect(result.current.data?.total_cancelados).toBe(0);
    expect(result.current.data?.tasa_cancelacion_pct).toBe(0);
  });
});

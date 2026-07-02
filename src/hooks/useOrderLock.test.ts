import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Supabase client BEFORE importing the hook.
const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...args: unknown[]) => rpcMock(...args) },
}));

import { renderHook, act } from '@testing-library/react';
import { useOrderLock } from './useOrderLock';

describe('useOrderLock', () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  it('claimOrder returns { ok: true, order } when claim succeeds', async () => {
    rpcMock.mockResolvedValueOnce({
      data: [{
        id: 'order-1',
        nombre: 'Juan',
        phone: '3001234567',
        estado: 'PENDIENTE CONFIRMACION',
        locked_by: 'user-1',
        locked_at: '2026-01-01T00:00:00Z',
      }],
      error: null,
    });

    const { result } = renderHook(() => useOrderLock());
    let claimed: Awaited<ReturnType<typeof result.current.claimOrder>> | undefined;
    await act(async () => {
      claimed = await result.current.claimOrder('order-1');
    });

    expect(rpcMock).toHaveBeenCalledWith('claim_order', { p_order_id: 'order-1' });
    expect(claimed?.ok).toBe(true);
    if (claimed?.ok) {
      expect(claimed.order.dbId).toBe('order-1');
      expect(claimed.order.lockedBy).toBe('user-1');
    }
  });

  it("claimOrder returns { ok: false, reason: 'locked' } when order is locked by another operator (empty result)", async () => {
    rpcMock.mockResolvedValueOnce({ data: [], error: null });

    const { result } = renderHook(() => useOrderLock());
    let claimed: Awaited<ReturnType<typeof result.current.claimOrder>> | undefined;
    await act(async () => {
      claimed = await result.current.claimOrder('order-2');
    });

    expect(claimed).toEqual({ ok: false, reason: 'locked' });
  });

  it("claimOrder returns { ok: false, reason: 'error' } and warns when RPC errors", async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'RLS denied' } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { result } = renderHook(() => useOrderLock());
    let claimed: Awaited<ReturnType<typeof result.current.claimOrder>> | undefined;
    await act(async () => {
      claimed = await result.current.claimOrder('order-3');
    });

    expect(claimed).toEqual({ ok: false, reason: 'error' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('releaseOrder calls release_order RPC with the order id', async () => {
    rpcMock.mockResolvedValueOnce({ error: null });

    const { result } = renderHook(() => useOrderLock());
    await act(async () => {
      await result.current.releaseOrder('order-9');
    });

    expect(rpcMock).toHaveBeenCalledWith('release_order', { p_order_id: 'order-9' });
  });
});

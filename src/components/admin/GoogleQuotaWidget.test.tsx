// src/components/admin/GoogleQuotaWidget.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GoogleQuotaWidget } from './GoogleQuotaWidget';

vi.mock('@/hooks/useGoogleQuota', () => ({
  useGoogleQuota: () => ({
    data: { budget_usd: 2.5, used_usd: 0.43, used_today_date: '2026-04-29', pct: 0.172, exceeded: false },
    isLoading: false,
  }),
}));

describe('GoogleQuotaWidget', () => {
  const wrap = (ui: React.ReactNode) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
  };

  it('muestra usado/budget', () => {
    wrap(<GoogleQuotaWidget />);
    expect(screen.getByText(/0\.43/)).toBeInTheDocument();
    expect(screen.getByText(/2\.50/)).toBeInTheDocument();
  });

  it('muestra porcentaje', () => {
    wrap(<GoogleQuotaWidget />);
    expect(screen.getByText(/17%/)).toBeInTheDocument();
  });
});

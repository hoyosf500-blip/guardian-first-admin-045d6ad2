import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MetricsUpdateBanner } from './MetricsUpdateBanner';

// La fn `bogotaToday` lee la fecha real del sistema. Para el test la
// monkey-patcheamos vía vi.mock para fijar "hoy" en 2026-05-10.
import { vi } from 'vitest';
vi.mock('@/lib/utils', async () => {
  const actual = await vi.importActual<typeof import('@/lib/utils')>('@/lib/utils');
  return { ...actual, bogotaToday: () => '2026-05-10' };
});

describe('MetricsUpdateBanner', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('sin expiresAt, visible si no fue dismissed', () => {
    render(<MetricsUpdateBanner id="t1" message="hola" />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('expiresAt en el futuro, visible', () => {
    render(<MetricsUpdateBanner id="t2" message="hola" expiresAt="2026-05-19" />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('expiresAt en el pasado, NO visible aunque no esté dismissed', () => {
    render(<MetricsUpdateBanner id="t3" message="hola" expiresAt="2026-05-09" />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('dismissed + expiresAt futuro, NO visible (dismiss gana)', () => {
    localStorage.setItem('metrics-banner-dismissed:t4', '1');
    render(<MetricsUpdateBanner id="t4" message="hola" expiresAt="2026-05-19" />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('click en cerrar persiste dismiss en localStorage', () => {
    render(<MetricsUpdateBanner id="t5" message="hola" />);
    fireEvent.click(screen.getByLabelText('Cerrar aviso'));
    expect(localStorage.getItem('metrics-banner-dismissed:t5')).toBe('1');
    expect(screen.queryByRole('status')).toBeNull();
  });
});

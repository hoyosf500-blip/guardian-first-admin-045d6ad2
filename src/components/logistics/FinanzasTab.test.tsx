import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import FinanzasTab from './FinanzasTab';
import type { FinancialSummary } from '@/hooks/useFinancialSummary';

// Tipo del retorno parcial que el componente consume del hook.
interface MockHookReturn {
  data?: FinancialSummary;
  isLoading: boolean;
  isError: boolean;
  error?: Error;
}

const hookMock = vi.fn(() => ({ isLoading: false, isError: false } as MockHookReturn));

vi.mock('@/hooks/useFinancialSummary', () => ({
  useFinancialSummary: () => hookMock(),
}));

const FILTERS = { fromDate: '2026-04-01', toDate: '2026-04-30' };

const SAMPLE: FinancialSummary = {
  ingresos_brutos: 10_000_000,
  cogs: 4_000_000,
  flete_entregadas: 800_000,
  flete_devoluciones: 200_000,
  costo_devoluciones: 100_000,
  comision_referidos: 50_000,
  ganancia_markup: 320_000,
  valor_cancelado: 750_000,
  total_cancelados: 12,
  tasa_cancelacion_pct: 12,
  utilidad_bruta: 4_850_000,
  total_ordenes: 100,
  total_entregadas: 70,
  total_devueltas: 10,
  tasa_entrega_pct: 70,
  ticket_promedio: 142_857,
  wallet_neto: 500_000,
};

describe('FinanzasTab', () => {
  beforeEach(() => {
    hookMock.mockReset();
  });

  it('renderiza utilidad bruta destacada en verde cuando es positiva', () => {
    hookMock.mockReturnValue({ data: SAMPLE, isLoading: false, isError: false });
    render(<FinanzasTab filters={FILTERS} />);
    // Banner Fase A
    expect(screen.getByText(/Fase A/i)).toBeInTheDocument();
    // Utilidad bruta destacada — formatCOP usa $4.850.000 (es-CO con NBSP)
    expect(screen.getByText(/\$\s?4\.850\.000/)).toBeInTheDocument();
    // Hint positivo
    expect(screen.getByText(/operación rentable/i)).toBeInTheDocument();
  });

  it('renderiza utilidad bruta destacada en rojo cuando es negativa', () => {
    hookMock.mockReturnValue({
      data: { ...SAMPLE, utilidad_bruta: -500_000 },
      isLoading: false,
      isError: false,
    });
    render(<FinanzasTab filters={FILTERS} />);
    // formatCOP de un negativo en es-CO incluye el "-"
    expect(screen.getByText(/-\$\s?500\.000/)).toBeInTheDocument();
    expect(screen.getByText(/operación en pérdida/i)).toBeInTheDocument();
  });

  it('muestra los KPIs de ingresos, COGS y tasa de entrega', () => {
    hookMock.mockReturnValue({ data: SAMPLE, isLoading: false, isError: false });
    render(<FinanzasTab filters={FILTERS} />);
    expect(screen.getByText(/Ingresos brutos/i)).toBeInTheDocument();
    // "COGS" aparece en el label del KPI y en el banner — ambos deben estar
    expect(screen.getAllByText(/COGS/i).length).toBeGreaterThan(0);
    expect(screen.getByText('70.0%')).toBeInTheDocument();
    // Volumen de operación: contadores planos
    expect(screen.getByText('100')).toBeInTheDocument();
  });

  it('muestra wallet neto informativo', () => {
    hookMock.mockReturnValue({ data: SAMPLE, isLoading: false, isError: false });
    render(<FinanzasTab filters={FILTERS} />);
    expect(screen.getByText(/Wallet neto del período/i)).toBeInTheDocument();
    expect(screen.getByText(/\$\s?500\.000/)).toBeInTheDocument();
  });

  it('muestra KPI de Cancelados con valor potencial perdido y % cancelación', () => {
    hookMock.mockReturnValue({ data: SAMPLE, isLoading: false, isError: false });
    render(<FinanzasTab filters={FILTERS} />);
    // Card Cancelados reemplazó a "Comisión Referidos"
    expect(screen.getByText(/^Cancelados$/i)).toBeInTheDocument();
    expect(screen.getByText(/\$\s?750\.000/)).toBeInTheDocument();
    // Hint con conteo + % + descriptor
    expect(
      screen.getByText(/12 órdenes \(12\.0%\) — valor potencial perdido/i),
    ).toBeInTheDocument();
  });

  it('NO muestra "Comisión Referidos" en la UI (sale por confirmación del cliente)', () => {
    hookMock.mockReturnValue({ data: SAMPLE, isLoading: false, isError: false });
    render(<FinanzasTab filters={FILTERS} />);
    expect(screen.queryByText(/Comisión referidos/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Descontado de utilidad/i)).not.toBeInTheDocument();
  });

  it('muestra Ganancia markup informativo con disclaimer', () => {
    hookMock.mockReturnValue({ data: SAMPLE, isLoading: false, isError: false });
    render(<FinanzasTab filters={FILTERS} />);
    // "Ganancia markup" aparece en el label del KPI Y en el disclaimer (<strong>)
    expect(screen.getAllByText(/Ganancia markup/i).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/\$\s?320\.000/)).toBeInTheDocument();
    expect(
      screen.getByText(/aparece como referencia/i),
    ).toBeInTheDocument();
  });

  it('muestra skeletons mientras isLoading', () => {
    hookMock.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    const { container } = render(<FinanzasTab filters={FILTERS} />);
    // hero skeleton + 8 KPI skeletons = al menos 8 nodos con animate-pulse
    const skeletons = container.querySelectorAll('.animate-pulse');
    expect(skeletons.length).toBeGreaterThanOrEqual(8);
  });

  it('muestra estado de error si el hook falla', () => {
    hookMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('Solo administradores'),
    });
    render(<FinanzasTab filters={FILTERS} />);
    expect(screen.getByText(/No pudimos cargar las finanzas/i)).toBeInTheDocument();
    expect(screen.getByText(/Solo administradores/)).toBeInTheDocument();
  });
});

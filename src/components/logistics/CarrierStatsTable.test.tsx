import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import CarrierStatsTable from './CarrierStatsTable';
import type { CarrierStats } from '@/lib/logistics.types';

const SAMPLE: CarrierStats[] = [
  {
    transportadora: 'Servientrega',
    total_pedidos: 100, entregados: 70, devueltos: 10,
    en_transito: 20, novedades: 0,
    tasa_entrega: 70, tasa_devolucion: 10,
    valor_entregado: 5000000, valor_perdido: 500000,
    avg_dias_entrega: 3.2,
  },
];

describe('CarrierStatsTable', () => {
  it('renderiza la transportadora con sus métricas', () => {
    render(<CarrierStatsTable rows={SAMPLE} />);
    // El nombre y los % aparecen en varios lugares (insight callouts,
    // tabla, chart YAxis), por eso getAllByText. 3.2d sigue siendo único.
    expect(screen.getAllByText('Servientrega').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/70\.0%/).length).toBeGreaterThan(0);
    expect(screen.getByText('3.2d')).toBeInTheDocument();
  });

  it('muestra empty state si no hay filas', () => {
    render(<CarrierStatsTable rows={[]} />);
    expect(screen.getByText(/no hay transportadoras/i)).toBeInTheDocument();
  });
});

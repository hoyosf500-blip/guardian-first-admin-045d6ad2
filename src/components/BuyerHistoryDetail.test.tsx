import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import BuyerHistoryDetail from './BuyerHistoryDetail';
import { parseBuyerContext } from '@/lib/buyerHistory';

const ctx = parseBuyerContext({
  my_shop: { period_orders: 1 },
  other_shops: { period_orders: 6, period_delivered: 3, period_returned: 2, period_transit: 1 },
  all_shops: {
    period_orders: 9,
    by_courier: [
      { courier_id: 3, delivered: 1, returned: 0, transit: 0 }, // VELOCES (vol 1)
      { courier_id: 1, delivered: 6, returned: 2, transit: 1 }, // LAARCOURIER (vol 9)
    ],
    by_price_range: [{ label: '$30 - $45', total: 2, delivered: 2, returned: 0, transit: 0 }],
    by_payment_type: [{ is_cod: true, delivered: 8, returned: 2, transit: 1 }],
  },
})!;

describe('BuyerHistoryDetail', () => {
  it('cerrado por defecto: solo el botón, sin detalle', () => {
    render(<BuyerHistoryDetail context={ctx} countryCode="EC" />);
    expect(screen.getByText('Ver historial detallado')).toBeInTheDocument();
    expect(screen.queryByText('Por transportadora')).not.toBeInTheDocument();
  });

  it('al abrir muestra transportadoras con nombre (EC), ordenadas por volumen', () => {
    render(<BuyerHistoryDetail context={ctx} countryCode="EC" />);
    fireEvent.click(screen.getByText('Ver historial detallado'));
    expect(screen.getByText('Por transportadora')).toBeInTheDocument();
    // LAARCOURIER (vol 9) antes que VELOCES (vol 1); la más usada lleva el tag.
    const trans = screen.getAllByText(/LAARCOURIER|VELOCES/);
    expect(trans).toHaveLength(2);
    expect(trans[0]).toHaveTextContent('LAARCOURIER');
    expect(trans[1]).toHaveTextContent('VELOCES');
    expect(screen.getByText('más usada')).toBeInTheDocument();
  });

  it('resalta la actividad con OTRAS tiendas en PALABRAS: en camino / entregados / devueltos', () => {
    render(<BuyerHistoryDetail context={ctx} countryCode="EC" />);
    fireEvent.click(screen.getByText('Ver historial detallado'));
    expect(screen.getByText('Con otras tiendas:')).toBeInTheDocument();
    // other_shops: 3 entregados, 2 devueltos, 1 en tránsito → chips con palabras
    expect(screen.getByText('1 en camino')).toBeInTheDocument();
    expect(screen.getByText('3 entregados')).toBeInTheDocument();
    expect(screen.getByText('2 devueltos')).toBeInTheDocument();
    // Con pedidos ACTIVOS (transit>0) el panel entero escala a ámbar — la señal
    // de riesgo COD que motiva el panel.
    expect(screen.getByTestId('otras-tiendas-panel').className).toContain('border-warning');
  });

  it('sin pedidos activos con otras tiendas: chip "0 en camino", singulares bien y panel SIN ámbar', () => {
    const cerrado = parseBuyerContext({
      all_shops: { period_orders: 4 }, my_shop: { period_orders: 1 },
      other_shops: { period_orders: 3, period_delivered: 2, period_returned: 1, period_transit: 0 },
    })!;
    render(<BuyerHistoryDetail context={cerrado} countryCode="EC" />);
    fireEvent.click(screen.getByText('Ver historial detallado'));
    expect(screen.getByText('0 en camino')).toBeInTheDocument();
    expect(screen.getByText('2 entregados')).toBeInTheDocument();
    // singular: "1 devuelto", no "1 devueltos"
    expect(screen.getByText('1 devuelto')).toBeInTheDocument();
    const panel = screen.getByTestId('otras-tiendas-panel');
    expect(panel.className).not.toContain('border-warning');
    expect(panel.className).toContain('border-border');
  });

  it('CO con ID desconocido cae al fallback, no inventa nombre', async () => {
    const co = parseBuyerContext({
      all_shops: { period_orders: 1, by_courier: [{ courier_id: 7, delivered: 1, returned: 0, transit: 0 }] },
      my_shop: {}, other_shops: {},
    })!;
    render(<BuyerHistoryDetail context={co} countryCode="CO" />);
    fireEvent.click(screen.getByText('Ver historial detallado'));
    expect(screen.getByText('Transportadora #7')).toBeInTheDocument();
  });

  it('sin actividad con otras tiendas no muestra la línea de alerta', async () => {
    const solo = parseBuyerContext({
      all_shops: { period_orders: 1, by_courier: [{ courier_id: 1, delivered: 1, returned: 0, transit: 0 }] },
      my_shop: { period_orders: 1 }, other_shops: { period_orders: 0 },
    })!;
    render(<BuyerHistoryDetail context={solo} countryCode="EC" />);
    fireEvent.click(screen.getByText('Ver historial detallado'));
    expect(screen.queryByText('Con otras tiendas:')).not.toBeInTheDocument();
  });
});

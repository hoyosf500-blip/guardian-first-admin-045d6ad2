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

  it('al abrir muestra transportadoras con nombre (EC), ordenadas por volumen', async () => {
    render(<BuyerHistoryDetail context={ctx} countryCode="EC" />);
    fireEvent.click(screen.getByText('Ver historial detallado'));
    expect(screen.getByText('Por transportadora')).toBeInTheDocument();
    const trans = screen.getAllByText(/LAARCOURIER|VELOCES/).map((e) => e.textContent);
    // LAARCOURIER (vol 9) antes que VELOCES (vol 1)
    expect(trans).toEqual(['LAARCOURIER', 'VELOCES']);
  });

  it('resalta la actividad con OTRAS tiendas', async () => {
    render(<BuyerHistoryDetail context={ctx} countryCode="EC" />);
    fireEvent.click(screen.getByText('Ver historial detallado'));
    expect(screen.getByText('Con otras tiendas:')).toBeInTheDocument();
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

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import BuyerHistoryDetail from './BuyerHistoryDetail';
import { parseBuyerContext } from '@/lib/buyerHistory';

const ctx = parseBuyerContext({
  my_shop: { period_orders: 1 },
  other_shops: { period_orders: 6, period_delivered: 3, period_returned: 2, period_transit: 1 },
  all_shops: {
    period_orders: 9, period_delivered: 14, period_returned: 5, period_transit: 1,
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
    // Avatar tipo logo: iniciales estables por nombre ("LA" de LAARCOURIER)
    expect(screen.getByText('LA')).toBeInTheDocument();
    // Las secciones Por precio y Contra entrega también se dibujan
    expect(screen.getByText('Por precio')).toBeInTheDocument();
    expect(screen.getByText('$30 - $45')).toBeInTheDocument();
    expect(screen.getByText('Contra entrega')).toBeInTheDocument();
    expect(screen.getByText('Pago contra entrega')).toBeInTheDocument();
  });

  it('resumen global estilo Dropi: barras con valor visible, en el orden del panel de Dropi', () => {
    render(<BuyerHistoryDetail context={ctx} countryCode="EC" />);
    fireEvent.click(screen.getByText('Ver historial detallado'));
    // Orden tránsito → devoluciones → entregas (getAllByText devuelve orden de documento)
    const labels = screen.getAllByText(/^(En tránsito|Devoluciones|Entregas)$/).map((e) => e.textContent);
    expect(labels).toEqual(['En tránsito', 'Devoluciones', 'Entregas']);
    expect(screen.getByText('14')).toBeInTheDocument(); // entregas
    expect(screen.getByText('5')).toBeInTheDocument(); // devoluciones
    // Rótulo de ventana: son cifras del período, no el histórico del grid grande
    expect(screen.getByText(/Período de análisis Dropi/i)).toBeInTheDocument();
  });

  it('con OTRAS tiendas habla en PALABRAS y escala a ámbar si hay pedidos en tránsito', () => {
    render(<BuyerHistoryDetail context={ctx} countryCode="EC" />);
    fireEvent.click(screen.getByText('Ver historial detallado'));
    expect(screen.getByText('Con otras tiendas:')).toBeInTheDocument();
    // other_shops: 3 entregas, 2 devoluciones, 1 en tránsito → pastillas con
    // palabras, en el ORDEN del panel de Dropi: tránsito → devoluciones → entregas
    const panel = screen.getByTestId('otras-tiendas-panel');
    expect(panel.textContent).toMatch(/1 en tránsito.*2 devoluciones.*3 entregas/);
    expect(panel.className).toContain('border-warning');
  });

  it('sin pedidos en tránsito con otras tiendas: pastilla en 0, singulares bien y panel SIN ámbar', () => {
    const cerrado = parseBuyerContext({
      all_shops: { period_orders: 4 }, my_shop: { period_orders: 1 },
      other_shops: { period_orders: 3, period_delivered: 2, period_returned: 1, period_transit: 0 },
    })!;
    render(<BuyerHistoryDetail context={cerrado} countryCode="EC" />);
    fireEvent.click(screen.getByText('Ver historial detallado'));
    expect(screen.getByText('0 en tránsito')).toBeInTheDocument();
    expect(screen.getByText('2 entregas')).toBeInTheDocument();
    // singular: "1 devolución", no "1 devoluciones"
    expect(screen.getByText('1 devolución')).toBeInTheDocument();
    const panel = screen.getByTestId('otras-tiendas-panel');
    expect(panel.className).not.toContain('border-warning');
    expect(panel.className).toContain('border-border');
  });

  it('CO con ID desconocido cae al fallback, no inventa nombre', () => {
    const co = parseBuyerContext({
      all_shops: { period_orders: 1, by_courier: [{ courier_id: 7, delivered: 1, returned: 0, transit: 0 }] },
      my_shop: {}, other_shops: {},
    })!;
    render(<BuyerHistoryDetail context={co} countryCode="CO" />);
    fireEvent.click(screen.getByText('Ver historial detallado'));
    expect(screen.getByText('Transportadora #7')).toBeInTheDocument();
    // Iniciales del fallback: "T7" (primera letra de cada palabra), no "TR"
    expect(screen.getByText('T7')).toBeInTheDocument();
    // Con UNA sola transportadora, el tag "más usada" no tiene sentido
    expect(screen.queryByText('más usada')).toBeNull();
  });

  it('huella vieja sin desglose global: no dibuja el resumen ni la alerta', () => {
    const solo = parseBuyerContext({
      all_shops: { period_orders: 1, by_courier: [{ courier_id: 1, delivered: 1, returned: 0, transit: 0 }] },
      my_shop: { period_orders: 1 }, other_shops: { period_orders: 0 },
    })!;
    render(<BuyerHistoryDetail context={solo} countryCode="EC" />);
    fireEvent.click(screen.getByText('Ver historial detallado'));
    expect(screen.queryByText('Con otras tiendas:')).not.toBeInTheDocument();
    // all_shops sin period_delivered/returned/transit → sin resumen
    expect(screen.queryByText('Devoluciones')).not.toBeInTheDocument();
    // pero la transportadora sí se lista
    expect(screen.getByText('LAARCOURIER')).toBeInTheDocument();
  });
});

import type { ComponentProps } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import SlaAlertCard from './SlaAlertCard';
import type { OrderData } from '@/lib/orderUtils';

// Mock framer-motion to avoid animation issues in tests
vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: ComponentProps<'div'>) => <div {...props}>{children}</div>,
  },
}));

function makeOrder(overrides: Partial<OrderData> = {}): OrderData {
  return {
    idx: 0, id: '0', externalId: 'EXT-1', dbId: 'db-1',
    nombre: 'Juan', phone: '3111111111', ciudad: 'Bogota',
    producto: 'Crema', estado: 'EN REPARTO', fecha: '2026-04-10',
    fechaConf: '2026-04-11', dias: 5, diasConf: 4,
    valor: 50000, flete: 8000, costoProd: 15000, costoDev: 5000,
    cantidad: 1, direccion: 'Calle 1', barrio: '', novedad: '', guia: 'G123',
    transportadora: 'TCC', tags: '', departamento: 'Cundinamarca',
    tienda: 'Mi tienda', email: '', novedadSol: false,
    ...overrides,
  } as OrderData;
}

describe('SlaAlertCard', () => {
  it('renders nothing when alert level is null (negative dias)', () => {
    const order = makeOrder({ diasConf: -1, dias: -1 });
    const { container } = render(<SlaAlertCard order={order} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders alert info for critical level (3+ days)', () => {
    const order = makeOrder({ diasConf: 3, dias: 5, estado: 'EN REPARTO', transportadora: 'TCC' });
    render(<SlaAlertCard order={order} />);
    expect(screen.getByText(/Posible pérdida/)).toBeTruthy();
  });

  it('shows carrier deadline info', () => {
    const order = makeOrder({ diasConf: 2, dias: 2, transportadora: 'COORDINADORA' });
    render(<SlaAlertCard order={order} />);
    // COORDINADORA appears in multiple elements; verify at least one exists
    expect(screen.getAllByText(/COORDINADORA/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/deadline/).length).toBeGreaterThan(0);
  });

  it('shows office countdown for RECLAME EN OFICINA', () => {
    const order = makeOrder({ diasConf: 3, dias: 3, estado: 'RECLAME EN OFICINA', transportadora: 'COORDINADORA' });
    render(<SlaAlertCard order={order} />);
    expect(screen.getByText(/Plazo de oficina/)).toBeTruthy();
  });

  it('shows novedad rescue window for NOVEDAD state', () => {
    const order = makeOrder({ diasConf: 1, dias: 1, estado: 'NOVEDAD', novedad: 'Direccion incorrecta' });
    render(<SlaAlertCard order={order} />);
    expect(screen.getByText(/Rescate de novedad/)).toBeTruthy();
  });

  it('shows suggested action when needs action', () => {
    const order = makeOrder({ diasConf: 5, dias: 5, estado: 'NOVEDAD', novedad: 'Direccion incorrecta', novedadSol: false });
    render(<SlaAlertCard order={order} />);
    expect(screen.getByText(/Acción sugerida/)).toBeTruthy();
  });

  it('renders ok level for fresh orders (0 days)', () => {
    const order = makeOrder({ diasConf: 1, dias: 0, estado: 'EN REPARTO' });
    render(<SlaAlertCard order={order} />);
    // diasConf=1 > 0, so sinEscaneo = 1 → watch level
    expect(screen.getByText(/Monitorear/)).toBeTruthy();
  });

  it('has role="alert" and aria-live for screen readers', () => {
    const order = makeOrder({ diasConf: 3, dias: 5, estado: 'EN REPARTO' });
    const { container } = render(<SlaAlertCard order={order} />);
    const alertEl = container.querySelector('[role="alert"]');
    expect(alertEl).toBeTruthy();
    expect(alertEl?.getAttribute('aria-live')).toBe('assertive');
  });

  // ── El hueco que nadie probaba (29-ago-2026) ───────────────────────────
  // Todas las pruebas de arriba usan estados YA DESPACHADOS, así que el caso
  // "la transportadora todavía no lo tiene" nunca se ejerció. Medido en
  // producción sobre el pedido 6742720: PENDIENTE CONFIRMACION, guía vacía,
  // fecha_conf null — y la ficha afirmaba "Normal · Escaneo reciente de
  // transportadora · GINTRACOM (deadline 7d)".

  it('⛔ un pedido SIN CONFIRMAR no tiene tarjeta de SLA de transportadora', () => {
    // `diasConf` vale 0 y se queda en 0 para siempre (nunca hubo confirmación),
    // así que el pedido abandonado diez días mostraba un VERDE tranquilizador.
    const order = makeOrder({
      estado: 'PENDIENTE CONFIRMACION', guia: '', fechaConf: '',
      diasConf: 0, dias: 10, transportadora: 'GINTRACOM',
    });
    const { container } = render(<SlaAlertCard order={order} />);
    expect(container.innerHTML).toBe('');
  });

  it('⛔ sin guía NO se afirma un escaneo ni se dibuja la cuenta regresiva', () => {
    // Dropi preasigna la transportadora antes de despachar: su nombre solo NO
    // prueba que el paquete salió. Nadie puede escanear lo que no existe.
    const order = makeOrder({ estado: 'PENDIENTE', guia: '', diasConf: 0, dias: 1, transportadora: 'GINTRACOM' });
    const { container } = render(<SlaAlertCard order={order} />);
    expect(screen.queryByText(/Escaneo reciente/)).toBeNull();
    expect(screen.queryByText(/deadline/)).toBeNull();
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    // Y se dice lo que sí se sabe, con la transportadora al lado.
    expect(screen.getByText(/Todavía sin guía/)).toBeTruthy();
    expect(screen.getByText(/GINTRACOM/)).toBeTruthy();
  });

  it('CON guía el escaneo y el plazo se siguen mostrando igual que siempre', () => {
    const order = makeOrder({ estado: 'EN REPARTO', guia: 'G123', diasConf: 2, dias: 2, transportadora: 'COORDINADORA' });
    const { container } = render(<SlaAlertCard order={order} />);
    expect(screen.getAllByText(/deadline/).length).toBeGreaterThan(0);
    expect(container.querySelector('[role="progressbar"]')).toBeTruthy();
  });

  it('has accessible progressbar with correct values', () => {
    const order = makeOrder({ diasConf: 2, dias: 2, transportadora: 'TCC' });
    const { container } = render(<SlaAlertCard order={order} />);
    const bar = container.querySelector('[role="progressbar"]');
    expect(bar).toBeTruthy();
    expect(bar?.getAttribute('aria-valuenow')).toBeTruthy();
    expect(bar?.getAttribute('aria-valuemin')).toBe('0');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import CustomerHistoryCard from './CustomerHistoryCard';

// Mock framer-motion
vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: Record<string, unknown>) => {
      const { initial, animate, transition, whileHover, whileTap, ...rest } = props as Record<string, unknown>;
      return <div {...(rest as Record<string, string>)}>{children as React.ReactNode}</div>;
    },
  },
}));

// Mock react-router-dom
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

// La tarjeta ahora exige tienda activa (el historial es store-scoped — fix del
// bug de mezcla CO+EC, auditoría 30-jul). Se stubbea el hook, no el provider.
vi.mock('@/contexts/StoreContext', () => ({
  useActiveStoreId: () => 'store-test-1',
}));

const mockSelect = vi.fn();
const mockEq = vi.fn();
const mockNeq = vi.fn();
const mockOrder = vi.fn();
const mockLimit = vi.fn();

// Stub encadenable: la query real ahora es
//   .select().eq(store_id).eq(phone).neq(id).order(fecha).limit(20)   (historial)
//   .select(count).eq(store_id).eq(phone)                              (conteo)
// Cada método devuelve la misma cadena y `await` resuelve {data, count} — así el
// stub no se rompe cada vez que se agrega un filtro.
function makeChain() {
  const chain: Record<string, unknown> = {};
  const self = (fn: (...a: unknown[]) => void) => (...args: unknown[]) => { fn(...args); return chain; };
  chain.select = self((...a) => mockSelect(...a));
  chain.eq = self((...a) => mockEq(...a));
  chain.neq = self((...a) => mockNeq(...a));
  chain.order = self((...a) => mockOrder(...a));
  chain.limit = self((...a) => mockLimit(...a));
  // El conteo real INCLUYE el pedido actual (la query de count no lleva .neq);
  // mockData es solo el historial → count = historial + 1.
  (chain as { then?: unknown }).then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: mockData, count: Array.isArray(mockData) ? mockData.length + 1 : null }).then(resolve);
  return chain;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => makeChain(),
    rpc: () => Promise.resolve({ data: null, error: null }),
  },
}));

let mockData: unknown[] | null = null;

beforeEach(() => {
  mockData = null;
  vi.clearAllMocks();
});

describe('CustomerHistoryCard', () => {
  it('shows first-order message when no other orders exist', async () => {
    mockData = [];
    render(<CustomerHistoryCard currentPhone="3111111111" currentOrderId="order-1" />);
    await waitFor(() => {
      expect(screen.getByText(/Primer pedido/i)).toBeTruthy();
    });
  });

  it('shows loading state initially', () => {
    mockData = null;
    // With null data, it stays in loading since the promise resolves with null
    render(<CustomerHistoryCard currentPhone="3111111111" currentOrderId="order-1" />);
    expect(screen.getByText(/Cargando huella/i)).toBeTruthy();
  });

  it('shows order history with stats when orders exist', async () => {
    mockData = [
      { id: 'o1', external_id: 'EXT-100', nombre: 'Juan', estado: 'ENTREGADO', fecha: '2026-04-01', valor: 50000, producto: 'Crema' },
      { id: 'o2', external_id: 'EXT-101', nombre: 'Juan', estado: 'DEVOLUCION', fecha: '2026-03-15', valor: 30000, producto: 'Gel' },
    ];
    render(<CustomerHistoryCard currentPhone="3111111111" currentOrderId="order-current" />);
    await waitFor(() => {
      expect(screen.getByText(/Huella del comprador/i)).toBeTruthy();
    });
    // Stats: total = 3 (2 history + 1 current). El "3" aparece en el header
    // ("· 3 pedidos") y en el KPI Total, así que usamos getAllByText para no
    // chocar con el "multiple elements" de getByText.
    expect(screen.getAllByText('3').length).toBeGreaterThan(0);
  });

  it('does not load when phone is empty', async () => {
    render(<CustomerHistoryCard currentPhone="" currentOrderId="order-1" />);
    await waitFor(() => {
      expect(screen.getByText(/Primer pedido/i)).toBeTruthy();
    });
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('renders order buttons with accessible labels', async () => {
    mockData = [
      { id: 'o1', external_id: 'EXT-200', nombre: 'Ana', estado: 'EN REPARTO', fecha: '2026-04-10', valor: 75000, producto: 'Suplemento' },
    ];
    render(<CustomerHistoryCard currentPhone="3111111111" currentOrderId="order-current" />);
    await waitFor(() => {
      expect(screen.getByText('#EXT-200')).toBeTruthy();
    });
    const btn = screen.getByRole('button', { name: /EXT-200/ });
    expect(btn).toBeTruthy();
  });
});

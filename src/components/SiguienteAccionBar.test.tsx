import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { OrderData } from '@/lib/orderUtils';

// Los tres contexts que consume la barra. Se mockean porque montarlos de verdad
// arrastraría Supabase, auth y el StoreProvider entero — y lo que se prueba acá
// es la PRESENTACIÓN (a quién se le habla en imperativo y cuándo la barra se
// calla). La decisión de QUÉ mostrar vive en siguienteAccion.ts, que se testea
// puro y sin DOM.
const estado = {
  workQueue: [] as OrderData[],
  segData: [] as OrderData[],
  /** La barra pide la cola de Seguimiento al montarse: en toda pantalla donde
   *  se la ve, nadie más la carga. Ver el guardián de siguienteAccion.test.ts. */
  segLoaded: true,
  novedadesQueue: [] as OrderData[],
  isManagerOfActive: false,
  isAdmin: false,
};

const loadSegData = vi.fn(async () => {});

vi.mock('@/contexts/OrderContext', () => ({
  useOrders: () => ({
    workQueue: estado.workQueue,
    segData: estado.segData,
    segLoaded: estado.segLoaded,
    novedadesQueue: estado.novedadesQueue,
    loadSegData,
  }),
}));
vi.mock('@/contexts/StoreContext', () => ({
  useStore: () => ({ isManagerOfActive: estado.isManagerOfActive }),
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ isAdmin: estado.isAdmin }),
}));

import SiguienteAccionBar from './SiguienteAccionBar';

const base = {
  idx: 0, id: '0', externalId: 'X-1', dbId: 'X-1',
  nombre: 'Test', phone: '3001234567', ciudad: 'BOGOTA', departamento: 'CUNDINAMARCA',
  producto: 'Test', productosDetalle: [], estado: 'PENDIENTE',
  fecha: '', fechaConf: '', dias: 0, diasConf: 0,
  valor: 100000, flete: 8000, costoProd: 30000, costoDev: 0, cantidad: 1,
  direccion: 'Cl 1 # 1-1', novedad: '', guia: '', transportadora: '',
  tags: '', tienda: '', email: '', novedadSol: false,
  barrio: '', complemento: '', documentoDestinatario: '', googlePlaceId: '',
  lat: null, lng: null, validationDecision: null, addressKind: null,
  missingFields: [], suggestedCustomerMessage: '', suggestedAddress: null,
  addressParsed: null, lastMovementAt: null,
} as OrderData;

const dibujar = (ruta = '/dashboard') =>
  render(
    <MemoryRouter initialEntries={[ruta]}>
      <SiguienteAccionBar />
    </MemoryRouter>,
  );

beforeEach(() => {
  loadSegData.mockClear();
  estado.workQueue = [];
  estado.segData = [];
  estado.segLoaded = true;
  estado.novedadesQueue = [];
  estado.isManagerOfActive = false;
  estado.isAdmin = false;
});

describe('SiguienteAccionBar', () => {
  it('sin trabajo dice "Todo al día" y no ofrece botón', () => {
    dibujar();
    expect(screen.getByText(/todo al día/i)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('a la asesora le habla en imperativo', () => {
    estado.novedadesQueue = [base, base];
    dibujar();
    expect(screen.getByText(/resolvé las 2 novedades/i)).toBeInTheDocument();
    expect(screen.getByText('Lo que sigue')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /ir/i })).toBeInTheDocument();
  });

  // ── El pedido original del dueño ────────────────────────────────────
  // "yo como dueño no lo entiendo": SegCounterBar está oculto para él, así que
  // hoy ve MENOS que su equipo. La barra sí lo incluye — pero en neutro: darle
  // una orden a quien no ejecuta la cola es ruido.
  it('al dueño/supervisor le habla en neutro, no en imperativo', () => {
    estado.novedadesQueue = [base, base];
    estado.isManagerOfActive = true;
    dibujar();
    expect(screen.getByText('2 novedades abiertas')).toBeInTheDocument();
    expect(screen.queryByText(/resolvé/i)).toBeNull();
    expect(screen.getByText('La cola')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /ver/i })).toBeInTheDocument();
  });

  it('el admin global también ve la versión neutra', () => {
    estado.novedadesQueue = [base];
    estado.isAdmin = true;
    dibujar();
    expect(screen.getByText('1 novedad abierta')).toBeInTheDocument();
    expect(screen.queryByText(/resolvé/i)).toBeNull();
  });

  it('no se dibuja si ya está parada en la pantalla del escalón', () => {
    estado.novedadesQueue = [base];
    const { container } = dibujar('/novedades');
    expect(container).toBeEmptyDOMElement();
  });

  it('sí se dibuja en otra pantalla', () => {
    estado.novedadesQueue = [base];
    dibujar('/confirmar');
    expect(screen.getByText(/resolvé la novedad/i)).toBeInTheDocument();
  });

  it('compara la ruta SIN el query — /seguimiento?lista=… es /seguimiento', () => {
    // agencia_2d apunta a /seguimiento?lista=agencia_2d. Si la comparación no
    // recortara el query, la barra se seguiría dibujando encima de la propia
    // lista que acaba de abrir.
    estado.segData = [{
      ...base,
      estado: 'RECLAMAR EN OFICINA',
      lastMovementAt: new Date(Date.now() - 60 * 3600 * 1000).toISOString(),
    }];
    const { container } = dibujar('/seguimiento');
    expect(container).toBeEmptyDOMElement();
  });

  it('usa role="status", no "alert" (el conteo cambia con cada realtime)', () => {
    estado.novedadesQueue = [base];
    dibujar();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

// ── GUARDIÁN ──────────────────────────────────────────────────────────
// La barra vive en pantallas donde NADIE más carga la cola de Seguimiento —
// `SeguimientoTab` es el único que llamaba a `loadSegData`, y la barra se
// esconde justamente ahí. Sin esto, cuatro de los seis escalones no podían
// dispararse nunca (medido en el Dashboard de Colombia, 21-ago-2026).
describe('GUARDIÁN: la barra pide la cola que necesita', () => {
  it('pide la cola de Seguimiento al montarse', () => {
    dibujar();
    expect(loadSegData).toHaveBeenCalled();
  });

  it('mientras la cola no esté leída no dibuja NADA, ni "Todo al día"', () => {
    estado.segLoaded = false;
    const { container } = dibujar();
    expect(container).toBeEmptyDOMElement();
  });

  it('lo que sí está cargado se muestra igual mientras Seguimiento llega', () => {
    estado.segLoaded = false;
    estado.novedadesQueue = [base];
    dibujar();
    expect(screen.getByText(/novedad/i)).toBeInTheDocument();
  });
});

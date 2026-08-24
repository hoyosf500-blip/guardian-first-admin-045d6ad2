import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

// Mock del nuevo hook useGananciaNetaDropi — devuelve datos sintéticos
// representativos. Los tests pueden anular con gananciaHookMock.mockReturnValue
// si quieren probar otros escenarios (negativos, loading, etc).
interface MockGananciaReturn {
  data?: {
    total_entradas: number;
    total_salidas: number;
    ganancia_neta: number;
    movimientos_count: number;
    desglose: Record<string, number>;
  };
  isLoading: boolean;
}

const gananciaHookMock = vi.fn((): MockGananciaReturn => ({
  data: {
    total_entradas: 23_728_183,
    total_salidas: 5_295_612,
    ganancia_neta: 18_432_571,
    movimientos_count: 484,
    desglose: {
      ganancia_dropshipper: 22_000_000,
      ganancia_proveedor: 0,
      reembolso_flete: 1_700_000,
      indemnizacion: 28_183,
      flete_inicial: 4_500_000,
      costo_devolucion: 600_000,
      comision_referidos: 50_000,
      mantenimiento_tarjeta: 25_000,
      orden_sin_recaudo: 120_612,
    },
  },
  isLoading: false,
}));

vi.mock('@/hooks/useGananciaNetaDropi', () => ({
  useGananciaNetaDropi: () => gananciaHookMock(),
}));

// Mock useOperativoCohorte — el hero usa el cohorte (operativo real) cuando está
// disponible, con fallback a la caja del wallet (gananciaNeta). Por defecto null
// → fallback, así los tests del valor de caja siguen valiendo. Un test lo anula.
const cohorteHookMock = vi.fn((): { data: null | Record<string, number>; isLoading: boolean } => ({
  data: null,
  isLoading: false,
}));

vi.mock('@/hooks/useOperativoCohorte', () => ({
  useOperativoCohorte: () => cohorteHookMock(),
}));

// Mock useWalletDailySeries — el rediseño usa este hook para alimentar
// el CashFlowChart. Sin mock, React Query falla por falta de QueryClient
// en jsdom. Los tests no validan el chart en sí, solo necesitamos que
// el componente monte sin crashear.
vi.mock('@/hooks/useWalletMovements', () => ({
  useWalletDailySeries: () => ({
    data: [
      { fecha: '2026-04-01', ENTRADA: 1_500_000, SALIDA: 200_000 },
      { fecha: '2026-04-02', ENTRADA: 800_000, SALIDA: 150_000 },
    ],
    isLoading: false,
  }),
  useWalletMovements: () => ({ data: undefined, isLoading: false }),
}));

// El badge de frescura del wallet usa StoreContext + react-query, no provistos
// en este render aislado. No es objeto de estos tests → lo mockeamos a nada.
vi.mock('@/components/wallet/WalletSyncBadge', () => ({ default: () => null }));

// El botón "Sincronizar" usa useResumenSync (mutation) + useStore (gate owner).
// Render aislado sin QueryClientProvider/StoreProvider → mockeamos ambos. El
// mutate es un spy para verificar que pasa el rango del filtro.
const resumenSyncMock = { mutate: vi.fn(), isPending: false };
vi.mock('@/hooks/useResumenSync', () => ({
  useResumenSync: () => resumenSyncMock,
}));

// Sin movimientos 'otro' por defecto: el banner de "sin clasificar" solo se
// prueba aparte. (Mockearlo evita el QueryClient real en jsdom.)
vi.mock('@/hooks/useWalletSinClasificar', () => ({
  useWalletSinClasificar: () => ({ data: null }),
}));

// Sección "Pauta y neto": bitácora diaria + costos mensuales. Mockeados para no
// necesitar QueryClient ni red. Default: bitácora leída OK y vacía (pauta $0
// legítima), sin valor mensual guardado.
interface MockAdSpendRow { spend_date: string; amount: number; platform: string }
interface MockAdSpendReturn {
  data?: MockAdSpendRow[];
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
}
const adSpendHookMock = vi.fn((): MockAdSpendReturn => ({ data: [], isLoading: false, isError: false }));
vi.mock('@/hooks/useStoreAdSpend', () => ({
  useStoreAdSpendRange: () => adSpendHookMock(),
  // Reimplementación mínima (pura) de la suma: NO usamos importActual porque el
  // módulo real importa el client de Supabase, que revienta sin .env (CI).
  sumAdSpend: (rows: MockAdSpendRow[]) => ({
    meta: 0, tiktok: 0, other: 0,
    total: rows.reduce((acc, r) => acc + r.amount, 0),
  }),
}));

const monthlyCostsHookMock = vi.fn(() => ({
  data: { pauta_meta: 0, pauta_tiktok: 0, costos_admin: 0 },
  isLoading: false,
}));
vi.mock('@/hooks/useLogisticaMonthlyCosts', () => ({
  useLogisticaMonthlyCosts: () => monthlyCostsHookMock(),
}));

const storeMock = vi.fn((): { isOwnerOfActive: boolean } => ({ isOwnerOfActive: true }));
vi.mock('@/contexts/StoreContext', () => ({
  useStore: () => storeMock(),
  useActiveStoreId: () => 'test-store-id',
}));

const FILTERS = { fromDate: '2026-04-01', toDate: '2026-04-30' };

const SAMPLE: FinancialSummary = {
  ingresos_brutos: 10_000_000,
  cogs: 4_000_000,
  flete_entregadas: 800_000,
  flete_devoluciones: 200_000,
  costo_devoluciones: 100_000,
  perdida_total_devoluciones: 300_000,    // flete_devs (200k) + costo_devs (100k)
  costo_promedio_devolucion: 30_000,      // 300k / 10 devs
  mantenimiento_tarjeta: 25_000,
  indemnizaciones: 21_980,
  comision_referidos: 50_000,
  ganancia_markup: 320_000,
  valor_cancelado: 750_000,
  total_cancelados: 12,
  tasa_cancelacion_pct: 12,
  utilidad_bruta: 4_850_000,
  total_ordenes: 100,
  total_entregadas: 70,
  total_devueltas: 10,
  total_rechazadas: 0,
  tasa_entrega_pct: 70,
  ticket_promedio: 142_857,
  wallet_neto: 500_000,
};

describe('FinanzasTab', () => {
  beforeEach(() => {
    hookMock.mockReset();
    // Por defecto el cohorte no está disponible → el hero cae a la caja del wallet,
    // así los tests del valor de caja (18.432.571) siguen valiendo.
    cohorteHookMock.mockReturnValue({ data: null, isLoading: false });
    // Reset el mock de ganancia neta a su valor por defecto sintético
    gananciaHookMock.mockReturnValue({
      data: {
        total_entradas: 23_728_183,
        total_salidas: 5_295_612,
        ganancia_neta: 18_432_571,
        movimientos_count: 484,
        desglose: {
          ganancia_dropshipper: 22_000_000,
          ganancia_proveedor: 0,
          reembolso_flete: 1_700_000,
          indemnizacion: 28_183,
          flete_inicial: 4_500_000,
          costo_devolucion: 600_000,
          comision_referidos: 50_000,
          mantenimiento_tarjeta: 25_000,
          orden_sin_recaudo: 120_612,
        },
      },
      isLoading: false,
    });
    resumenSyncMock.mutate.mockReset();
    resumenSyncMock.isPending = false;
    storeMock.mockReturnValue({ isOwnerOfActive: true });
    adSpendHookMock.mockReturnValue({ data: [], isLoading: false, isError: false });
    monthlyCostsHookMock.mockReturnValue({
      data: { pauta_meta: 0, pauta_tiktok: 0, costos_admin: 0 },
      isLoading: false,
    });
  });

  it('renderiza la card hero "Ganancia Neta Dropi" con el valor del hook nuevo', () => {
    hookMock.mockReturnValue({ data: SAMPLE, isLoading: false, isError: false });
    render(<FinanzasTab filters={FILTERS} />);
    // Banner "cómo leer" — en español llano (antes decía "Fase A — Cash flow
    // operativo Dropi", jerga que el dueño no entendía)
    expect(screen.getByText(/Cómo leer esta pestaña/i)).toBeInTheDocument();
    expect(screen.getByText(/mezclan pedidos de meses anteriores/i)).toBeInTheDocument();
    expect(screen.getByText(/La pauta ahora sí se muestra/i)).toBeInTheDocument();
    // Card hero con el label nuevo
    expect(screen.getByText(/Ganancia Neta Dropi/i)).toBeInTheDocument();
    // Valor formateado de 18.432.571 — sin cohorte el hero usa la caja (gn), la
    // card "Wallet neto" también muestra gn, y "Neto después de pauta" (pauta $0)
    // da el mismo número → aparece varias veces.
    expect(screen.getAllByText(/\$\s?18\.432\.571/).length).toBeGreaterThanOrEqual(1);
    // Hint con desglose entradas vs salidas
    expect(screen.getByText(/entró.*23\.728\.183.*te debitó.*5\.295\.612/i)).toBeInTheDocument();
    // Sin cohorte disponible (default null) el hero usa la CAJA del wallet —
    // rotulada en llano como "plata movida en el rango".
    expect(screen.getByText(/plata movida en el rango/i)).toBeInTheDocument();
  });

  it('usa el OPERATIVO POR COHORTE en el hero cuando está disponible (no la caja inflada)', () => {
    hookMock.mockReturnValue({ data: SAMPLE, isLoading: false, isError: false });
    cohorteHookMock.mockReturnValue({
      data: { operativo: 4_800_000, total_entradas: 7_000_000, total_salidas: 2_200_000, movimientos_sin_link: 0 },
      isLoading: false,
    });
    render(<FinanzasTab filters={FILTERS} />);
    // El hero muestra el cohorte ($4.800.000; con pauta $0 el "Neto después de
    // pauta" repite el número). La caja del wallet ($18.432.571) ya NO infla el
    // hero, pero SÍ aparece (una sola vez) en la card "Wallet neto del período"
    // abajo — son dos perspectivas distintas y deliberadas.
    expect(screen.getAllByText(/\$\s?4\.800\.000/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/\$\s?18\.432\.571/).length).toBe(1);
    // El subtítulo del hero indica que va por pedidos creados, no por caja.
    expect(screen.getByText(/pedidos creados en el mes/i)).toBeInTheDocument();
    expect(screen.queryByText(/plata movida en el rango/i)).not.toBeInTheDocument();
  });

  it('renderiza la card hero en rojo cuando la ganancia neta es negativa', () => {
    hookMock.mockReturnValue({ data: SAMPLE, isLoading: false, isError: false });
    gananciaHookMock.mockReturnValue({
      data: {
        total_entradas: 1_000_000,
        total_salidas: 1_500_000,
        ganancia_neta: -500_000,
        movimientos_count: 10,
        desglose: {
          ganancia_dropshipper: 1_000_000,
          ganancia_proveedor: 0,
          reembolso_flete: 0,
          indemnizacion: 0,
          flete_inicial: 1_500_000,
          costo_devolucion: 0,
          comision_referidos: 0,
          mantenimiento_tarjeta: 0,
          orden_sin_recaudo: 0,
        },
      },
      isLoading: false,
    });
    render(<FinanzasTab filters={FILTERS} />);
    // formatCOP de un negativo en es-CO incluye el "-". gn=-500.000 aparece en el
    // hero (modo caja) y en la card "Wallet neto" → al menos una vez en rojo.
    expect(screen.getAllByText(/-\$\s?500\.000/).length).toBeGreaterThanOrEqual(1);
  });

  it('mantiene la "Utilidad bruta contable" como KPI secundario en el grid', () => {
    hookMock.mockReturnValue({ data: SAMPLE, isLoading: false, isError: false });
    render(<FinanzasTab filters={FILTERS} />);
    // Card "Utilidad bruta contable" reemplaza a la hero vieja — ahora va en el grid
    expect(screen.getByText(/Utilidad bruta contable/i)).toBeInTheDocument();
    // El valor de utilidad_bruta (4.850.000) sigue mostrándose acá
    expect(screen.getByText(/\$\s?4\.850\.000/)).toBeInTheDocument();
    // Con su hint característico
    expect(screen.getByText(/incluye COGS aunque Dropi lo pague directo/i)).toBeInTheDocument();
  });

  it('muestra los KPIs de ingresos, COGS y tasa de entrega', () => {
    hookMock.mockReturnValue({ data: SAMPLE, isLoading: false, isError: false });
    render(<FinanzasTab filters={FILTERS} />);
    // "Ingresos brutos" vive SOLO en el hero: la card duplicada del grid
    // secundario se quitó (mismo número dos veces = ruido). Su hint viejo
    // ("Solo pedidos entregados") es el pin de que la card del grid no volvió.
    expect(screen.getAllByText(/Ingresos brutos/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/Solo pedidos entregados/i)).not.toBeInTheDocument();
    // "COGS" aparece en el label del KPI y en el banner — ambos deben estar
    expect(screen.getAllByText(/COGS/i).length).toBeGreaterThan(0);
    // "87%" = tasa de entrega MADURA (70 entregadas ÷ 80 resueltas = 87.5 →
    // floor 87; round mostraba "100%" con devoluciones reales) — aparece
    // en el KPI "Tasa de entrega" Y en el centro del donut (auditoría
    // 2026-07-07: antes el donut mostraba 70/100 diluido, con pendientes y
    // canceladas en el denominador, al lado del KPI maduro).
    expect(screen.getAllByText('87%').length).toBeGreaterThanOrEqual(1);
    // Volumen de operación: contadores planos
    expect(screen.getByText('100')).toBeInTheDocument();
  });

  it('muestra wallet neto OPERATIVO (caja del wallet), no el wallet_neto contable', () => {
    // SAMPLE.wallet_neto = 500.000 viene de financial_summary (suma TODOS los
    // movimientos, incluye tesorería). La card debe mostrar la caja OPERATIVA
    // (gananciaNeta.ganancia_neta = 18.432.571 = entradas − salidas operativas),
    // consistente con la composición de arriba. Ver fix-first review 2026-06-24.
    hookMock.mockReturnValue({ data: SAMPLE, isLoading: false, isError: false });
    render(<FinanzasTab filters={FILTERS} />);
    expect(screen.getByText(/Wallet neto del período/i)).toBeInTheDocument();
    // El valor contable (500.000) NO debe renderizarse en ningún lado.
    expect(screen.queryByText(/\$\s?500\.000/)).not.toBeInTheDocument();
    // La caja operativa (18.432.571) aparece — hero (modo caja) + card wallet neto.
    expect(screen.getAllByText(/\$\s?18\.432\.571/).length).toBeGreaterThanOrEqual(1);
  });

  it('el dueño ve el botón Sincronizar y dispara órdenes+wallet con el rango del filtro', () => {
    hookMock.mockReturnValue({ data: SAMPLE, isLoading: false, isError: false });
    render(<FinanzasTab filters={FILTERS} />);
    const btn = screen.getByRole('button', { name: /Sincronizar/i });
    fireEvent.click(btn);
    // Mismo shape que MesActualResumen: { from, untill } con el rango del filtro.
    expect(resumenSyncMock.mutate).toHaveBeenCalledWith({ from: '2026-04-01', untill: '2026-04-30' });
  });

  it('un NO-dueño no ve el botón Sincronizar (gate isOwnerOfActive)', () => {
    storeMock.mockReturnValue({ isOwnerOfActive: false });
    hookMock.mockReturnValue({ data: SAMPLE, isLoading: false, isError: false });
    render(<FinanzasTab filters={FILTERS} />);
    expect(screen.queryByRole('button', { name: /Sincronizar/i })).not.toBeInTheDocument();
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

  it('la composición de gastos SÍ lista "Comisión referidos" cuando es > 0 (auditoría 2026-07-02: el total Salidas la incluye, sin el ítem la composición no sumaba)', () => {
    hookMock.mockReturnValue({ data: SAMPLE, isLoading: false, isError: false });
    render(<FinanzasTab filters={FILTERS} />);
    expect(screen.getByText(/Comisión referidos/i)).toBeInTheDocument();
    // La CARD vieja "Comisión Referidos" (hint "Descontado de utilidad") sigue
    // eliminada — esto es solo el ítem de la composición para que Σ = Salidas.
    expect(screen.queryByText(/Descontado de utilidad/i)).not.toBeInTheDocument();
  });

  it('muestra card "Pérdida por devoluciones" con total + promedio (RPC v6)', () => {
    hookMock.mockReturnValue({ data: SAMPLE, isLoading: false, isError: false });
    render(<FinanzasTab filters={FILTERS} />);
    // Reemplazó a "Costo devoluciones" — ahora muestra la pérdida total real
    expect(screen.getByText(/Pérdida por devoluciones/i)).toBeInTheDocument();
    // Valor total: $300.000 (perdida_total_devoluciones)
    expect(screen.getByText(/\$\s?300\.000/)).toBeInTheDocument();
    // Hint con conteo + promedio: "10 devs — promedio $30.000 c/u"
    expect(
      screen.getByText(/10 devs — promedio \$\s?30\.000 c\/u/i),
    ).toBeInTheDocument();
    // La card vieja "Costo devoluciones" ya no debe estar
    expect(screen.queryByText(/^Costo devoluciones$/i)).not.toBeInTheDocument();
  });

  it('muestra desglose flete de ida + cargo extra Dropi debajo del grid', () => {
    hookMock.mockReturnValue({ data: SAMPLE, isLoading: false, isError: false });
    render(<FinanzasTab filters={FILTERS} />);
    // Mini-info italica: "Pérdida devoluciones = Flete de ida (...) + Cargo extra Dropi (...)"
    const desglose = screen.getByText(/Pérdida devoluciones\s*=\s*Flete de ida/i);
    expect(desglose).toBeInTheDocument();
    // El desglose contiene literal "Cargo extra Dropi" y los numeros.
    // Usamos textContent del <div> entero porque formatCOP inserta los valores
    // como text nodes ininterrumpidos.
    expect(desglose.textContent).toMatch(/Cargo extra Dropi/i);
    expect(desglose.textContent).toMatch(/200\.000/);
    expect(desglose.textContent).toMatch(/100\.000/);
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

  it('Pauta y neto: con bitácora diaria muestra pauta, neto después de pauta y CPA real', () => {
    hookMock.mockReturnValue({ data: SAMPLE, isLoading: false, isError: false });
    adSpendHookMock.mockReturnValue({
      data: [
        { spend_date: '2026-04-03', amount: 100_000, platform: 'meta' },
        { spend_date: '2026-04-04', amount: 40_000, platform: 'tiktok' },
      ],
      isLoading: false,
      isError: false,
    });
    render(<FinanzasTab filters={FILTERS} />);
    expect(screen.getByText(/Pauta y neto/i)).toBeInTheDocument();
    // Pauta del período = suma de la bitácora (140.000)
    expect(screen.getByText(/^Pauta del período$/i)).toBeInTheDocument();
    expect(screen.getByText(/\$\s?140\.000/)).toBeInTheDocument();
    // Cobertura en la cara: abril (pasado) tiene 30 días y solo 2 anotados.
    expect(screen.getByText(/2 de 30 días anotados/i)).toBeInTheDocument();
    // Neto después de pauta = caja del hero (18.432.571) − pauta (140.000)
    expect(screen.getByText(/Neto después de pauta/i)).toBeInTheDocument();
    expect(screen.getByText(/\$\s?18\.292\.571/)).toBeInTheDocument();
    // CPA real = 140.000 ÷ 70 entregadas = 2.000
    expect(screen.getByText(/CPA real/i)).toBeInTheDocument();
    expect(screen.getByText(/\$\s?2\.000$/)).toBeInTheDocument();
    expect(screen.getByText(/pauta ÷ entregas del período/i)).toBeInTheDocument();
  });

  it('Pauta y neto: si la lectura de pauta FALLA, las tres tarjetas van en "—" (nunca resta $0 en silencio)', () => {
    hookMock.mockReturnValue({ data: SAMPLE, isLoading: false, isError: false });
    // Error REAL (no "migration sin aplicar"): isRpcMissing devuelve false.
    adSpendHookMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('permission denied'),
    });
    render(<FinanzasTab filters={FILTERS} />);
    // Las tres tarjetas en '—' + el aviso — un "Neto después de pauta" calculado
    // restando $0 sería un dato inventado.
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByText(/no se pudo leer tu pauta/i).length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText(/sin ese dato no restamos nada/i)).toBeInTheDocument();
    // El neto NO se muestra como si la pauta fuera $0 (18.432.571 seguiría
    // apareciendo, pero solo como hero + wallet neto, no como "neto después de pauta").
    expect(screen.getAllByText(/\$\s?18\.432\.571/).length).toBe(2);
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

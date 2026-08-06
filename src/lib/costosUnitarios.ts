/**
 * Costos unitarios: cuánto cuesta REALMENTE una entrega y cuánto una devolución.
 * Función PURA sobre lo que devuelve el RPC `costos_unitarios`.
 *
 * LA IDEA CENTRAL, QUE ES ARITMÉTICA Y NO OPINIÓN
 * El flete que factura la transportadora es lo que cuesta un envío que LLEGA.
 * Pero por cada envío que no llega también se pagó flete, y ese costo lo tienen
 * que absorber las entregas que sí ocurrieron. Entonces:
 *
 *     costo real por entrega ≈ flete nominal ÷ tasa de entrega
 *
 * Medido en Colombia (may–jul 2026) la relación se cumple con tres decimales:
 *   mayo  1,50× real/nominal vs 1,46× de 1÷tasa
 *   junio 1,45×              vs 1,45×
 *   julio 1,28×              vs 1,29×
 *
 * La consecuencia práctica: el flete no lo controla la transportadora, lo
 * controla la tasa de entrega. En julio el flete nominal SUBIÓ $1.362 y el costo
 * real por entrega igual BAJÓ $1.945, solo porque la entrega pasó de 69% a 77,5%.
 *
 * CONFIABILIDAD DEL CARGO DE DEVOLUCIÓN
 * El cargo que Dropi cobra aparte del flete vive en la billetera. Si la billetera
 * está incompleta —el caso de Colombia, con ~1 de cada 10 cargos— el promedio es
 * ruido con cara de dato. Por eso `cargoDevolucionConfiable` es parte del
 * resultado y no un detalle de la UI: quien muestre la cifra tiene que poder
 * decir sobre cuántos casos se midió.
 */

/** Fila cruda del RPC `costos_unitarios`. */
export interface CostosCrudos {
  entregados: number;
  devueltos: number;
  ingresos_entregados: number;
  cogs_entregados: number;
  flete_entregados: number;
  flete_devueltos: number;
  cargo_devolucion_total: number;
  devoluciones_con_cargo: number;
  pauta_periodo: number;
}

/** Cobertura mínima (cargos medidos ÷ devoluciones) para creerle al promedio. */
export const COBERTURA_CARGO_MINIMA = 0.6;

export interface CostosUnitarios {
  entregados: number;
  devueltos: number;
  /** entregados + devueltos. Denominador de la tasa madura. */
  resueltos: number;
  /** entregados ÷ resueltos, 0-100. `null` sin pedidos concluidos. */
  tasaEntrega: number | null;

  /** Lo que factura la transportadora por una entrega. `null` sin entregas. */
  fletePorEntrega: number | null;
  /** (flete entregados + flete devueltos) ÷ entregados. Lo que cuesta de verdad. */
  fleteRealPorEntrega: number | null;
  /** fleteReal ÷ fleteNominal. Cuánto se multiplica el flete por no entregar. */
  multiplicador: number | null;
  /** Plata que se va en fletes de pedidos que nunca llegaron. */
  fletePerdido: number;

  /** Cargo promedio por devolución, según la billetera. `null` si no hay datos. */
  cargoPorDevolucion: number | null;
  /** Fracción de devoluciones con su cargo registrado (0-1). */
  coberturaCargo: number;
  /** `false` → la billetera está incompleta: mostrar la cifra atenuada o no mostrarla. */
  cargoDevolucionConfiable: boolean;
  /** flete + cargo. Lo que cuesta cada pedido que se devuelve. `null` sin cargo fiable. */
  costoTotalPorDevolucion: number | null;

  /** Valor promedio de una venta entregada. */
  ticketPromedio: number | null;
  /** Costo de producto por entrega. */
  cogsPorEntrega: number | null;
  /** Pauta ÷ entregados: lo que costó conseguir cada venta que llegó. */
  costoPorVenta: number | null;

  /** ticket − cogs − flete real − cargo devolución prorrateado. `null` si falta base. */
  margenPorEntrega: number | null;
  /** margen ÷ ticket, 0-100. */
  margenPct: number | null;
}

function div(a: number, b: number): number | null {
  return b > 0 ? a / b : null;
}

function pct(a: number, b: number): number | null {
  const r = div(a, b);
  return r == null ? null : Math.round(r * 1000) / 10;
}

export function calcularCostosUnitarios(c: CostosCrudos | null | undefined): CostosUnitarios | null {
  if (!c) return null;

  const entregados = Math.max(0, c.entregados || 0);
  const devueltos = Math.max(0, c.devueltos || 0);
  const resueltos = entregados + devueltos;

  const fleteEnt = Math.max(0, c.flete_entregados || 0);
  const fleteDev = Math.max(0, c.flete_devueltos || 0);

  const fletePorEntrega = div(fleteEnt, entregados);
  const fleteRealPorEntrega = div(fleteEnt + fleteDev, entregados);

  const conCargo = Math.max(0, c.devoluciones_con_cargo || 0);
  const cargoPorDevolucion = div(Math.max(0, c.cargo_devolucion_total || 0), conCargo);
  // Cobertura sobre las devoluciones REALES, no sobre los cargos encontrados: el
  // punto es cuántas quedaron sin registrar.
  const coberturaCargo = devueltos > 0 ? Math.min(1, conCargo / devueltos) : 0;
  const cargoDevolucionConfiable =
    cargoPorDevolucion != null && devueltos > 0 && coberturaCargo >= COBERTURA_CARGO_MINIMA;

  const fleteDevUnit = div(fleteDev, devueltos);
  const costoTotalPorDevolucion =
    cargoDevolucionConfiable && fleteDevUnit != null
      ? fleteDevUnit + (cargoPorDevolucion as number)
      : null;

  const ticketPromedio = div(Math.max(0, c.ingresos_entregados || 0), entregados);
  const cogsPorEntrega = div(Math.max(0, c.cogs_entregados || 0), entregados);
  const costoPorVenta = div(Math.max(0, c.pauta_periodo || 0), entregados);

  // Margen por entrega: al ticket se le restan el producto, el flete REAL (que ya
  // incluye el de los devueltos) y el cargo de devolución PRORRATEADO entre las
  // entregas. Si el cargo no es confiable se omite y el margen queda OPTIMISTA —
  // por eso la UI tiene que decir que falta ese dato, no presentarlo como cerrado.
  const cargoProrrateado =
    cargoDevolucionConfiable && cargoPorDevolucion != null
      ? (cargoPorDevolucion * devueltos) / (entregados || 1)
      : 0;
  const margenPorEntrega =
    ticketPromedio != null && fleteRealPorEntrega != null
      ? ticketPromedio - (cogsPorEntrega ?? 0) - fleteRealPorEntrega - cargoProrrateado
      : null;

  return {
    entregados,
    devueltos,
    resueltos,
    tasaEntrega: pct(entregados, resueltos),
    fletePorEntrega,
    fleteRealPorEntrega,
    multiplicador:
      fletePorEntrega != null && fleteRealPorEntrega != null && fletePorEntrega > 0
        ? Math.round((fleteRealPorEntrega / fletePorEntrega) * 100) / 100
        : null,
    fletePerdido: fleteDev,
    cargoPorDevolucion,
    coberturaCargo,
    cargoDevolucionConfiable,
    costoTotalPorDevolucion,
    ticketPromedio,
    cogsPorEntrega,
    costoPorVenta,
    margenPorEntrega,
    margenPct:
      margenPorEntrega != null && ticketPromedio != null && ticketPromedio > 0
        ? Math.round((margenPorEntrega / ticketPromedio) * 1000) / 10
        : null,
  };
}

// Unit-economics de COD: KPIs reales (tasa de despachos, entrega, devolución,
// inefectividad, ticket) y un simulador de ganancia estilo "calculadora de precios".
// Funciones PURAS y testeables — el componente solo inyecta datos y pinta.
//
// Convención: las tasas/% se manejan en 0-1 internamente (no 0-100). El componente
// formatea a "%". "despachados" = lo que físicamente salió a la transportadora =
// entregado + devuelto + en_transito + novedad (NO incluye pendiente/preparación/
// cancelado). Igual criterio que el embudo de MesActualResumen.

function safeDiv(a: number, b: number): number {
  return b > 0 ? a / b : 0;
}

function clamp01(x: number): number {
  if (!isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

// ── KPIs reales ──────────────────────────────────────────────────────────

export interface RealKpisInput {
  /** Pedidos generados sin cancelados (= "Pedidos generados" de Dropi). */
  generadosSinCancel: number;
  /** Pedidos que salieron a la transportadora (entregado+devuelto+rechazado+tránsito+novedad). */
  despachados: number;
  entregados: number;
  /** Devoluciones logísticas REALES (sin rechazos del cliente). */
  devueltos: number;
  /** Rechazos del cliente — fuera de la tasa de entrega madura, métrica aparte. */
  rechazados: number;
  /** SUM(valor) de los entregados (COP). */
  valorEntregado: number;
}

export interface RealKpis {
  tasaDespachos: number;     // 0-1: despachados / generados
  /** 0-1: entregados / RESUELTOS (entregados + devoluciones reales). "Madura sin
   *  rechazos": no cuenta rechazos del cliente ni pedidos aún en tránsito. */
  tasaEntrega: number;
  pctDevolucion: number;     // 0-1: devoluciones reales / resueltos
  pctRechazo: number;        // 0-1: rechazos / despachados (informativo)
  pctInefectividad: number;  // 0-1: 1 − entregados / generados
  ticketPromedio: number;    // COP: valorEntregado / entregados
  /** 0-1: (devoluciones + rechazos) / despachados. Tasa de NO-entrega sobre lo
   *  despachado — la que usa el simulador para proyectar (no la madura). */
  pctNoEntregaSobreDespacho: number;
}

export function computeRealKpis(i: RealKpisInput): RealKpis {
  // Resueltos = lo que ya concluyó su ciclo de entrega (entregado o devuelto),
  // SIN rechazos ni pedidos aún en la calle. Es el denominador de la tasa madura.
  const resueltos = i.entregados + i.devueltos;
  return {
    tasaDespachos: clamp01(safeDiv(i.despachados, i.generadosSinCancel)),
    tasaEntrega: clamp01(safeDiv(i.entregados, resueltos)),
    pctDevolucion: clamp01(safeDiv(i.devueltos, resueltos)),
    pctRechazo: clamp01(safeDiv(i.rechazados, i.despachados)),
    pctInefectividad:
      i.generadosSinCancel > 0 ? clamp01(1 - safeDiv(i.entregados, i.generadosSinCancel)) : 0,
    ticketPromedio: safeDiv(i.valorEntregado, i.entregados),
    pctNoEntregaSobreDespacho: clamp01(safeDiv(i.devueltos + i.rechazados, i.despachados)),
  };
}

// ── Simulador ────────────────────────────────────────────────────────────

export interface SimulationInput {
  pedidos: number;
  ticket: number;            // COP por pedido
  tasaDespachos: number;     // 0-1
  pctDevolucion: number;     // 0-1, sobre despachados
  costoProductoPct: number;  // 0-1, sobre ingresos entregados
  fletePct: number;          // 0-1, sobre ingresos entregados
  publicidadPct: number;     // 0-1, sobre ingresos entregados
  adminPct: number;          // 0-1, sobre ingresos entregados
  /** Costo por pedido DEVUELTO (flete perdido + cargo). COP. */
  costoDevolucionUnit: number;
}

export interface SimulationResult {
  facturadoPedidos: number;
  facturadoValor: number;
  despachadoPedidos: number;
  despachadoValor: number;
  entregadoPedidos: number;
  devueltoPedidos: number;
  ingresos: number;          // entregadoPedidos × ticket
  cogs: number;
  flete: number;
  publicidad: number;
  admin: number;
  costoDevolucion: number;
  gananciaNeta: number;
  gananciaPct: number;       // 0-1, sobre FACTURADO (como la "utilidad neta" de la calculadora)
  margenEntregaPct: number;  // 0-1, sobre ingresos entregados
}

export function computeSimulation(i: SimulationInput): SimulationResult {
  const pedidos = Math.max(0, i.pedidos);
  const ticket = Math.max(0, i.ticket);
  const tasaDespachos = clamp01(i.tasaDespachos);
  const pctDevolucion = clamp01(i.pctDevolucion);

  const facturadoPedidos = pedidos;
  const facturadoValor = pedidos * ticket;
  const despachadoPedidos = pedidos * tasaDespachos;
  const despachadoValor = despachadoPedidos * ticket;
  const devueltoPedidos = despachadoPedidos * pctDevolucion;
  const entregadoPedidos = despachadoPedidos - devueltoPedidos;
  const ingresos = entregadoPedidos * ticket;

  const cogs = ingresos * clamp01(i.costoProductoPct);
  const flete = ingresos * clamp01(i.fletePct);
  const publicidad = ingresos * clamp01(i.publicidadPct);
  const admin = ingresos * clamp01(i.adminPct);
  const costoDevolucion = devueltoPedidos * Math.max(0, i.costoDevolucionUnit);

  const gananciaNeta = ingresos - cogs - flete - publicidad - admin - costoDevolucion;

  return {
    facturadoPedidos,
    facturadoValor,
    despachadoPedidos,
    despachadoValor,
    entregadoPedidos,
    devueltoPedidos,
    ingresos,
    cogs,
    flete,
    publicidad,
    admin,
    costoDevolucion,
    gananciaNeta,
    gananciaPct: safeDiv(gananciaNeta, facturadoValor),
    margenEntregaPct: safeDiv(gananciaNeta, ingresos),
  };
}

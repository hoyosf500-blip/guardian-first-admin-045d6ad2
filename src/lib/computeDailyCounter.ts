// Deduplica el contador diario de la operadora.
//
// Espeja la lógica del RPC `operator_productivity_stats` v20260505184140:
//   - `conf` y `canc` se cuentan por order_id distinto.
//   - `noresp` se cuenta por order_id distinto Y solo si ese pedido no
//     terminó en conf/canc el mismo día. Si la operadora marca "no
//     contestó" 3 veces el mismo día y luego confirma, el pedido suma
//     a `conf` y NO suma a `noresp`.
//
// Antes el counter sumaba +1 por fila cruda → la operadora veía noresp
// inflado por reintentos del cooldown 2h, divergente del panel admin.

export type CounterRow = {
  order_id: string | null;
  result: string;
  result_date: string | null;
};

export interface DailyCounter {
  conf: number;
  canc: number;
  noresp: number;
}

export function computeDailyCounter(rows: CounterRow[], todayLocal: string): DailyCounter {
  const finalized = new Set<string>();
  const confOrders = new Set<string>();
  const cancOrders = new Set<string>();
  const norespOrders = new Set<string>();

  for (const r of rows) {
    if (r.result_date !== todayLocal) continue;
    if (!r.order_id) continue;
    if (r.result === 'conf') {
      confOrders.add(r.order_id);
      finalized.add(r.order_id);
    } else if (r.result === 'canc') {
      cancOrders.add(r.order_id);
      finalized.add(r.order_id);
    }
  }
  for (const r of rows) {
    if (r.result_date !== todayLocal) continue;
    if (r.result !== 'noresp') continue;
    if (!r.order_id) continue;
    if (finalized.has(r.order_id)) continue;
    norespOrders.add(r.order_id);
  }

  return {
    conf: confOrders.size,
    canc: cancOrders.size,
    noresp: norespOrders.size,
  };
}

/** Fila con la persona que la registró. */
export type CounterRowConOperador = CounterRow & { operator_id: string | null };

export interface ResumenAsesora extends DailyCounter {
  operatorId: string;
  /** conf + canc + noresp — los pedidos que esa persona cerró hoy. */
  total: number;
}

/**
 * El mismo conteo del día, partido POR ASESORA.
 *
 * El dueño lo pidió así: "que yo pueda ver qué pedidos tocan" sin entrar a
 * Productividad y sin preguntarle a nadie. Reusa `computeDailyCounter` fila por
 * fila para que el número de cada asesora salga de la MISMA regla que el número
 * del equipo — si algún día cambia la dedup, cambia para las dos a la vez.
 *
 * OJO con sumar: si Ana marcó "no contestó" y más tarde Sofía confirmó EL MISMO
 * pedido, cada una registra su gestión y la suma da 2 mientras el equipo cuenta
 * 1 pedido. Es correcto: son dos trabajos sobre un pedido. Por eso la pantalla
 * lo rotula "hoy por asesora" y NO lo presenta como el desglose del total.
 */
export function computeDailyCounterByOperator(
  rows: CounterRowConOperador[],
  todayLocal: string,
): ResumenAsesora[] {
  const porOperador = new Map<string, CounterRowConOperador[]>();
  for (const r of rows) {
    if (!r.operator_id) continue;
    const acc = porOperador.get(r.operator_id);
    if (acc) acc.push(r);
    else porOperador.set(r.operator_id, [r]);
  }
  const out: ResumenAsesora[] = [];
  for (const [operatorId, filas] of porOperador) {
    const c = computeDailyCounter(filas, todayLocal);
    const total = c.conf + c.canc + c.noresp;
    if (total === 0) continue; // sin trabajo hoy: no ocupa espacio en pantalla
    out.push({ operatorId, ...c, total });
  }
  // Más trabajo primero; empate por id para que el orden sea estable entre
  // renders (si no, las tarjetas bailan en cada refresh de realtime).
  out.sort((a, b) => b.total - a.total || a.operatorId.localeCompare(b.operatorId));
  return out;
}

// Aplica computeDailyCounter a varias fechas en una sola pasada. Usado por
// DashboardTab para el chart histórico. Mantiene una sola fuente de verdad
// para la dedup — si cambia la regla, cambia en computeDailyCounter y el
// chart la hereda automáticamente.
export function computeDailyCounterByDay(
  rows: CounterRow[],
  dates: string[]
): Record<string, DailyCounter> {
  const out: Record<string, DailyCounter> = {};
  for (const d of dates) out[d] = computeDailyCounter(rows, d);
  return out;
}

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

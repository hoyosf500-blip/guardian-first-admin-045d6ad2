// Test de regresión cross-layer: la dedup vive hoy en 4 lugares —
//   1. SQL (RPC operator_productivity_stats v20260505184140) — no se corre acá
//   2. computeDailyCounter (CounterBar de la operadora)
//   3. DashboardTab chartData → ahora usa computeDailyCounterByDay
//   4. DashboardTab yesterdayData → ahora usa computeDailyCounter
//
// Si alguien cambia la regla en uno y no en los demás, este test falla
// antes de llegar a producción.
import { describe, it, expect } from 'vitest';
import {
  computeDailyCounter,
  computeDailyCounterByDay,
  type CounterRow,
} from './computeDailyCounter';

const TODAY = '2026-05-05';
const YESTERDAY = '2026-05-04';

const rows: CounterRow[] = [
  { order_id: 'A', result: 'noresp', result_date: TODAY },
  { order_id: 'A', result: 'noresp', result_date: TODAY },
  { order_id: 'A', result: 'conf',   result_date: TODAY },
  { order_id: 'B', result: 'noresp', result_date: TODAY },
  { order_id: 'B', result: 'noresp', result_date: TODAY },
  { order_id: 'C', result: 'canc',   result_date: TODAY },
  { order_id: 'D', result: 'noresp', result_date: YESTERDAY },
];

describe('computeDailyCounter — regresión cross-layer', () => {
  it('los 3 layers JS devuelven los mismos números para la fixture canónica', () => {
    const expectedToday = { conf: 1, canc: 1, noresp: 1 };
    const expectedYesterday = { conf: 0, canc: 0, noresp: 1 };

    // Layer 2: CounterBar (OrderContext)
    const counterBarToday = computeDailyCounter(rows, TODAY);

    // Layer 3: DashboardTab chartData
    const byDay = computeDailyCounterByDay(rows, [YESTERDAY, TODAY]);
    const chartToday = byDay[TODAY];
    const chartYesterday = byDay[YESTERDAY];

    // Layer 4: DashboardTab yesterdayData
    const yesterdayPanel = computeDailyCounter(rows, YESTERDAY);

    expect(counterBarToday).toEqual(expectedToday);
    expect(chartToday).toEqual(expectedToday);
    expect(chartYesterday).toEqual(expectedYesterday);
    expect(yesterdayPanel).toEqual(expectedYesterday);

    // Y todos coinciden entre sí — esta es la invariante crítica.
    expect(counterBarToday).toEqual(chartToday);
    expect(yesterdayPanel).toEqual(chartYesterday);
  });
});

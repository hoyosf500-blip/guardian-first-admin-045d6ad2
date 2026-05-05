import { describe, it, expect } from 'vitest';
import { computeDailyCounter, type CounterRow } from './computeDailyCounter';

const TODAY = '2026-05-05';

describe('computeDailyCounter', () => {
  it('3 noresps del mismo pedido cuentan como 1', () => {
    const rows: CounterRow[] = [
      { order_id: 'X', result: 'noresp', result_date: TODAY },
      { order_id: 'X', result: 'noresp', result_date: TODAY },
      { order_id: 'X', result: 'noresp', result_date: TODAY },
    ];
    expect(computeDailyCounter(rows, TODAY)).toEqual({ conf: 0, canc: 0, noresp: 1 });
  });

  it('noresps + conf final del mismo pedido: noresp=0, conf=1', () => {
    const rows: CounterRow[] = [
      { order_id: 'X', result: 'noresp', result_date: TODAY },
      { order_id: 'X', result: 'noresp', result_date: TODAY },
      { order_id: 'X', result: 'conf', result_date: TODAY },
    ];
    expect(computeDailyCounter(rows, TODAY)).toEqual({ conf: 1, canc: 0, noresp: 0 });
  });

  it('noresps de hoy no se mezclan con resultados de otros días', () => {
    const rows: CounterRow[] = [
      { order_id: 'X', result: 'noresp', result_date: '2026-05-04' },
      { order_id: 'Y', result: 'conf', result_date: TODAY },
    ];
    expect(computeDailyCounter(rows, TODAY)).toEqual({ conf: 1, canc: 0, noresp: 0 });
  });

  it('pedidos distintos suman por separado', () => {
    const rows: CounterRow[] = [
      { order_id: 'A', result: 'conf', result_date: TODAY },
      { order_id: 'B', result: 'canc', result_date: TODAY },
      { order_id: 'C', result: 'noresp', result_date: TODAY },
      { order_id: 'D', result: 'noresp', result_date: TODAY },
    ];
    expect(computeDailyCounter(rows, TODAY)).toEqual({ conf: 1, canc: 1, noresp: 2 });
  });

  it('order_id null se ignora (no debería pasar pero defensivo)', () => {
    const rows: CounterRow[] = [
      { order_id: null, result: 'noresp', result_date: TODAY },
    ];
    expect(computeDailyCounter(rows, TODAY)).toEqual({ conf: 0, canc: 0, noresp: 0 });
  });

  it('canc gana sobre noresp del mismo pedido', () => {
    const rows: CounterRow[] = [
      { order_id: 'X', result: 'noresp', result_date: TODAY },
      { order_id: 'X', result: 'canc', result_date: TODAY },
    ];
    expect(computeDailyCounter(rows, TODAY)).toEqual({ conf: 0, canc: 1, noresp: 0 });
  });
});

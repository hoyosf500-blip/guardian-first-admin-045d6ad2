import { describe, it, expect } from 'vitest';
import { computeDailyCounter, computeDailyCounterByOperator, type CounterRow } from './computeDailyCounter';

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

describe('computeDailyCounterByOperator — "hoy por asesora"', () => {
  const HOY = '2026-07-31';
  const f = (operator_id: string, result: string, order_id: string, result_date = HOY) =>
    ({ operator_id, result, order_id, result_date });

  it('parte el trabajo por persona', () => {
    const r = computeDailyCounterByOperator([
      f('ana', 'conf', 'p1'), f('ana', 'conf', 'p2'), f('ana', 'noresp', 'p3'),
      f('sofia', 'canc', 'p4'),
    ], HOY);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ operatorId: 'ana', conf: 2, canc: 0, noresp: 1, total: 3 });
    expect(r[1]).toMatchObject({ operatorId: 'sofia', canc: 1, total: 1 });
  });

  it('usa la MISMA dedup que el contador del equipo: 3 noresp + conf = 1 conf', () => {
    const r = computeDailyCounterByOperator([
      f('ana', 'noresp', 'p1'), f('ana', 'noresp', 'p1'), f('ana', 'noresp', 'p1'),
      f('ana', 'conf', 'p1'),
    ], HOY);
    expect(r[0]).toMatchObject({ conf: 1, noresp: 0, total: 1 });
  });

  it('ordena por trabajo, de más a menos', () => {
    const r = computeDailyCounterByOperator([
      f('ana', 'conf', 'p1'),
      f('sofia', 'conf', 'p2'), f('sofia', 'conf', 'p3'), f('sofia', 'conf', 'p4'),
    ], HOY);
    expect(r.map(x => x.operatorId)).toEqual(['sofia', 'ana']);
  });

  it('no muestra a quien no trabajó hoy', () => {
    const r = computeDailyCounterByOperator([f('ana', 'conf', 'p1', '2026-07-30')], HOY);
    expect(r).toHaveLength(0);
  });

  it('ignora filas sin operator_id (no se pueden atribuir a nadie)', () => {
    const r = computeDailyCounterByOperator([
      { operator_id: null, result: 'conf', order_id: 'p1', result_date: HOY },
    ], HOY);
    expect(r).toHaveLength(0);
  });

  it('dos asesoras sobre el MISMO pedido: cada una registra su trabajo', () => {
    // Ana llamó y no contestaron; Sofía volvió a llamar y confirmó. La suma da 2
    // aunque el equipo cuente 1 pedido — son dos trabajos, y por eso la pantalla
    // lo rotula "por asesora" y no como desglose del total.
    const r = computeDailyCounterByOperator([
      f('ana', 'noresp', 'p1'), f('sofia', 'conf', 'p1'),
    ], HOY);
    expect(r.find(x => x.operatorId === 'ana')!.noresp).toBe(1);
    expect(r.find(x => x.operatorId === 'sofia')!.conf).toBe(1);
  });
});

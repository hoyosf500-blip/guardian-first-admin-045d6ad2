import { describe, it, expect } from 'vitest';
import {
  bogotaDay,
  markBogotaDay,
  defaultMarkRange,
  filterMarksByRange,
  groupMarksByDay,
  markReconStatus,
  type ManualMark,
} from './shopifyMarks';

const mk = (id: string, marked_at: string, extra: Partial<ManualMark> = {}): ManualMark => ({
  id,
  shopify_order_id: id,
  shopify_name: `#${id}`,
  customer: 'X',
  phone: '3001234567',
  total: 1000,
  city: 'Bogotá',
  marked_at,
  ...extra,
});

describe('bogotaDay / markBogotaDay (UTC-5)', () => {
  it('mapea mediodía UTC al mismo día en Bogotá', () => {
    expect(bogotaDay(Date.UTC(2026, 5, 30, 17, 0, 0))).toBe('2026-06-30');
  });
  it('madrugada UTC cae al día ANTERIOR en Bogotá (cruce de medianoche)', () => {
    // 04:00 UTC = 23:00 del día previo en Bogotá
    expect(bogotaDay(Date.UTC(2026, 5, 30, 4, 0, 0))).toBe('2026-06-29');
  });
  it('markBogotaDay usa marked_at', () => {
    expect(markBogotaDay(mk('1', '2026-06-30T17:00:00Z'))).toBe('2026-06-30');
  });
});

describe('defaultMarkRange', () => {
  it('días=3 => [antier .. hoy] inclusivo', () => {
    const now = Date.UTC(2026, 5, 30, 17, 0, 0); // 2026-06-30 mediodía Bogotá
    expect(defaultMarkRange(now, 3)).toEqual({ from: '2026-06-28', to: '2026-06-30' });
  });
  it('días=1 => solo hoy', () => {
    const now = Date.UTC(2026, 5, 30, 17, 0, 0);
    expect(defaultMarkRange(now, 1)).toEqual({ from: '2026-06-30', to: '2026-06-30' });
  });
  it('clampa días < 1 a 1', () => {
    const now = Date.UTC(2026, 5, 30, 17, 0, 0);
    expect(defaultMarkRange(now, 0)).toEqual({ from: '2026-06-30', to: '2026-06-30' });
  });
  it('cruza fin de mes', () => {
    const now = Date.UTC(2026, 6, 1, 17, 0, 0); // 2026-07-01
    expect(defaultMarkRange(now, 3)).toEqual({ from: '2026-06-29', to: '2026-07-01' });
  });
});

describe('filterMarksByRange', () => {
  const marks = [
    mk('a', '2026-06-28T17:00:00Z'),
    mk('b', '2026-06-29T17:00:00Z'),
    mk('c', '2026-06-30T17:00:00Z'),
    mk('d', '2026-06-25T17:00:00Z'),
  ];
  it('incluye los extremos (inclusivo)', () => {
    const out = filterMarksByRange(marks, { from: '2026-06-28', to: '2026-06-30' });
    expect(out.map(m => m.id).sort()).toEqual(['a', 'b', 'c']);
  });
  it('excluye los de afuera del rango', () => {
    const out = filterMarksByRange(marks, { from: '2026-06-30', to: '2026-06-30' });
    expect(out.map(m => m.id)).toEqual(['c']);
  });
});

describe('groupMarksByDay', () => {
  it('día más nuevo primero; dentro del día, marca más nueva primero', () => {
    const marks = [
      mk('old', '2026-06-28T15:00:00Z'),
      mk('new1', '2026-06-30T14:00:00Z'),
      mk('new2', '2026-06-30T18:00:00Z'),
    ];
    const groups = groupMarksByDay(marks);
    expect(groups.map(([d]) => d)).toEqual(['2026-06-30', '2026-06-28']);
    expect(groups[0][1].map(m => m.id)).toEqual(['new2', 'new1']);
  });
  it('lista vacía => sin grupos', () => {
    expect(groupMarksByDay([])).toEqual([]);
  });
});

describe('markReconStatus', () => {
  it("'missing' si el pedido sigue pendiente (no está en Dropi)", () => {
    expect(markReconStatus('x', new Set(['x', 'y']))).toBe('missing');
  });
  it("'ok' si ya no está pendiente (entró a Dropi)", () => {
    expect(markReconStatus('z', new Set(['x', 'y']))).toBe('ok');
  });
});

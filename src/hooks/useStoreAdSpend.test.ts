import { describe, it, expect } from 'vitest';
import { sumAdSpend, type StoreAdSpendRow } from './useStoreAdSpend';

function row(platform: 'meta' | 'tiktok' | 'other', amount: number): StoreAdSpendRow {
  return {
    id: 'x', store_id: 's', spend_date: '2026-07-06',
    platform, amount, notas: null, created_at: '', updated_at: '',
  };
}

describe('sumAdSpend', () => {
  it('lista vacía → todo en 0', () => {
    expect(sumAdSpend([])).toEqual({ meta: 0, tiktok: 0, other: 0, total: 0 });
  });

  it('suma por canal y total', () => {
    const t = sumAdSpend([row('meta', 500), row('tiktok', 350), row('meta', 100), row('other', 50)]);
    expect(t.meta).toBe(600);
    expect(t.tiktok).toBe(350);
    expect(t.other).toBe(50);
    expect(t.total).toBe(1000);
  });
});

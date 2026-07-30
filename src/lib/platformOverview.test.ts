import { describe, it, expect } from 'vitest';
import {
  subscriptionState, storeHealth, filterStores, AVISO_VENCIMIENTO_DIAS,
  type PlatformStore,
} from './platformOverview';

const AHORA = new Date('2026-08-01T12:00:00Z').getTime();

const base: PlatformStore = {
  store_id: 's1', store_name: 'Tienda de Carlos', country_code: 'CO', status: 'active',
  created_at: '2026-07-01T00:00:00Z', owner_name: 'Carlos', owner_email: 'carlos@mail.com',
  members: 3, orders_30d: 412, last_order_at: '2026-08-01T10:00:00Z', has_dropi_key: true,
  last_sync_at: '2026-08-01T11:52:00Z', last_sync_ok: true,
  wallet_sync_at: '2026-08-01T06:00:00Z', wallet_sync_ok: true,
  app_versions: '2026-07-30 14:05', plan: 'pro', paid_until: '2026-09-15', sub_notes: null,
};

const con = (p: Partial<PlatformStore>): PlatformStore => ({ ...base, ...p });

describe('subscriptionState', () => {
  it('al día cuando falta más que la ventana de aviso', () => {
    const s = subscriptionState(con({ paid_until: '2026-09-15' }), AHORA);
    expect(s.vencida).toBe(false);
    expect(s.porVencer).toBe(false);
    expect(s.label).toContain('al día');
    expect(s.tone).toContain('success');
  });

  it('por vencer dentro de la ventana de aviso', () => {
    const s = subscriptionState(con({ paid_until: '2026-08-05' }), AHORA); // faltan 4
    expect(s.porVencer).toBe(true);
    expect(s.diasRestantes).toBe(4);
    expect(s.label).toContain('vence en 4d');
    expect(s.tone).toContain('warning');
  });

  it('el borde exacto de la ventana todavía avisa', () => {
    const limite = new Date(AHORA + AVISO_VENCIMIENTO_DIAS * 86400000).toISOString().slice(0, 10);
    expect(subscriptionState(con({ paid_until: limite }), AHORA).porVencer).toBe(true);
  });

  it('vencida cuenta los días pasados', () => {
    const s = subscriptionState(con({ paid_until: '2026-07-26' }), AHORA);
    expect(s.vencida).toBe(true);
    expect(s.label).toContain('vencido hace 6d');
    expect(s.tone).toContain('danger');
  });

  it('vence HOY no está vencida todavía', () => {
    const s = subscriptionState(con({ paid_until: '2026-08-01' }), AHORA);
    expect(s.vencida).toBe(false);
    expect(s.diasRestantes).toBe(0);
  });

  it('sin fecha → no vence, y lo DICE (no inventa un plazo)', () => {
    const s = subscriptionState(con({ plan: 'cortesia', paid_until: null }), AHORA);
    expect(s.diasRestantes).toBeNull();
    expect(s.vencida).toBe(false);
    expect(s.label).toContain('sin vencimiento');
  });
});

describe('storeHealth', () => {
  it('tienda sana: sincronía y billetera recientes', () => {
    const h = storeHealth(base, AHORA);
    expect(h.syncOk).toBe(true);
    expect(h.walletOk).toBe(true);
    expect(h.problema).toBe(false);
    expect(h.syncLabel).toBe('hace 8 min');
  });

  it('sin credenciales Dropi = "sin configurar", NO se hace pasar por sana', () => {
    const h = storeHealth(con({ has_dropi_key: false }), AHORA);
    expect(h.syncOk).toBe(false);
    expect(h.syncLabel).toBe('sin configurar');
    expect(h.problema).toBe(true);
  });

  it('sin ninguna corrida registrada NO es ok: es "nunca"', () => {
    const h = storeHealth(con({ last_sync_at: null, last_sync_ok: null }), AHORA);
    expect(h.syncOk).toBe(false);
    expect(h.syncLabel).toBe('nunca');
    expect(h.problema).toBe(true);
  });

  it('última corrida en error → problema aunque sea reciente', () => {
    const h = storeHealth(con({ last_sync_ok: false }), AHORA);
    expect(h.syncOk).toBe(false);
    expect(h.problema).toBe(true);
  });

  it('billetera caída marca problema sin ensuciar la sincronía de pedidos', () => {
    const h = storeHealth(con({ wallet_sync_ok: false }), AHORA);
    expect(h.syncOk).toBe(true);
    expect(h.walletOk).toBe(false);
    expect(h.problema).toBe(true);
  });
});

describe('filterStores', () => {
  const sana = con({ store_id: 'ok' });
  const vencida = con({ store_id: 'venc', store_name: 'Tienda de Ana', owner_name: 'Ana', owner_email: 'ana@mail.com', paid_until: '2026-07-01' });
  const rota = con({ store_id: 'rota', store_name: 'Tienda de Luis', owner_name: 'Luis', owner_email: 'luis@mail.com', has_dropi_key: false });
  const suspendida = con({ store_id: 'susp', store_name: 'Tienda de Eva', owner_name: 'Eva', owner_email: 'eva@mail.com', status: 'suspended' });
  const todas = [sana, vencida, rota, suspendida];

  it('sin filtros devuelve todo', () => {
    expect(filterStores(todas, '', false, AHORA)).toHaveLength(4);
  });

  it('busca por nombre de tienda, dueño y correo', () => {
    expect(filterStores(todas, 'ana', false, AHORA).map(s => s.store_id)).toEqual(['venc']);
    expect(filterStores(todas, 'luis@mail', false, AHORA).map(s => s.store_id)).toEqual(['rota']);
    expect(filterStores(todas, 'TIENDA DE EVA', false, AHORA).map(s => s.store_id)).toEqual(['susp']);
  });

  it('"solo problemas" deja fuera la sana y trae vencida, rota y suspendida', () => {
    const r = filterStores(todas, '', true, AHORA).map(s => s.store_id);
    expect(r).not.toContain('ok');
    expect(r).toEqual(expect.arrayContaining(['venc', 'rota', 'susp']));
  });

  it('los dos filtros se combinan', () => {
    expect(filterStores(todas, 'carlos', true, AHORA)).toHaveLength(0);
  });
});

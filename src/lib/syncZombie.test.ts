import { describe, it, expect } from 'vitest';
import { esZombieReal, esTiendaSinPedidosTodavia } from '../../supabase/functions/_shared/syncZombie';

// Test en src/lib porque `npm test` no corre lo que vive en supabase/functions.

const base = { error: null, throttled: false, synced: 0, statusTotal: 0 };

describe('cero pedidos: ¿está roto o no había nada?', () => {
  it('tienda NUEVA sin pedidos: cero es la verdad, NO se acusa a la clave', () => {
    const s = { ...base, tienePedidos: false };
    expect(esZombieReal(s)).toBe(false);
    expect(esTiendaSinPedidosTodavia(s)).toBe(true);
  });

  it('tienda EN OPERACIÓN que de golpe trae cero: eso sí es sospechoso', () => {
    const s = { ...base, tienePedidos: true };
    expect(esZombieReal(s)).toBe(true);
    expect(esTiendaSinPedidosTodavia(s)).toBe(false);
  });

  it('con error o throttle NUNCA es zombie: ya tienen su propio mensaje', () => {
    expect(esZombieReal({ ...base, tienePedidos: true, error: 'HTTP 401' })).toBe(false);
    expect(esZombieReal({ ...base, tienePedidos: true, throttled: true })).toBe(false);
    // Y tampoco se los confunde con "tienda nueva".
    expect(esTiendaSinPedidosTodavia({ ...base, tienePedidos: false, error: 'HTTP 401' })).toBe(false);
    expect(esTiendaSinPedidosTodavia({ ...base, tienePedidos: false, throttled: true })).toBe(false);
  });

  it('si trajo algo, no hay nada que reportar', () => {
    expect(esZombieReal({ ...base, tienePedidos: true, synced: 3 })).toBe(false);
    expect(esZombieReal({ ...base, tienePedidos: true, statusTotal: 7 })).toBe(false);
    expect(esTiendaSinPedidosTodavia({ ...base, tienePedidos: false, synced: 3 })).toBe(false);
  });
});

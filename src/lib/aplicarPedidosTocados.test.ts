import { describe, it, expect } from 'vitest';
import { aplicarPedidosTocados, idsDesconocidos } from './aplicarPedidosTocados';
import type { OrderData } from './orderUtils';

const ped = (o: Partial<OrderData>): OrderData => ({
  dbId: 'a', phone: '99', idx: 0, externalId: '600', nombre: 'Ana',
  estado: 'EN REPARTO', ciudad: 'QUITO', direccion: 'calle 1', valor: 29.99,
  dias: 2, diasConf: 1, guia: 'G1', transportadora: 'LAAR',
  lastMovementAt: '2026-08-28T10:00:00Z', novedad: null, novedadSol: false,
  assignedTo: null, lockedBy: null, lockedAt: null,
  ...o,
} as unknown as OrderData);

describe('aplicarPedidosTocados — el parche que reemplazó a recargar todo', () => {
  it('actualiza SOLO el pedido que cambió', () => {
    const prev = [ped({ dbId: 'a' }), ped({ dbId: 'b', nombre: 'Beto' })];
    const out = aplicarPedidosTocados(prev, [ped({ dbId: 'b', nombre: 'Beto', estado: 'ENTREGADO' })]);
    expect(out[0]).toBe(prev[0]);          // el intacto conserva su identidad
    expect(out[1].estado).toBe('ENTREGADO');
  });

  it('⛔ sin cambios visibles devuelve el MISMO array (no redibuja el tablero)', () => {
    // Es lo que evita que a la asesora se le mueva el scroll mientras trabaja.
    const prev = [ped({ dbId: 'a' })];
    expect(aplicarPedidosTocados(prev, [ped({ dbId: 'a' })])).toBe(prev);
  });

  it('⛔ NO pisa la gestión que el cliente acaba de marcar', () => {
    // `result`/`reason`/`retryCount` los pone buildWorkQueue desde order_results,
    // no vienen en la fila de `orders`. Pisarlos con undefined haría desaparecer
    // de la pantalla la confirmación recién registrada.
    const prev = [ped({ dbId: 'a', result: 'conf', reason: 'ok', retryCount: 2 } as Partial<OrderData>)];
    const out = aplicarPedidosTocados(prev, [ped({ dbId: 'a', estado: 'GUIA GENERADA' })]);
    expect(out[0].estado).toBe('GUIA GENERADA');
    expect(out[0].result).toBe('conf');
    expect(out[0].reason).toBe('ok');
    expect(out[0].retryCount).toBe(2);
  });

  it('⛔ NO agrega pedidos que no estaban en memoria', () => {
    // Los pedidos nuevos llegan por INSERT, que sí recarga. Agregarlos acá
    // saltearía los diez filtros del SQL y metería en la cola cosas que no van.
    const prev = [ped({ dbId: 'a' })];
    const out = aplicarPedidosTocados(prev, [ped({ dbId: 'zzz' })]);
    expect(out).toHaveLength(1);
    expect(out).toBe(prev);
  });

  it('un pedido que se vuelve terminal se ACTUALIZA, no se saca', () => {
    // El tablero lo manda solo a la columna de historia (plegada). Sacarlo acá
    // exigiría reimplementar los filtros del SQL en el cliente — dos
    // definiciones de "qué está en la cola" se desincronizan solas.
    const prev = [ped({ dbId: 'a' })];
    const out = aplicarPedidosTocados(prev, [ped({ dbId: 'a', estado: 'CANCELADO' })]);
    expect(out).toHaveLength(1);
    expect(out[0].estado).toBe('CANCELADO');
  });

  it('detecta el movimiento aunque el estado no cambie de texto', () => {
    // Dropi "mueve" un pedido sin cambiar el texto: solo `last_movement_at`.
    // De eso dependen los días sin moverse y las listas SLA.
    const prev = [ped({ dbId: 'a' })];
    const out = aplicarPedidosTocados(prev, [ped({ dbId: 'a', lastMovementAt: '2026-08-28T20:00:00Z' })]);
    expect(out).not.toBe(prev);
    expect(out[0].lastMovementAt).toBe('2026-08-28T20:00:00Z');
  });

  it('cola vacía o sin filas frescas: no hace nada', () => {
    expect(aplicarPedidosTocados([], [ped({})])).toEqual([]);
    const prev = [ped({})];
    expect(aplicarPedidosTocados(prev, [])).toBe(prev);
  });
});

describe('idsDesconocidos — cuándo SÍ hace falta recargar', () => {
  it('separa los que no están en memoria', () => {
    const prev = [ped({ dbId: 'a' }), ped({ dbId: 'b' })];
    expect(idsDesconocidos(prev, ['a', 'b'])).toEqual([]);
    expect(idsDesconocidos(prev, ['a', 'nuevo'])).toEqual(['nuevo']);
  });

  it('sin ids no pide nada', () => {
    expect(idsDesconocidos([ped({})], [])).toEqual([]);
  });
});

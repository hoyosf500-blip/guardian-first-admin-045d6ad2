import { describe, it, expect } from 'vitest';
import {
  elegirPedidoDropi,
  estaCancelado,
  type CandidatoDropi,
} from '../../supabase/functions/_shared/reconcileMatch';

/**
 * Qué pedido de Dropi cubre una venta de Shopify.
 *
 * ⛔ El caso que obligó a escribir esto (Colombia 2, 2-sep-2026): Alexánder
 * Álvarez tenía DOS pedidos en Dropi contra la venta #1019 — `#88086322`
 * CANCELADO y `#88087212` vivo. El emparejador tomaba el primero de la lista
 * (sin orden garantizado), agarró el cancelado, y el reporte de duplicados
 * señaló EL PEDIDO BUENO como el que sobraba. Si el operador le hace caso,
 * borra el envío que sí se va a entregar.
 */
const VENTA = Date.parse('2026-09-02T16:58:00-05:00');
const mk = (tel: string, iso: string, estado: string): CandidatoDropi =>
  ({ tel, t: Date.parse(iso), estado });

describe('elegirPedidoDropi', () => {
  it('prefiere el pedido VIVO aunque el cancelado venga primero', () => {
    const lista = [
      mk('209536696', '2026-09-02T17:21:00Z', 'CANCELADO'),
      mk('209536696', '2026-09-02T17:21:00Z', 'PENDIENTE'),
    ];
    expect(elegirPedidoDropi(lista, '209536696', VENTA, new Set())).toBe(1);
  });

  it('si el único candidato está cancelado, igual lo empareja', () => {
    // Una cancelación real del cliente NO es una fuga: si se dejara sin
    // emparejar, la venta reaparecería como "sin pasar a Dropi" para siempre.
    const lista = [mk('209536696', '2026-09-02T17:21:00Z', 'CANCELADO')];
    expect(elegirPedidoDropi(lista, '209536696', VENTA, new Set())).toBe(0);
  });

  it('entre dos vivos gana el de fecha más cercana a la venta', () => {
    const lista = [
      mk('300111222', '2026-09-20T10:00:00Z', 'PENDIENTE'),
      mk('300111222', '2026-09-02T18:00:00Z', 'PENDIENTE'),
    ];
    expect(elegirPedidoDropi(lista, '300111222', VENTA, new Set())).toBe(1);
  });

  it('no reusa un pedido ya asignado a otra venta', () => {
    const lista = [mk('300111222', '2026-09-02T18:00:00Z', 'PENDIENTE')];
    expect(elegirPedidoDropi(lista, '300111222', VENTA, new Set([0]))).toBe(-1);
  });

  it('respeta la ventana: 1 día antes, 45 después', () => {
    const antes = [mk('300111222', '2026-08-30T10:00:00Z', 'PENDIENTE')];
    expect(elegirPedidoDropi(antes, '300111222', VENTA, new Set())).toBe(-1);
    const lejos = [mk('300111222', '2026-11-15T10:00:00Z', 'PENDIENTE')];
    expect(elegirPedidoDropi(lejos, '300111222', VENTA, new Set())).toBe(-1);
    const dentro = [mk('300111222', '2026-10-01T10:00:00Z', 'PENDIENTE')];
    expect(elegirPedidoDropi(dentro, '300111222', VENTA, new Set())).toBe(0);
  });

  it('sin teléfono no empareja nada — un match a ciegas esconde la fuga', () => {
    const lista = [mk('', '2026-09-02T18:00:00Z', 'PENDIENTE')];
    expect(elegirPedidoDropi(lista, '', VENTA, new Set())).toBe(-1);
  });

  it('reconoce las variantes de cancelado', () => {
    expect(estaCancelado('CANCELADO')).toBe(true);
    expect(estaCancelado(' cancelada ')).toBe(true);
    expect(estaCancelado('PENDIENTE')).toBe(false);
    expect(estaCancelado('')).toBe(false);
  });
});

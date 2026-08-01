import { describe, it, expect } from 'vitest';
import {
  estaGestionadoHoy,
  contarGestionadosHoy,
  estaDetenido,
  horasSinMovimiento,
  asesorasEnSeguimientoHoy,
  HORAS_DETENIDO,
} from './segPulso';
import type { OrderData } from './orderUtils';

const AHORA = Date.parse('2026-08-01T15:00:00Z');
const haceHoras = (h: number) => new Date(AHORA - h * 3_600_000).toISOString();

const pedido = (p: Partial<OrderData>): OrderData => ({
  phone: '111', estado: 'EN TRANSITO', ...p,
} as OrderData);

describe('estaGestionadoHoy — UNA sola definición de "gestionado"', () => {
  // El bug que originó este módulo: el tablero escondía las tarjetas que
  // trabajó cualquiera, pero el contador de arriba solo sumaba las MÍAS. Las
  // tarjetas desaparecían y el número seguía clavado en 222.
  it('cuenta la gestión de una COMPAÑERA, no solo la mía', () => {
    const equipo = new Map([['111', { ultimoResult: 'Envié la guía' }]]);
    expect(estaGestionadoHoy('111', new Set(), equipo)).toBe(true);
  });

  it('un "no contestó" del equipo NO da el pedido por gestionado', () => {
    const equipo = new Map([['111', { ultimoResult: 'No contestó' }]]);
    expect(estaGestionadoHoy('111', new Set(), equipo)).toBe(false);
  });

  // Asimetría a propósito: lo MÍO cuenta siempre, incluso un "no contestó".
  // Acabo de registrarlo; volver a marcarlo duplicaría el touchpoint.
  it('mi propio "no contestó" sí bloquea (evita el registro duplicado)', () => {
    const equipo = new Map([['111', { ultimoResult: 'No contestó' }]]);
    expect(estaGestionadoHoy('111', new Set(['111']), equipo)).toBe(true);
  });

  it('sin teléfono no se puede afirmar nada', () => {
    expect(estaGestionadoHoy(null, new Set(['111']), new Map())).toBe(false);
    expect(estaGestionadoHoy('', new Set(), new Map())).toBe(false);
  });

  it('sin datos cargados no inventa gestiones', () => {
    expect(estaGestionadoHoy('111', null, null)).toBe(false);
    expect(estaGestionadoHoy('111', undefined, undefined)).toBe(false);
  });

  it('contarGestionadosHoy suma equipo y propias sin duplicar', () => {
    const pedidos = [pedido({ phone: '111' }), pedido({ phone: '222' }), pedido({ phone: '333' })];
    const equipo = new Map([
      ['111', { ultimoResult: 'Envié la guía' }],
      ['222', { ultimoResult: 'No contestó' }],  // no cuenta
    ]);
    // '111' por el equipo, '333' por mí. '222' queda pendiente.
    expect(contarGestionadosHoy(pedidos, new Set(['333']), equipo)).toBe(2);
  });

  it('el mismo pedido tocado por mí Y por el equipo cuenta UNA vez', () => {
    const pedidos = [pedido({ phone: '111' })];
    const equipo = new Map([['111', { ultimoResult: 'Envié la guía' }]]);
    expect(contarGestionadosHoy(pedidos, new Set(['111']), equipo)).toBe(1);
  });
});

describe('estaDetenido — el paquete que se está pudriendo', () => {
  it('marca el que lleva más del umbral sin moverse', () => {
    expect(estaDetenido(pedido({ lastMovementAt: haceHoras(HORAS_DETENIDO + 1) }), AHORA)).toBe(true);
  });

  it('no marca al que se movió recién', () => {
    expect(estaDetenido(pedido({ lastMovementAt: haceHoras(2) }), AHORA)).toBe(false);
  });

  // Un entregado hace un mes no se movió nunca más, pero no está "detenido":
  // llegó. Contarlo ahogaría la cifra en ruido justo cuando tiene que gritar.
  it('un pedido que YA llegó a su desenlace no está detenido', () => {
    for (const estado of ['ENTREGADO', 'CANCELADO', 'DEVOLUCION']) {
      expect(estaDetenido(pedido({ estado, lastMovementAt: haceHoras(500) }), AHORA)).toBe(false);
    }
  });

  // No saber cuándo se movió no es lo mismo que saber que está quieto.
  it('sin fecha de movimiento no cuenta como detenido', () => {
    expect(estaDetenido(pedido({ lastMovementAt: null }), AHORA)).toBe(false);
    expect(horasSinMovimiento(pedido({ lastMovementAt: null }), AHORA)).toBeNull();
    expect(horasSinMovimiento(pedido({ lastMovementAt: 'no-es-fecha' }), AHORA)).toBeNull();
  });
});

describe('asesorasEnSeguimientoHoy', () => {
  it('agrupa por asesora contando pedidos distintos', () => {
    const pedidos = [pedido({ phone: '111' }), pedido({ phone: '222' }), pedido({ phone: '333' })];
    const equipo = new Map([
      ['111', { ultimoPor: 'ana' }],
      ['222', { ultimoPor: 'ana' }],
      ['333', { ultimoPor: 'sofia' }],
    ]);
    expect(asesorasEnSeguimientoHoy(pedidos, equipo)).toEqual([
      { operatorId: 'ana', pedidos: 2 },
      { operatorId: 'sofia', pedidos: 1 },
    ]);
  });

  it('ignora gestiones sobre pedidos que hoy no están a la vista', () => {
    const equipo = new Map([['999', { ultimoPor: 'ana' }]]);
    expect(asesorasEnSeguimientoHoy([pedido({ phone: '111' })], equipo)).toEqual([]);
  });

  // El cero explícito ES la señal: el 31-jul Ecuador registró UNA gestión en
  // todo el día con 229 pedidos en la calle y la pantalla no lo mostraba.
  it('sin gestiones devuelve lista vacía (la pantalla muestra el aviso)', () => {
    expect(asesorasEnSeguimientoHoy([pedido({})], new Map())).toEqual([]);
    expect(asesorasEnSeguimientoHoy([pedido({})], null)).toEqual([]);
  });
});

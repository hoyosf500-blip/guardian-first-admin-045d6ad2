import { describe, it, expect } from 'vitest';
import {
  findSupersededPendingConf,
  findSupersededPendingConfDetailed,
  findSupersededInSeg,
  isLocallyDead,
  type ProgressedOrder,
} from './duplicateOrders';
import type { OrderData } from './orderUtils';

// Fixtures mínimas: el helper solo lee phone, producto, externalId, fecha.
const pc = (over: Partial<OrderData>): OrderData => ({
  phone: '983975354', producto: 'AIRE ACONDICIONADO GR PR',
  externalId: '5563193', fecha: '2026-05-26', ...over,
} as unknown as OrderData);

const prog = (over: Partial<ProgressedOrder>): ProgressedOrder => ({
  phone: '983975354', producto: 'AIRE ACONDICIONADO GR PR',
  external_id: '5569313', estado: 'PENDIENTE', fecha: '2026-05-26', ...over,
});

describe('findSupersededPendingConf', () => {
  it('oculta el PENDIENTE CONFIRMACION viejo cuando hay un pedido real más nuevo (caso #5563193 → #5569313)', () => {
    const res = findSupersededPendingConf([pc({})], [prog({})]);
    expect(res.has('5563193')).toBe(true);
    expect(res.size).toBe(1);
  });

  it('NO oculta si el producto es distinto', () => {
    const res = findSupersededPendingConf([pc({})], [prog({ producto: 'OTRO PRODUCTO' })]);
    expect(res.size).toBe(0);
  });

  it('NO oculta una recompra: el pedido real es MUCHO más viejo (entregado hace meses)', () => {
    const res = findSupersededPendingConf([pc({ fecha: '2026-05-26' })], [prog({ estado: 'ENTREGADO', fecha: '2026-03-01' })]);
    expect(res.size).toBe(0);
  });

  it('NO oculta si el pedido real está fuera de la ventana hacia adelante (>14 días)', () => {
    const res = findSupersededPendingConf([pc({ fecha: '2026-05-26' })], [prog({ fecha: '2026-07-01' })]);
    expect(res.size).toBe(0);
  });

  it('NO oculta si no hay teléfono', () => {
    const res = findSupersededPendingConf([pc({ phone: '' })], [prog({})]);
    expect(res.size).toBe(0);
  });

  it('NO se cuenta a sí mismo (mismo external_id)', () => {
    const res = findSupersededPendingConf([pc({ externalId: '5569313' })], [prog({ external_id: '5569313' })]);
    expect(res.size).toBe(0);
  });

  it('matchea aunque el teléfono venga con prefijo de país / formato distinto', () => {
    const res = findSupersededPendingConf([pc({ phone: '0983975354' })], [prog({ phone: '+593983975354' })]);
    expect(res.has('5563193')).toBe(true);
  });
});

describe('findSupersededPendingConfDetailed', () => {
  it('el wrapper findSupersededPendingConf == keys del mapa detallado (equivalencia)', () => {
    // Mismos fixtures que arriba: un match, un no-match por producto y un
    // no-match por recompra vieja.
    const pendings = [
      pc({}),
      pc({ externalId: '7000001', producto: 'OTRO PRODUCTO' }),
      pc({ externalId: '7000002', fecha: '2026-05-26' }),
    ];
    const progs = [prog({}), prog({ external_id: '5570000', estado: 'ENTREGADO', fecha: '2026-03-01' })];
    const set = findSupersededPendingConf(pendings, progs);
    const map = findSupersededPendingConfDetailed(pendings, progs);
    expect(new Set(map.keys())).toEqual(set);
  });

  it('devuelve byExternalId/byEstado del pedido que superó', () => {
    const map = findSupersededPendingConfDetailed([pc({})], [prog({})]);
    expect(map.get('5563193')).toEqual({ byExternalId: '5569313', byEstado: 'PENDIENTE' });
  });

  it('con dos progresados que matchean, elige el external_id numérico más alto (el más nuevo)', () => {
    const a = prog({ external_id: '5569313', estado: 'PENDIENTE' });
    const b = prog({ external_id: '5570000', estado: 'GUIA_GENERADA' });
    // No importa el orden de llegada: gana el ID más alto.
    const m1 = findSupersededPendingConfDetailed([pc({})], [a, b]);
    expect(m1.get('5563193')).toEqual({ byExternalId: '5570000', byEstado: 'GUIA_GENERADA' });
    const m2 = findSupersededPendingConfDetailed([pc({})], [b, a]);
    expect(m2.get('5563193')).toEqual({ byExternalId: '5570000', byEstado: 'GUIA_GENERADA' });
  });
});

describe('isLocallyDead', () => {
  it('estados muertos localmente (cancelado/reemplazado/rechazado) → true', () => {
    expect(isLocallyDead('REEMPLAZADA')).toBe(true);
    expect(isLocallyDead('CANCELADO')).toBe(true);
    expect(isLocallyDead('RECHAZADO')).toBe(true);
  });

  it('estados vivos o vacíos → false (esos NO van al panel pasivo)', () => {
    expect(isLocallyDead('PENDIENTE CONFIRMACION')).toBe(false);
    expect(isLocallyDead('PENDIENTE')).toBe(false);
    expect(isLocallyDead('GUIA_GENERADA')).toBe(false);
    expect(isLocallyDead(null)).toBe(false);
    expect(isLocallyDead(undefined)).toBe(false);
    expect(isLocallyDead('')).toBe(false);
  });
});

describe('regresión incidente 2026-07-13 — duplicado VIVO #6107398', () => {
  it('el pendiente vivo aparece en el mapa apuntando a #6107408 y NO está muerto → tarjeta accionable, no panel pasivo', () => {
    const pendiente = pc({
      externalId: '6107398',
      estado: 'PENDIENTE CONFIRMACION',
      phone: '990155096',
      producto: 'EJERCITADOR PELVICO (Pantalla digital)',
      fecha: '2026-07-13',
    });
    const reenvio = prog({
      external_id: '6107408',
      estado: 'PENDIENTE',
      phone: '990155096',
      producto: 'EJERCITADOR PELVICO (Pantalla digital)',
      fecha: '2026-07-13',
    });
    const map = findSupersededPendingConfDetailed([pendiente], [reenvio]);
    expect(map.get('6107398')).toEqual({ byExternalId: '6107408', byEstado: 'PENDIENTE' });
    // Lo que rutea a la tarjeta con botón "Cancelar en Dropi": el viejo sigue vivo.
    expect(isLocallyDead(pendiente.estado)).toBe(false);
  });
});

// Helper para construir órdenes EC del Seguimiento. Datos basados en el caso
// real Carlos Gonzalez (Rushmira Ecuador, 2026-05-23): Dropi reemplazó 5524001
// por 5529961 (mismo cliente, mismo producto).
const seg = (over: Partial<OrderData>): OrderData => ({
  phone: '980508132',
  producto: 'AIRE ACONDICIONADO GR PR',
  externalId: '5524001',
  fecha: '2026-05-23',
  estado: 'PENDIENTE',
  transportadora: 'GINTRACOM',
  guia: '',
  ...over,
} as unknown as OrderData);

describe('findSupersededInSeg', () => {
  it('oculta la vieja cuando Dropi reemplaza una orden por otra (caso 5524001 → 5529961)', () => {
    const vieja = seg({ externalId: '5524001', estado: 'PENDIENTE', transportadora: 'GINTRACOM', guia: '' });
    const nueva = seg({ externalId: '5529961', estado: 'INGRESANDO OPERATIVO A', transportadora: 'SERVIENTREGA', guia: '185198672' });
    const res = findSupersededInSeg([vieja, nueva]);
    expect(res.has('5524001')).toBe(true);
    expect(res.has('5529961')).toBe(false);
    expect(res.size).toBe(1);
  });

  it('no marca nada si solo hay una orden por phone+producto', () => {
    const res = findSupersededInSeg([seg({})]);
    expect(res.size).toBe(0);
  });

  it('NUNCA oculta una orden ya ENTREGADA (es histórico legítimo)', () => {
    const vieja = seg({ externalId: '5524001', estado: 'ENTREGADO', fecha: '2026-05-20' });
    const nueva = seg({ externalId: '5529961', estado: 'PENDIENTE', fecha: '2026-05-23' });
    const res = findSupersededInSeg([vieja, nueva]);
    expect(res.has('5524001')).toBe(false);
  });

  it('respeta la ventana de 14 días — recompra del mismo cliente no se oculta', () => {
    const recompraVieja = seg({ externalId: '5524001', estado: 'PENDIENTE', fecha: '2026-05-01' });
    const compraNueva = seg({ externalId: '5529961', estado: 'PENDIENTE', fecha: '2026-06-15' });
    const res = findSupersededInSeg([recompraVieja, compraNueva]);
    expect(res.size).toBe(0);
  });

  it('si hay 3 órdenes del mismo cliente+producto, marca las 2 más viejas', () => {
    const a = seg({ externalId: '5520000', estado: 'PENDIENTE', fecha: '2026-05-23' });
    const b = seg({ externalId: '5524001', estado: 'PENDIENTE', fecha: '2026-05-23' });
    const c = seg({ externalId: '5529961', estado: 'GUIA_GENERADA', fecha: '2026-05-23' });
    const res = findSupersededInSeg([a, b, c]);
    expect(res.has('5520000')).toBe(true);
    expect(res.has('5524001')).toBe(true);
    expect(res.has('5529961')).toBe(false);
    expect(res.size).toBe(2);
  });

  it('NO matchea cuando son productos distintos del mismo cliente', () => {
    const aire = seg({ externalId: '5524001', producto: 'AIRE ACONDICIONADO GR PR' });
    const ventilador = seg({ externalId: '5529961', producto: 'VENTILADOR DE TORRE' });
    const res = findSupersededInSeg([aire, ventilador]);
    expect(res.size).toBe(0);
  });

  it('matchea phones con prefijo distinto (normalizePhone)', () => {
    const vieja = seg({ externalId: '5524001', phone: '0980508132' });
    const nueva = seg({ externalId: '5529961', phone: '+593980508132' });
    const res = findSupersededInSeg([vieja, nueva]);
    expect(res.has('5524001')).toBe(true);
  });

  it('ignora órdenes sin externalId numérico válido', () => {
    const vieja = seg({ externalId: 'X-123' });
    const nueva = seg({ externalId: '5529961' });
    const res = findSupersededInSeg([vieja, nueva]);
    // Sin id numérico no podemos saber cuál es la vieja → no marcamos
    expect(res.size).toBe(0);
  });

  it('respeta producto con whitespace inconsistente (trim + lowercase)', () => {
    const vieja = seg({ externalId: '5524001', producto: '  AIRE Acondicionado GR PR  ' });
    const nueva = seg({ externalId: '5529961', producto: 'aire acondicionado gr pr' });
    const res = findSupersededInSeg([vieja, nueva]);
    expect(res.has('5524001')).toBe(true);
  });
});

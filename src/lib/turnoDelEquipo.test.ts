import { describe, it, expect } from 'vitest';
import { turnoDelEquipo, type TurnoDelEquipoInput } from './turnoDelEquipo';
import type { OrderData } from './orderUtils';

const pedido = (dbId: string, phone: string): OrderData => ({
  idx: 0, id: dbId, externalId: dbId, dbId,
  nombre: 'Test', phone, ciudad: 'BOGOTA', departamento: 'CUNDINAMARCA',
  producto: 'Test', productosDetalle: [], estado: 'EN REPARTO',
  fecha: '', fechaConf: '', dias: 0, diasConf: 0,
  valor: 100000, flete: 8000, costoProd: 30000, costoDev: 0, cantidad: 1,
  direccion: 'Cl 1 # 1-1', novedad: '', guia: '', transportadora: '',
  tags: '', tienda: '', email: '', novedadSol: false,
  barrio: '', complemento: '', documentoDestinatario: '', googlePlaceId: '',
  lat: null, lng: null, validationDecision: null, addressKind: null,
  missingFields: [], suggestedCustomerMessage: '', suggestedAddress: null,
  addressParsed: null, lastMovementAt: null,
});

const gestion = (...phones: Array<[string, string]>) =>
  new Map(phones.map(([ph, por]) => [ph, { ultimoPor: por }]));

const armar = (o: Partial<TurnoDelEquipoInput> = {}): TurnoDelEquipoInput => ({
  accionables: [],
  asignaciones: new Map(),
  gestionEquipo: new Map(),
  operadores: [],
  gestionCargada: true,
  ...o,
});

describe('turnoDelEquipo — la cuenta del turno', () => {
  it('reparte los accionables entre sus dueñas y marca los tocados', () => {
    const r = turnoDelEquipo(armar({
      accionables: [pedido('o1', 'p1'), pedido('o2', 'p2'), pedido('o3', 'p3'), pedido('o4', 'p4')],
      asignaciones: new Map([['o1', 'ana'], ['o2', 'ana'], ['o3', 'bea'], ['o4', 'bea']]),
      gestionEquipo: gestion(['p1', 'ana'], ['p3', 'bea']),
      operadores: ['ana', 'bea'],
    }));

    expect(r.totalAccionable).toBe(4);
    expect(r.tocadosTotal).toBe(2);
    expect(r.sinDueno).toBe(0);
    const ana = r.filas.find((f) => f.operatorId === 'ana')!;
    const bea = r.filas.find((f) => f.operatorId === 'bea')!;
    expect(ana).toMatchObject({ asignados: 2, tocados: 1, sinTocar: 1 });
    expect(bea).toMatchObject({ asignados: 2, tocados: 1, sinTocar: 1 });
  });

  // Lo que el dueño busca primero: el trabajo que no es de nadie. Nadie va a
  // reclamarlo porque nadie lo tiene.
  it('cuenta aparte los accionables SIN dueño', () => {
    const r = turnoDelEquipo(armar({
      accionables: [pedido('o1', 'p1'), pedido('o2', 'p2'), pedido('o3', 'p3')],
      asignaciones: new Map([['o1', 'ana']]),
      operadores: ['ana'],
    }));
    expect(r.sinDueno).toBe(2);
    expect(r.filas.find((f) => f.operatorId === 'ana')!.asignados).toBe(1);
  });

  it('un pedido tocado por una COMPAÑERA cuenta como atendido', () => {
    // Lo que se mide es si el trabajo se hizo, no quién lo hizo. Si bea atendió
    // un pedido de ana, ese pedido no es una deuda pendiente.
    const r = turnoDelEquipo(armar({
      accionables: [pedido('o1', 'p1')],
      asignaciones: new Map([['o1', 'ana']]),
      gestionEquipo: gestion(['p1', 'bea']),
      operadores: ['ana', 'bea'],
    }));
    expect(r.filas.find((f) => f.operatorId === 'ana')!.sinTocar).toBe(0);
    expect(r.tocadosTotal).toBe(1);
  });

  it('lista a las asesoras sin carga con cero, no las esconde', () => {
    // Un cero visible dice "no le tocó nada". Una fila ausente parece un olvido.
    const r = turnoDelEquipo(armar({
      accionables: [pedido('o1', 'p1')],
      asignaciones: new Map([['o1', 'ana']]),
      operadores: ['ana', 'bea', 'cris'],
    }));
    expect(r.filas).toHaveLength(3);
    expect(r.filas.find((f) => f.operatorId === 'cris')).toMatchObject({ asignados: 0, sinTocar: 0 });
  });

  it('ordena por lo que FALTA, peor primero', () => {
    const r = turnoDelEquipo(armar({
      accionables: [
        pedido('o1', 'p1'), pedido('o2', 'p2'), pedido('o3', 'p3'),
        pedido('o4', 'p4'), pedido('o5', 'p5'),
      ],
      asignaciones: new Map([
        ['o1', 'ana'], ['o2', 'ana'], ['o3', 'ana'],
        ['o4', 'bea'], ['o5', 'cris'],
      ]),
      gestionEquipo: gestion(['p4', 'bea']),
      operadores: ['ana', 'bea', 'cris'],
    }));
    expect(r.filas.map((f) => f.operatorId)).toEqual(['ana', 'cris', 'bea']);
  });

  it('cola vacía no rompe', () => {
    const r = turnoDelEquipo(armar({ operadores: ['ana'] }));
    expect(r.totalAccionable).toBe(0);
    expect(r.sinDueno).toBe(0);
    expect(r.tocadosTotal).toBe(0);
    expect(r.filas).toEqual([{ operatorId: 'ana', asignados: 0, tocados: 0, sinTocar: 0 }]);
  });
});

// ── GUARDIÁN ──────────────────────────────────────────────────────────
// Esta pantalla la mira el dueño para decidir a quién le reclama. Un cero
// inventado acá no es un bug de display: es un reclamo injusto a una persona.
describe('GUARDIÁN: cero NUNCA sustituye a "no se pudo medir"', () => {
  it('con la lectura de gestiones caída, tocados y sinTocar son null', () => {
    const r = turnoDelEquipo(armar({
      accionables: [pedido('o1', 'p1'), pedido('o2', 'p2')],
      asignaciones: new Map([['o1', 'ana'], ['o2', 'ana']]),
      gestionEquipo: new Map(),      // vacío porque la query falló
      operadores: ['ana'],
      gestionCargada: false,
    }));

    expect(r.medible).toBe(false);
    expect(r.tocadosTotal).toBeNull();
    const ana = r.filas[0];
    expect(ana.tocados).toBeNull();
    expect(ana.sinTocar).toBeNull();
    // Los ASIGNADOS sí se saben: esa lectura es otra query y no depende de la
    // que falló. Anularlos también sería esconder información buena.
    expect(ana.asignados).toBe(2);
  });

  it('un mapa de gestiones vacío CON la lectura sana sí da cero — es real', () => {
    const r = turnoDelEquipo(armar({
      accionables: [pedido('o1', 'p1')],
      asignaciones: new Map([['o1', 'ana']]),
      gestionEquipo: new Map(),
      operadores: ['ana'],
      gestionCargada: true,
    }));
    expect(r.medible).toBe(true);
    expect(r.filas[0]).toMatchObject({ asignados: 1, tocados: 0, sinTocar: 1 });
  });

  it('sinTocar nunca es negativo', () => {
    // Defensa por si llegaran gestiones de pedidos que ya no están en la cola.
    const r = turnoDelEquipo(armar({
      accionables: [pedido('o1', 'p1')],
      asignaciones: new Map([['o1', 'ana']]),
      gestionEquipo: gestion(['p1', 'ana'], ['p9', 'ana']),
      operadores: ['ana'],
    }));
    expect(r.filas[0].sinTocar).toBe(0);
  });

  it('la suma cuadra: asignados + sin dueño === total accionable', () => {
    const r = turnoDelEquipo(armar({
      accionables: Array.from({ length: 9 }, (_, i) => pedido(`o${i}`, `p${i}`)),
      asignaciones: new Map([['o0', 'ana'], ['o1', 'bea'], ['o2', 'ana']]),
      operadores: ['ana', 'bea'],
    }));
    const asignados = r.filas.reduce((n, f) => n + f.asignados, 0);
    expect(asignados + r.sinDueno).toBe(r.totalAccionable);
  });
});

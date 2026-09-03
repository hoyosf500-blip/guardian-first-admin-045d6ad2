import { describe, it, expect } from 'vitest';
import { repartirCola, desbalance, type AsignacionExistente } from './repartoEquitativo';

const cola = (n: number) => Array.from({ length: n }, (_, i) => ({ orderId: `p${i + 1}` }));

describe('repartirCola — reparto parejo', () => {
  it('12 pedidos entre 3 asesoras → 4 y 4 y 4', () => {
    const r = repartirCola({ pedidos: cola(12), operadores: ['a', 'b', 'c'] });
    expect(r.nuevas).toHaveLength(12);
    expect([...r.cargaFinal.values()]).toEqual([4, 4, 4]);
    expect(desbalance(r.cargaFinal)).toBe(0);
  });

  it('10 entre 3 → nadie carga más de uno de diferencia', () => {
    const r = repartirCola({ pedidos: cola(10), operadores: ['a', 'b', 'c'] });
    expect(desbalance(r.cargaFinal)).toBeLessThanOrEqual(1);
    expect(r.nuevas).toHaveLength(10);
  });

  it('reparte alternando: cada asesora recibe una mezcla de urgencias', () => {
    // La cola entra ORDENADA por urgencia. Si el reparto diera bloques
    // contiguos, la primera asesora se llevaría todo lo que vence hoy y la
    // última solo lo tibio. Alternar reparte la presión.
    const r = repartirCola({ pedidos: cola(6), operadores: ['a', 'b', 'c'] });
    expect(r.nuevas.map((x) => x.operatorId)).toEqual(['a', 'b', 'c', 'a', 'b', 'c']);
  });

  it('más asesoras que pedidos: las sobrantes quedan en cero, sin error', () => {
    const r = repartirCola({ pedidos: cola(2), operadores: ['a', 'b', 'c', 'd'] });
    expect(r.nuevas).toHaveLength(2);
    expect(r.cargaFinal.get('c')).toBe(0);
    expect(r.cargaFinal.get('d')).toBe(0);
  });

  it('cola vacía no asigna nada', () => {
    const r = repartirCola({ pedidos: [], operadores: ['a', 'b'] });
    expect(r.nuevas).toHaveLength(0);
    expect(r.sinAsignar).toBe(0);
    expect(r.motivoSinAsignar).toBeNull();
  });
});

describe('repartirCola — correr el reparto otra vez', () => {
  // El reparto se corre más de una vez al día: entra trabajo nuevo, o alguien
  // se suma al turno. Nunca puede reasignar lo que otra ya empezó.
  it('respeta lo ya asignado y solo reparte lo que falta', () => {
    const ya: AsignacionExistente[] = [
      { orderId: 'p1', operatorId: 'a' },
      { orderId: 'p2', operatorId: 'a' },
      { orderId: 'p3', operatorId: 'a' },
    ];
    const r = repartirCola({ pedidos: cola(6), operadores: ['a', 'b'], yaAsignados: ya });

    // No reasigna p1..p3.
    expect(r.nuevas.map((x) => x.orderId)).toEqual(['p4', 'p5', 'p6']);
    // Y compensa: 'a' ya venía con 3, así que lo nuevo va todo a 'b'.
    expect(r.nuevas.every((x) => x.operatorId === 'b')).toBe(true);
    expect(r.cargaFinal.get('a')).toBe(3);
    expect(r.cargaFinal.get('b')).toBe(3);
  });

  it('correrlo dos veces seguidas no mueve nada la segunda vez', () => {
    const primera = repartirCola({ pedidos: cola(7), operadores: ['a', 'b', 'c'] });
    const segunda = repartirCola({
      pedidos: cola(7),
      operadores: ['a', 'b', 'c'],
      yaAsignados: primera.nuevas,
    });
    expect(segunda.nuevas).toHaveLength(0);
    expect([...segunda.cargaFinal.entries()].sort()).toEqual([...primera.cargaFinal.entries()].sort());
  });

  it('un pedido de alguien que ya no está en el turno NO se le roba', () => {
    // 'z' se fue. Su pedido sigue siendo suyo (el registro no se falsea), pero
    // su ausencia no penaliza la carga de las que sí están.
    const r = repartirCola({
      pedidos: cola(4),
      operadores: ['a', 'b'],
      yaAsignados: [{ orderId: 'p1', operatorId: 'z' }],
    });
    expect(r.nuevas.map((x) => x.orderId)).toEqual(['p2', 'p3', 'p4']);
    expect(r.cargaFinal.has('z')).toBe(false);
    expect(desbalance(r.cargaFinal)).toBeLessThanOrEqual(1);
  });
});

// ── GUARDIÁN ──────────────────────────────────────────────────────────
describe('GUARDIÁN: el reparto no puede sorprender', () => {
  it('es determinista — mismas entradas, mismo resultado', () => {
    // Un reparto que cambia solo entre dos corridas es imposible de auditar:
    // el dueño no puede saber si el pedido cambió de dueño porque alguien lo
    // movió o porque el sistema barajó de nuevo.
    const args = { pedidos: cola(17), operadores: ['c', 'a', 'b'] };
    const a = repartirCola(args);
    const b = repartirCola(args);
    expect(a.nuevas).toEqual(b.nuevas);
  });

  it('sin asesoras NO inventa un dueño: lo dice', () => {
    // El fallo silencioso peligroso: una tienda sin operadoras cargadas donde
    // el reparto "funciona" y no asigna nada. La pantalla tiene que poder
    // decir POR QUÉ quedó sin repartir.
    const r = repartirCola({ pedidos: cola(5), operadores: [] });
    expect(r.nuevas).toHaveLength(0);
    expect(r.sinAsignar).toBe(5);
    expect(r.motivoSinAsignar).toBe('sin_operadores');
  });

  it('ningún pedido queda con dos dueños', () => {
    const r = repartirCola({
      pedidos: cola(20),
      operadores: ['a', 'b', 'c'],
      yaAsignados: [{ orderId: 'p1', operatorId: 'a' }, { orderId: 'p2', operatorId: 'b' }],
    });
    const ids = r.nuevas.map((x) => x.orderId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain('p1');
    expect(ids).not.toContain('p2');
  });

  it('todo pedido de la cola termina con dueño cuando hay asesoras', () => {
    const r = repartirCola({ pedidos: cola(31), operadores: ['a', 'b', 'c', 'd'] });
    expect(r.nuevas).toHaveLength(31);
    expect(r.sinAsignar).toBe(0);
    const total = [...r.cargaFinal.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(31);
  });
});

/**
 * `cargaBase` — la que terminó recibe más (pedido del dueño, 3-sep-2026).
 *
 * Sin esto, "si una asesora terminó que se le carguen más pedidos" no puede
 * pasar: la carga por defecto cuenta pedidos ASIGNADOS, así que la que ya
 * despachó los suyos pesa igual que la que no tocó ninguno.
 */
describe('repartirCola — equilibrar por lo que FALTA', () => {
  /** Marcela (a) terminó sus 4; Johana (b) no tocó ninguno de los suyos. */
  const asignadosDeAyer: AsignacionExistente[] = [
    { orderId: 'v1', operatorId: 'a' }, { orderId: 'v2', operatorId: 'a' },
    { orderId: 'v3', operatorId: 'a' }, { orderId: 'v4', operatorId: 'a' },
    { orderId: 'v5', operatorId: 'b' }, { orderId: 'v6', operatorId: 'b' },
    { orderId: 'v7', operatorId: 'b' }, { orderId: 'v8', operatorId: 'b' },
  ];

  it('SIN cargaBase se parte por mitades — el comportamiento viejo, intacto', () => {
    const r = repartirCola({
      pedidos: cola(4), operadores: ['a', 'b'], yaAsignados: asignadosDeAyer,
    });
    // Las dos entran con 4 asignados, así que los 4 nuevos van 2 y 2.
    expect(r.nuevas.filter((x) => x.operatorId === 'a')).toHaveLength(2);
    expect(r.nuevas.filter((x) => x.operatorId === 'b')).toHaveLength(2);
  });

  it('CON cargaBase el trabajo nuevo va a la que ya terminó', () => {
    const r = repartirCola({
      pedidos: cola(4),
      operadores: ['a', 'b'],
      yaAsignados: asignadosDeAyer,
      cargaBase: new Map([['a', 0], ['b', 4]]),   // lo que le FALTA a cada una
    });
    expect(r.nuevas.filter((x) => x.operatorId === 'a')).toHaveLength(4);
    expect(r.nuevas.filter((x) => x.operatorId === 'b')).toHaveLength(0);
    // Y quedan parejas en lo pendiente, que es la vara que importa.
    expect(r.cargaFinal.get('a')).toBe(4);
    expect(r.cargaFinal.get('b')).toBe(4);
  });

  it('no cuenta dos veces: con cargaBase los ya asignados NO se vuelven a sumar', () => {
    const r = repartirCola({
      pedidos: cola(2),
      operadores: ['a', 'b'],
      yaAsignados: asignadosDeAyer,
      cargaBase: new Map([['a', 1], ['b', 1]]),
    });
    // 1 de base + 1 nuevo cada una. Si se sumaran los 4 asignados daría 5 y 5.
    expect(r.cargaFinal.get('a')).toBe(2);
    expect(r.cargaFinal.get('b')).toBe(2);
  });

  /**
   * ⛔ EL CASO QUE JUSTIFICA LA GUARDA. `turnoDelEquipo` devuelve
   * `sinTocar: number | null` y su regla es que "cero nunca sustituye a 'no se
   * pudo medir'". Si un `null` se colara como 0, esa persona entraría como la
   * más libre del turno y se llevaría TODO el trabajo nuevo — precisamente
   * porque no se la pudo medir.
   */
  it('si falta el dato de UNA sola, se ignora el mapa entero y se reparte como siempre', () => {
    const r = repartirCola({
      pedidos: cola(4),
      operadores: ['a', 'b'],
      yaAsignados: asignadosDeAyer,
      cargaBase: new Map([['a', 0]]),          // falta 'b'
    });
    expect(r.nuevas.filter((x) => x.operatorId === 'a')).toHaveLength(2);
    expect(r.nuevas.filter((x) => x.operatorId === 'b')).toHaveLength(2);
  });

  it('un número basura tampoco se toma por bueno', () => {
    for (const malo of [Number.NaN, -1, Infinity]) {
      const r = repartirCola({
        pedidos: cola(4),
        operadores: ['a', 'b'],
        yaAsignados: asignadosDeAyer,
        cargaBase: new Map([['a', malo], ['b', 4]]),
      });
      expect(r.nuevas.filter((x) => x.operatorId === 'a')).toHaveLength(2);
    }
  });

  it('sigue sin robarle un pedido a nadie', () => {
    const r = repartirCola({
      pedidos: [...asignadosDeAyer.map((a) => ({ orderId: a.orderId })), ...cola(3)],
      operadores: ['a', 'b'],
      yaAsignados: asignadosDeAyer,
      cargaBase: new Map([['a', 0], ['b', 4]]),
    });
    const ids = r.nuevas.map((x) => x.orderId);
    for (const a of asignadosDeAyer) expect(ids).not.toContain(a.orderId);
    expect(ids).toHaveLength(3);
  });
});

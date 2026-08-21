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

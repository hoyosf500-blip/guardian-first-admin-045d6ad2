import { describe, it, expect } from 'vitest';
import { quorumParaRepartir } from '@/hooks/useSegAsignaciones';
import { repartirCola } from './repartoEquitativo';

/**
 * ⛔ EL DESASTRE QUE ESTE QUÓRUM EVITA (encontrado 28-ago-2026, antes de pegar).
 *
 * El reparto automático corre la primera vez que un JEFE abre Seguimiento, y
 * desde ayer va solo a quien marcó entrada hoy. En Rushmira EC el jefe que
 * trabaja es Roberto (supervisor), y a las 8 de la mañana el único que marcó
 * entrada es él: `destinatarios = [Roberto]` y **los 315 pedidos del día
 * quedaban asignados a una sola persona**.
 *
 * Y no había vuelta atrás en el día: `repartir_seguimiento` hace
 * `ON CONFLICT DO NOTHING` y `repartirCola` NUNCA toca lo ya asignado (es su
 * contrato: robarle un pedido a quien lo empezó es peor que un reparto
 * desparejo). Así que cuando Estefano y María José llegaran media hora después
 * no quedaba un solo pedido sin dueño para darles.
 *
 * La primera prueba reproduce el desastre sobre el repartidor puro; la segunda
 * fija la regla que lo corta.
 */
describe('quórum de presencia — repartir con medio equipo es peor que esperar', () => {
  const cola = Array.from({ length: 315 }, (_, i) => ({ orderId: `o${i}` }));

  it('REPRODUCE el desastre: con un solo destinatario se lleva TODO', () => {
    const plan = repartirCola({ pedidos: cola, operadores: ['roberto'], yaAsignados: [] });
    expect(plan.nuevas).toHaveLength(315);
    expect(new Set(plan.nuevas.map((a) => a.operatorId))).toEqual(new Set(['roberto']));
  });

  it('y NO se puede deshacer: lo ya asignado es intocable por contrato', () => {
    const yaAsignados = cola.map((p) => ({ orderId: p.orderId, operatorId: 'roberto' }));
    // Llega el resto del equipo y se vuelve a repartir la MISMA cola.
    const plan = repartirCola({
      pedidos: cola,
      operadores: ['roberto', 'estefano', 'maria'],
      yaAsignados,
    });
    // Cero pedidos nuevos para los que llegaron: no queda nada sin dueño.
    expect(plan.nuevas).toHaveLength(0);
  });

  it('con equipo de 3, hacen falta 2 presentes para repartir', () => {
    expect(quorumParaRepartir(3)).toBe(2);
    expect(quorumParaRepartir(5)).toBe(2);
  });

  it('con UNA sola asesora el quórum es 1 — ahí no hay nada que equilibrar', () => {
    expect(quorumParaRepartir(1)).toBe(1);
  });

  it('plantel vacío no exige un imposible', () => {
    expect(quorumParaRepartir(0)).toBe(1);
  });

  it('con quórum cumplido el reparto sí equilibra', () => {
    const plan = repartirCola({ pedidos: cola, operadores: ['roberto', 'estefano'], yaAsignados: [] });
    const porPersona = new Map<string, number>();
    for (const a of plan.nuevas) porPersona.set(a.operatorId, (porPersona.get(a.operatorId) ?? 0) + 1);
    expect([...porPersona.values()].sort()).toEqual([157, 158]);
  });
});

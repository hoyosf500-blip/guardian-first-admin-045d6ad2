import { describe, it, expect } from 'vitest';
import { BOARD_COLUMNS, HISTORIA_KEYS } from '@/components/seguimiento/SegBoard';
import { FASES_VIVAS } from './segPulso';
import type { SegStatusKey } from './segStatus';

/**
 * GUARDIÁN del orden de prioridad del tablero de Seguimiento.
 *
 * Pedido del dueño (24-ago-2026): "coloquemos las prioridades, por ejemplo
 * oficina de primero". El orden dejó de ser el embudo logístico
 * (procesamiento → entregado) y pasó a ser POR LO QUE SE PIERDE SI ESPERA —
 * el mismo criterio de la escalera del turno (`siguienteAccion.ts`):
 * un paquete esperando al cliente en la agencia se devuelve en ~7 días,
 * mientras que uno en procesamiento viaja solo.
 *
 * Estas pruebas existen porque el orden es una decisión de OPERACIÓN, no de
 * dibujo: un refactor visual que "ordene alfabéticamente" o vuelva al embudo
 * le esconde la prioridad a la asesora sin que ningún type-check lo note.
 */
describe('BOARD_COLUMNS — orden por prioridad', () => {
  const keys = BOARD_COLUMNS.map((c) => c.baseKey);

  it('Oficina va PRIMERO: es el paquete que la transportadora devuelve si nadie llama', () => {
    expect(keys[0]).toBe('oficina');
  });

  it('Novedad va segunda: la incidencia tiene reloj de la transportadora', () => {
    expect(keys[1]).toBe('novedad');
  });

  it('todas las fases VIVAS van antes que cualquier terminal', () => {
    const ultimaViva = Math.max(...keys.map((k, i) => (FASES_VIVAS.has(k) ? i : -1)));
    const primeraTerminal = keys.findIndex((k) => !FASES_VIVAS.has(k));
    expect(primeraTerminal).toBeGreaterThan(ultimaViva);
  });

  it('los rescatables (rechazado y devoluciones) van entre las vivas y la historia', () => {
    const rescate: SegStatusKey[] = ['rechazado', 'devolucion_transito', 'devolucion'];
    const idxRescate = rescate.map((k) => keys.indexOf(k));
    const idxHistoria = [...HISTORIA_KEYS].map((k) => keys.indexOf(k));
    // Todos presentes…
    for (const i of [...idxRescate, ...idxHistoria]) expect(i).toBeGreaterThanOrEqual(0);
    // …y todo rescate ANTES que toda historia: la llamada de rescate todavía
    // salva la venta (32 de 49 re-emitidos de julio EC terminaron entregados).
    expect(Math.max(...idxRescate)).toBeLessThan(Math.min(...idxHistoria));
  });

  it('la HISTORIA (entregado/indemnizada/cancelado) cierra el tablero', () => {
    const ultimas = keys.slice(-HISTORIA_KEYS.size);
    expect([...ultimas].sort()).toEqual([...HISTORIA_KEYS].sort());
  });

  it('están las 14 fases, sin repetir ninguna', () => {
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(14);
  });
});

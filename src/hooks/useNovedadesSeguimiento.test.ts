import { describe, it, expect } from 'vitest';
import { diaBogotaDe, rosterQueTrabaja } from './useNovedadesSeguimiento';

/**
 * Las dos funciones puras que sacó la auditoría del 4-sep-2026 del hook de
 * Seguimiento de novedades. Se prueban solas porque cada una tapó un cero
 * falso: «Nuevas hoy» comparaba el día UTC con el día Bogotá, y el roster le
 * colgaba «0 hoy» al dueño.
 */
describe('diaBogotaDe', () => {
  it('un movimiento de las 20:00 Bogotá es HOY en Bogotá aunque en UTC ya sea mañana', () => {
    // 2026-09-04 20:30 en Bogotá (UTC-5) = 2026-09-05T01:30Z.
    expect(diaBogotaDe('2026-09-05T01:30:00.000Z')).toBe('2026-09-04');
    // El `slice(0, 10)` viejo habría dicho 2026-09-05.
    expect('2026-09-05T01:30:00.000Z'.slice(0, 10)).not.toBe(diaBogotaDe('2026-09-05T01:30:00.000Z'));
  });

  it('a media mañana los dos días coinciden', () => {
    expect(diaBogotaDe('2026-09-04T15:00:00.000Z')).toBe('2026-09-04');
  });

  it('sin fecha o con basura devuelve null: no saber no es hoy', () => {
    expect(diaBogotaDe(null)).toBeNull();
    expect(diaBogotaDe(undefined)).toBeNull();
    expect(diaBogotaDe('')).toBeNull();
    expect(diaBogotaDe('no-es-fecha')).toBeNull();
  });
});

describe('rosterQueTrabaja', () => {
  const miembros = [
    { user_id: 'duena', role: 'owner' },
    { user_id: 'roberto', role: 'supervisor' },
    { user_id: 'ana', role: 'operator' },
    { user_id: 'fabian', role: 'operator' },
    { user_id: 'sin-rol' },
  ];

  it('saca al owner y al admin global; el supervisor y las operadoras se quedan', () => {
    expect(rosterQueTrabaja(miembros, ['fabian'])).toEqual(['roberto', 'ana', 'sin-rol']);
  });

  it('sin admins conocidos solo filtra por rol', () => {
    expect(rosterQueTrabaja(miembros, [])).toEqual(['roberto', 'ana', 'fabian', 'sin-rol']);
  });

  it('roster vacío → vacío', () => {
    expect(rosterQueTrabaja([], ['x'])).toEqual([]);
  });
});

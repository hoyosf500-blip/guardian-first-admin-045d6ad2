import { describe, it, expect, beforeEach } from 'vitest';
import { heuristicValidate } from './addressHeuristic';
import {
  snapshotHeuristica,
  resetHeuristicaMetrics,
  tasaRojo,
  semaforoDesdeResultado,
} from './addressHeuristicMetrics';

// Contrato del registro de analítica: cuenta por país y color, no guarda la
// dirección, y sirve de alarma si un cambio de regex manda a rojo direcciones
// válidas de Colombia, Ecuador o Guatemala.

const VALIDAS: Record<string, string[]> = {
  CO: ['Calle 50 # 23-45 Barrio Laureles', 'Carrera 7 # 12-34 Apto 501'],
  EC: ['Cdla La Garzota Mz 8 Villa 15, Guayaquil', 'Av Amazonas y calle Naciones Unidas, Quito'],
  GT: ['12 calle 3-45 zona 1', '5a avenida 8-20 zona 10'],
};

describe('registro de analítica del semáforo de direcciones', () => {
  beforeEach(() => resetHeuristicaMetrics());

  it('cuenta cada evaluación bajo su país', () => {
    heuristicValidate('Calle 50 # 23-45', 'CO');
    heuristicValidate('Calle 50 # 23-45', 'CO');
    heuristicValidate('Cdla La Garzota Mz 8 Villa 15', 'EC');

    const snap = snapshotHeuristica();
    expect(snap.CO.total).toBe(2);
    expect(snap.EC.total).toBe(1);
    expect(snap.GT).toBeUndefined();
  });

  it('sin país explícito acumula en CO (default de la heurística)', () => {
    heuristicValidate('Calle 50 # 23-45');
    expect(snapshotHeuristica().CO.total).toBe(1);
  });

  it('ninguna dirección válida de CO, EC o GT cuenta como roja', () => {
    for (const [pais, dirs] of Object.entries(VALIDAS)) {
      for (const d of dirs) heuristicValidate(d, pais);
    }
    for (const pais of Object.keys(VALIDAS)) {
      expect(tasaRojo(pais), `${pais} tiene rojos sobre direcciones válidas`).toBe(0);
      expect(snapshotHeuristica()[pais].total).toBe(VALIDAS[pais].length);
    }
  });

  it('la basura sí se registra como roja', () => {
    heuristicValidate('asdasd', 'CO');
    expect(snapshotHeuristica().CO.red).toBe(1);
    expect(tasaRojo('CO')).toBe(1);
  });

  it('el snapshot es una copia (no se puede mutar el contador desde afuera)', () => {
    heuristicValidate('Calle 50 # 23-45', 'CO');
    const snap = snapshotHeuristica();
    snap.CO.total = 999;
    expect(snapshotHeuristica().CO.total).toBe(1);
  });

  it('la decisión concluyente manda sobre el score', () => {
    expect(semaforoDesdeResultado({ score: 0, decision: 'green' })).toBe('green');
    expect(semaforoDesdeResultado({ score: 80 })).toBe('green');
    expect(semaforoDesdeResultado({ score: 50 })).toBe('yellow');
    expect(semaforoDesdeResultado({ score: 49 })).toBe('red');
  });
});

// Tests para la heurística client-side de validación de direcciones.
// Foco: normalización de acentos para que typos como "Callé" o "Cárrera"
// no marquen `no_via_type` falso positivo.
import { describe, it, expect } from 'vitest';
import { heuristicValidate } from './addressHeuristic';

describe('heuristicValidate — normalización de acentos', () => {
  it('"Callé 21 # 10-78" NO marca no_via_type (acento)', () => {
    const r = heuristicValidate('Callé 21 # 10-78 Barrio el 12');
    expect(r.issues).not.toContain('no_via_type');
  });

  it('"Cárrera 50 # 23-45" NO marca no_via_type (acento)', () => {
    const r = heuristicValidate('Cárrera 50 # 23-45 Barrio Laureles');
    expect(r.issues).not.toContain('no_via_type');
  });

  it('caso real Milciades: heurística reconoce el tipo de vía', () => {
    const r = heuristicValidate('Barrio el 12 Fonseca guajira Callé 21 barrio el 12 #10-78 -');
    expect(r.issues).not.toContain('no_via_type');
  });

  it('texto sin tipo de vía sigue marcando no_via_type', () => {
    const r = heuristicValidate('frente al parque, casa azul');
    expect(r.issues).toContain('no_via_type');
  });
});

describe('heuristicValidate — placa canónica (Bug A)', () => {
  it('Bug A: "Cll4 13 38 Apartamento." NO llega a green sin placa canónica', () => {
    const r = heuristicValidate('Cll4 13 38 Apartamento.');
    expect(r.score).toBeLessThanOrEqual(65);
    expect(r.issues).toContain('no_canonical_placa');
  });

  it('placa canónica con guion permite score >= 80', () => {
    const r = heuristicValidate('Cll 50 # 23-45 Barrio Centro');
    expect(r.score).toBeGreaterThanOrEqual(80);
  });
});

describe('heuristicValidate — complemento sin número (Bug C)', () => {
  it('Bug C: "Apartamento." sin número agrega issue complemento_sin_numero', () => {
    const r = heuristicValidate('Cll 50 # 23-45 Apartamento.');
    expect(r.issues).toContain('complemento_sin_numero');
    expect(r.score).toBeLessThanOrEqual(65);
  });

  it('"Apto 302" con número NO marca complemento_sin_numero', () => {
    const r = heuristicValidate('Cll 50 # 23-45 Apto 302');
    expect(r.issues).not.toContain('complemento_sin_numero');
  });
});

describe('heuristicValidate — direcciones urbanas EC no son "rural" (auditoría 2026-07-07)', () => {
  it('"Cdla La Garzota Mz 8 Villa 15, Guayaquil" en EC NO cae en amarillo rural', () => {
    // 'Mz' matchea RURAL_PATTERNS de mapAddressKind, pero en EC es urbano estándar.
    // Sin el fix (rural check antes de la rama EC) daba yellow 'rural_address'.
    const r = heuristicValidate('Cdla La Garzota Mz 8 Villa 15, Guayaquil', 'EC');
    expect(r.decision).not.toBe('yellow');
    expect(r.issues).not.toContain('rural_address');
    expect(r.score).toBeGreaterThanOrEqual(70); // llega a la rama EC y puntúa positivo
  });

  it('"Coop. Bastión Popular Bloque 3 Mz 1240 Solar 5" (Guayaquil) EC → verde/alto, no rural', () => {
    const r = heuristicValidate('Coop Bastion Popular Bloque 3 Mz 1240 Solar 5', 'EC');
    expect(r.issues).not.toContain('rural_address');
    expect(r.score).toBeGreaterThanOrEqual(70);
  });

  it('la MISMA dirección con "Mz" en CO (default) SÍ sigue tratándose como rural', () => {
    // Regresión: el fix es country-scoped, no cambia el comportamiento CO.
    const r = heuristicValidate('Vereda El Rosal Mz 8 lote 3');
    expect(r.decision).toBe('yellow');
    expect(r.issues).toContain('rural_address');
  });
});

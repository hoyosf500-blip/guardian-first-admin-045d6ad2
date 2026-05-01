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

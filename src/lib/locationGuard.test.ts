// Tests del contrato general de locationMatches. Los casos específicos de
// Brayan/Bogotá/Pitalito ya están cubiertos en `useGoogleAddressLookup.test.ts`
// vía el wrapper `predictionMatchesLocation`. Acá sólo validamos:
//   - vacío/falsy en el texto
//   - ambas locations vacías → acepta
//   - sólo ciudad coincide
//   - sólo departamento coincide

import { describe, it, expect } from 'vitest';
import { locationMatches } from './locationGuard';

describe('locationMatches (contrato)', () => {
  it('texto vacío: descarta (no hay con qué comparar)', () => {
    expect(locationMatches('', 'PITALITO', 'HUILA')).toBe(false);
  });

  it('sin ciudad ni departamento: acepta (no podemos validar)', () => {
    expect(locationMatches('Cualquier cosa, Colombia')).toBe(true);
  });

  it('sólo ciudad coincide: acepta', () => {
    expect(locationMatches(
      'Calle 10 #5-25, Fonseca',
      'Fonseca',
      null,
    )).toBe(true);
  });

  it('sólo departamento coincide: acepta', () => {
    expect(locationMatches(
      'Vereda El Carmen, La Guajira, Colombia',
      null,
      'La Guajira',
    )).toBe(true);
  });
});

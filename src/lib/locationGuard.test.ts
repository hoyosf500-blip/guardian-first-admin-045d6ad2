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

  it('sólo departamento coincide y NO hay ciudad: acepta', () => {
    expect(locationMatches(
      'Vereda El Carmen, La Guajira, Colombia',
      null,
      'La Guajira',
    )).toBe(true);
  });

  it('regla estricta: con ciudad, match por solo departamento NO basta', () => {
    expect(locationMatches(
      'Calle 1 #1-1, Neiva, Huila',
      'Pitalito',
      'Huila',
    )).toBe(false);
  });

  // Fix #45: ciudad corta que es substring de otra distinta NO debe matchear.
  it('ciudad-substring NO matchea (Baba dentro de Babahoyo)', () => {
    expect(locationMatches(
      'Direccion en Babahoyo, Los Rios',
      'Baba',
      'Los Rios',
    )).toBe(false);
  });
  it('ciudad-substring NO matchea (Cali dentro de Calima)', () => {
    expect(locationMatches(
      'Vereda en Calima, Valle',
      'Cali',
      'Valle',
    )).toBe(false);
  });
});

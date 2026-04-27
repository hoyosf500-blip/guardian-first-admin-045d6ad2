import { describe, it, expect } from 'vitest';
import { rowsToCsv } from './csvExport';

describe('rowsToCsv', () => {
  it('serializa header + filas básicas', () => {
    const csv = rowsToCsv(
      ['nombre', 'edad'],
      [{ nombre: 'Juan', edad: 30 }, { nombre: 'Ana', edad: 25 }],
    );
    expect(csv).toBe('nombre,edad\nJuan,30\nAna,25');
  });

  it('escapa comas y quotes', () => {
    const csv = rowsToCsv(['x'], [{ x: 'a,b' }, { x: 'a"b' }]);
    expect(csv).toBe('x\n"a,b"\n"a""b"');
  });

  it('representa null/undefined como vacío', () => {
    const csv = rowsToCsv(['x'], [{ x: null }, { x: undefined }]);
    expect(csv).toBe('x\n\n');
  });
});

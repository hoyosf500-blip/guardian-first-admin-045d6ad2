import { describe, it, expect } from 'vitest';
import { normGeo, groupDropiCatalog, optionsPreservingCurrent } from './geoCatalog';

describe('normGeo', () => {
  it('mayúsculas, sin tildes, sin ñ, sin espacios', () => {
    expect(normGeo('Cañar')).toBe('CANAR');
    expect(normGeo(' Quito ')).toBe('QUITO');
    expect(normGeo('Manabí')).toBe('MANABI');
    expect(normGeo(null)).toBe('');
  });
});

describe('groupDropiCatalog', () => {
  const rows = [
    { dept_norm: 'ESMERALDAS', name: 'QUININDE' },
    { dept_norm: 'ESMERALDAS', name: 'ATACAMES' },
    { dept_norm: 'GUAYAS', name: 'GUAYAQUIL' },
    { dept_norm: 'ESMERALDAS', name: 'QUININDE' }, // duplicado
  ];

  it('agrupa por provincia, deduplica y ordena', () => {
    const { provinces, citiesByProvince } = groupDropiCatalog(rows);
    expect(provinces).toEqual(['ESMERALDAS', 'GUAYAS']);
    expect(citiesByProvince['ESMERALDAS']).toEqual(['ATACAMES', 'QUININDE']);
    expect(citiesByProvince['GUAYAS']).toEqual(['GUAYAQUIL']);
  });

  it('descarta filas sin provincia o sin ciudad', () => {
    const { provinces } = groupDropiCatalog([
      { dept_norm: '', name: 'X' },
      { dept_norm: 'LOJA', name: '' },
      { dept_norm: 'LOJA', name: 'LOJA' },
    ]);
    expect(provinces).toEqual(['LOJA']);
  });

  it('lista vacía no rompe', () => {
    expect(groupDropiCatalog([])).toEqual({ provinces: [], citiesByProvince: {} });
  });
});

describe('optionsPreservingCurrent', () => {
  const cats = ['ATACAMES', 'QUININDE'];

  it('valor en catálogo (aun con distinto casing/tilde) → selecciona el canónico', () => {
    const r = optionsPreservingCurrent('quininde', cats);
    expect(r.selected).toBe('QUININDE');
    expect(r.options).toEqual(cats); // no agrega nada
  });

  it('valor FUERA del catálogo se preserva arriba y queda seleccionado', () => {
    // San Lorenzo no lo cubre Dropi: no se pierde, el operador lo ve.
    const r = optionsPreservingCurrent('SAN LORENZO', cats);
    expect(r.selected).toBe('SAN LORENZO');
    expect(r.options).toEqual(['SAN LORENZO', 'ATACAMES', 'QUININDE']);
  });

  it('vacío → sin selección, opciones intactas', () => {
    const r = optionsPreservingCurrent('', cats);
    expect(r.selected).toBe('');
    expect(r.options).toEqual(cats);
  });

  it('provincia con ñ del pedido matchea la del catálogo sin ñ', () => {
    const r = optionsPreservingCurrent('CAÑAR', ['CANAR', 'AZUAY']);
    expect(r.selected).toBe('CANAR');
    expect(r.options).toEqual(['CANAR', 'AZUAY']);
  });
});

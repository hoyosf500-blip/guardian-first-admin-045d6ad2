// src/lib/mapAddressKind.test.ts
import { describe, it, expect } from 'vitest';
import { mapAddressKind } from './mapAddressKind';

describe('mapAddressKind', () => {
  it('urbano por calle', () => expect(mapAddressKind('Calle 8 #5-67, Bogotá')).toBe('urban'));
  it('urbano por carrera', () => expect(mapAddressKind('Carrera 30 #45, Medellín')).toBe('urban'));
  it('urbano por avenida', () => expect(mapAddressKind('Avenida 19 #100')).toBe('urban'));
  it('urbano por diagonal', () => expect(mapAddressKind('Diagonal 45')).toBe('urban'));
  it('urbano por transversal', () => expect(mapAddressKind('Transversal 60 #45')).toBe('urban'));
  it('rural por manzana', () => expect(mapAddressKind('Manzana 7 Lote 3')).toBe('rural'));
  it('rural por mz', () => expect(mapAddressKind('Mz B Lt 4')).toBe('rural'));
  it('rural por finca', () => expect(mapAddressKind('Finca La Esperanza')).toBe('rural'));
  it('rural por vereda', () => expect(mapAddressKind('Vereda La Esmeralda')).toBe('rural'));
  it('rural por corregimiento', () => expect(mapAddressKind('Corregimiento El Tablón')).toBe('rural'));
  it('rural por kilómetro', () => expect(mapAddressKind('Km 5 vía a Cali')).toBe('rural'));
  it('rural por sector', () => expect(mapAddressKind('Sector La Loma')).toBe('rural'));
  it('pickup por oficina inter', () => expect(mapAddressKind('Oficina Interrapidísimo Cali')).toBe('pickup_office'));
  it('pickup por sucursal', () => expect(mapAddressKind('Sucursal Envía centro')).toBe('pickup_office'));
  it('pickup por cliente retira', () => expect(mapAddressKind('Cliente retira en oficina')).toBe('pickup_office'));
  it('insensible a tildes', () => {
    expect(mapAddressKind('CARRERA 30')).toBe('urban');
    expect(mapAddressKind('VEREDA La Esmeralda')).toBe('rural');
  });
  it('vacío -> unknown', () => expect(mapAddressKind('')).toBe('unknown'));
  it('asdf -> unknown', () => expect(mapAddressKind('asdf qwer')).toBe('unknown'));
  it('pickup tiene prioridad sobre urbano', () => {
    expect(mapAddressKind('Calle 8 oficina Interrapidísimo')).toBe('pickup_office');
  });
  it('detecta urbano por Cll4 (sin espacio)', () => expect(mapAddressKind('Cll4 13 38 Apartamento')).toBe('urban'));
  it('detecta urbano por Cra5 (sin espacio)', () => expect(mapAddressKind('Cra5 #12-34')).toBe('urban'));
  it('detecta urbano por Av7 (sin espacio)', () => expect(mapAddressKind('Av7 #45 Sur')).toBe('urban'));
  it('detecta urbano por Dg45 (sin espacio)', () => expect(mapAddressKind('Dg45 #78-90')).toBe('urban'));
  it('pickup por "Reclamo en oficina" (real COD)', () => {
    expect(mapAddressKind('29 ee agosto Reclamo en oficina -')).toBe('pickup_office');
  });
  it('pickup por "Reclama en oficina Servientrega"', () => {
    expect(mapAddressKind('Reclama en oficina Servientrega')).toBe('pickup_office');
  });
  it('pickup por "Yo lo recojo en oficina"', () => {
    expect(mapAddressKind('Yo lo recojo en oficina')).toBe('pickup_office');
  });
});

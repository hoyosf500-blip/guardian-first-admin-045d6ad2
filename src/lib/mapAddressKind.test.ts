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
});

// src/lib/parseGooglePlace.test.ts
import { describe, it, expect } from 'vitest';
import { parseGooglePlace } from './parseGooglePlace';

const urbanPlace = {
  place_id: 'ChIJP_urban_id',
  formatted_address: 'Calle 8 #5-67, Chapinero, Bogotá, Colombia',
  geometry: { location: { lat: () => 4.601, lng: () => -74.062 } },
  address_components: [
    { long_name: '5-67', short_name: '5-67', types: ['street_number'] },
    { long_name: 'Calle 8', short_name: 'Cl 8', types: ['route'] },
    { long_name: 'Chapinero', short_name: 'Chapinero', types: ['sublocality'] },
    { long_name: 'Bogotá', short_name: 'Bogotá', types: ['locality', 'political'] },
    { long_name: 'Colombia', short_name: 'CO', types: ['country', 'political'] },
  ],
};

describe('parseGooglePlace', () => {
  it('extrae direccion como formatted_address', () => {
    expect(parseGooglePlace(urbanPlace).direccion).toBe('Calle 8 #5-67, Chapinero, Bogotá, Colombia');
  });
  it('extrae barrio del sublocality', () => {
    expect(parseGooglePlace(urbanPlace).barrio).toBe('Chapinero');
  });
  it('extrae place_id', () => {
    expect(parseGooglePlace(urbanPlace).place_id).toBe('ChIJP_urban_id');
  });
  it('extrae lat/lng', () => {
    const r = parseGooglePlace(urbanPlace);
    expect(r.lat).toBe(4.601);
    expect(r.lng).toBe(-74.062);
  });
  it('marca urban si tiene route + locality', () => {
    expect(parseGooglePlace(urbanPlace).address_kind).toBe('urban');
  });
  it('barrio null si no hay sublocality', () => {
    const noBarrio = { ...urbanPlace, address_components: urbanPlace.address_components.filter(c => !c.types.includes('sublocality')) };
    expect(parseGooglePlace(noBarrio).barrio).toBeNull();
  });
  it('lat/lng como números literales también funciona', () => {
    const literal = { ...urbanPlace, geometry: { location: { lat: 4.601, lng: -74.062 } as unknown as { lat: () => number; lng: () => number } } };
    const r = parseGooglePlace(literal);
    expect(r.lat).toBe(4.601);
    expect(r.lng).toBe(-74.062);
  });
  it('sin geometry retorna lat/lng null', () => {
    const noGeom = { ...urbanPlace, geometry: undefined };
    const r = parseGooglePlace(noGeom);
    expect(r.lat).toBeNull();
    expect(r.lng).toBeNull();
  });
});

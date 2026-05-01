import { describe, it, expect } from 'vitest';
import { issuesToMissingFields } from './issuesToMissingFields';

describe('issuesToMissingFields', () => {
  it('mapea no_via_type a tipo_via', () => {
    expect(issuesToMissingFields(['no_via_type'])).toEqual(['tipo_via']);
  });
  it('mapea no_numbers a numero_casa', () => {
    expect(issuesToMissingFields(['no_numbers'])).toEqual(['numero_casa']);
  });
  it('rural_address -> referencia', () => {
    expect(issuesToMissingFields(['rural_address'])).toEqual(['referencia']);
  });
  it('multiple issues dedupe to unique fields', () => {
    expect(issuesToMissingFields(['no_via_type', 'no_numbers'])).toEqual(['tipo_via', 'numero_casa']);
  });
  it('empty issues -> empty fields', () => {
    expect(issuesToMissingFields([])).toEqual([]);
  });
  it('unknown issue with other issues -> generic numero_casa fallback', () => {
    expect(issuesToMissingFields(['some_unknown_code'])).toEqual(['numero_casa']);
  });
});

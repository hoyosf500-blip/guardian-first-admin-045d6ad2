import { describe, it, expect } from 'vitest';
import { issuesToMissingFields } from './issuesToMissingFields';

describe('issuesToMissingFields', () => {
  it('no_via_type -> placa', () => {
    expect(issuesToMissingFields(['no_via_type'])).toEqual(['placa']);
  });
  it('rural_address -> complemento', () => {
    expect(issuesToMissingFields(['rural_address'])).toEqual(['complemento']);
  });
  it('multiple issues dedupe to unique fields', () => {
    expect(issuesToMissingFields(['no_via_type', 'no_numbers'])).toEqual(['placa']);
  });
  it('empty issues -> empty fields', () => {
    expect(issuesToMissingFields([])).toEqual([]);
  });
  it('unknown issue with other issues -> generic placa fallback', () => {
    expect(issuesToMissingFields(['some_unknown_code'])).toEqual(['placa']);
  });
});

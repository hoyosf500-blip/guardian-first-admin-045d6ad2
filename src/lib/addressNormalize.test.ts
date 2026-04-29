// src/lib/addressNormalize.test.ts
import { describe, it, expect } from 'vitest';
import { addressNormalize } from './addressNormalize';

describe('addressNormalize', () => {
  it('lowercase', () => {
    expect(addressNormalize('Calle 8 #5-67')).toBe('calle 8 #5-67');
  });
  it('elimina tildes', () => {
    expect(addressNormalize('Carrera 30 Bogotá')).toBe('carrera 30 bogota');
  });
  it('colapsa espacios múltiples', () => {
    expect(addressNormalize('  Calle    8   #5-67  ')).toBe('calle 8 #5-67');
  });
  it('trim', () => {
    expect(addressNormalize('  Calle 8  ')).toBe('calle 8');
  });
  it('Ñ se mantiene como N', () => {
    expect(addressNormalize('Cañas')).toBe('canas');
  });
  it('combinado', () => {
    expect(addressNormalize('  CARRERA   30   #45  Bogotá  ')).toBe('carrera 30 #45 bogota');
  });
  it('vacío', () => {
    expect(addressNormalize('')).toBe('');
  });
  it('solo whitespace', () => {
    expect(addressNormalize('   ')).toBe('');
  });
});

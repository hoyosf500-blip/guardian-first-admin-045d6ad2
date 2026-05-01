// Tests del guard anti-alucinación: la función exportada
// `predictionMatchesLocation` rechaza predicciones de Google que no coinciden
// con la ciudad o departamento del pedido. NO testeamos el hook completo
// (requiere mockear useGooglePlaces + Supabase) — solo la función pura.

import { describe, it, expect } from 'vitest';
import { predictionMatchesLocation } from './useGoogleAddressLookup';

describe('predictionMatchesLocation (guard anti-alucinación)', () => {
  it('caso real Brayan: rechaza "Soacha, Cundinamarca" cuando ciudad es Pitalito, depto Huila', () => {
    expect(predictionMatchesLocation(
      'Carrera 4 #13-38, Soacha, Cundinamarca, Colombia',
      'PITALITO',
      'HUILA',
    )).toBe(false);
  });

  it('acepta predicción que SÍ contiene la ciudad (case+accent insensitive)', () => {
    expect(predictionMatchesLocation(
      'Calle 15 #4-30, Pitalito, Huila, Colombia',
      'PITALITO',
      'HUILA',
    )).toBe(true);
  });

  it('acepta predicción que contiene SOLO el departamento', () => {
    expect(predictionMatchesLocation(
      'Vereda La Esperanza, Huila, Colombia',
      'pitalito',
      'huila',
    )).toBe(true);
  });

  it('rechaza Bogotá cuando pedido es Medellín, Antioquia', () => {
    expect(predictionMatchesLocation(
      'Carrera 7 #72-15, Bogotá, Cundinamarca',
      'MEDELLIN',
      'ANTIOQUIA',
    )).toBe(false);
  });

  it('acepta cuando ciudad tiene tilde y la prediction no', () => {
    expect(predictionMatchesLocation(
      'Calle 50 #23-45, Medellin, Antioquia',
      'Medellín',
      'Antioquia',
    )).toBe(true);
  });

  it('sin ciudad ni departamento: acepta (no podemos validar)', () => {
    expect(predictionMatchesLocation(
      'Calle 50 #23-45, Bogotá, Colombia',
    )).toBe(true);
  });

  it('Itagüí y Itagui son equivalentes (NFD normalize)', () => {
    expect(predictionMatchesLocation(
      'Carrera 50 #100-12, Itagui, Antioquia',
      'Itagüí',
      'Antioquia',
    )).toBe(true);
  });
});

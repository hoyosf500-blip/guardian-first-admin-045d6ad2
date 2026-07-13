import { describe, it, expect } from 'vitest';
import { evalIndicator, veredictoLabel } from './semaforoSalud';

describe('evalIndicator — modo "menor" (menor es mejor)', () => {
  // Umbrales tipo "costo de producto": verde <=38, amarillo <=45, rojo >45.
  const g = 38;
  const y = 45;

  it('verde cuando está por debajo del umbral verde', () => {
    expect(evalIndicator(30, 'menor', g, y)).toBe('green');
  });

  it('verde en el borde EXACTO del umbral verde (=38)', () => {
    expect(evalIndicator(38, 'menor', g, y)).toBe('green');
  });

  it('amarillo justo por encima del verde', () => {
    expect(evalIndicator(38.1, 'menor', g, y)).toBe('yellow');
  });

  it('amarillo en el borde EXACTO del umbral amarillo (=45)', () => {
    expect(evalIndicator(45, 'menor', g, y)).toBe('yellow');
  });

  it('rojo justo por encima del amarillo', () => {
    expect(evalIndicator(45.1, 'menor', g, y)).toBe('red');
  });

  it('rojo bien por encima', () => {
    expect(evalIndicator(80, 'menor', g, y)).toBe('red');
  });
});

describe('evalIndicator — modo "mayor" (mayor es mejor)', () => {
  // Umbrales tipo "margen bruto": verde >=45, amarillo >=30, rojo <30.
  const g = 45;
  const y = 30;

  it('verde cuando está por encima del umbral verde', () => {
    expect(evalIndicator(60, 'mayor', g, y)).toBe('green');
  });

  it('verde en el borde EXACTO del umbral verde (=45)', () => {
    expect(evalIndicator(45, 'mayor', g, y)).toBe('green');
  });

  it('amarillo justo por debajo del verde', () => {
    expect(evalIndicator(44.9, 'mayor', g, y)).toBe('yellow');
  });

  it('amarillo en el borde EXACTO del umbral amarillo (=30)', () => {
    expect(evalIndicator(30, 'mayor', g, y)).toBe('yellow');
  });

  it('rojo justo por debajo del amarillo', () => {
    expect(evalIndicator(29.9, 'mayor', g, y)).toBe('red');
  });

  it('rojo bien por debajo', () => {
    expect(evalIndicator(10, 'mayor', g, y)).toBe('red');
  });

  // Retorno de la pauta (múltiplo): verde >=2, amarillo >=1.2, rojo <1.2.
  it('retorno de pauta: 2.3x es verde', () => {
    expect(evalIndicator(2.3, 'mayor', 2, 1.2)).toBe('green');
  });

  it('retorno de pauta: 1.5x es amarillo', () => {
    expect(evalIndicator(1.5, 'mayor', 2, 1.2)).toBe('yellow');
  });

  it('retorno de pauta: 1.0x es rojo', () => {
    expect(evalIndicator(1.0, 'mayor', 2, 1.2)).toBe('red');
  });
});

describe('veredictoLabel', () => {
  it('mapea cada color a su micro-frase', () => {
    expect(veredictoLabel('green')).toBe('Sano');
    expect(veredictoLabel('yellow')).toBe('Vigilar');
    expect(veredictoLabel('red')).toBe('Crítico');
    expect(veredictoLabel('gray')).toBe('Sin dato');
  });
});

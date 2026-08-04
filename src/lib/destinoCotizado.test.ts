import { describe, it, expect } from 'vitest';
import { normDestino, mismoDestino, cotizacionDesfasada } from './destinoCotizado';

describe('normDestino', () => {
  it('quita tildes, puntuación y mayúsculas', () => {
    expect(normDestino('Santo Domingo')).toBe('SANTO DOMINGO');
    expect(normDestino('BOMBOLÍ')).toBe('BOMBOLI');
    expect(normDestino('  quito   d.c.  ')).toBe('QUITO D C');
  });

  it('sin dato devuelve vacío', () => {
    expect(normDestino(null)).toBe('');
    expect(normDestino(undefined)).toBe('');
  });
});

describe('mismoDestino — tolerante a cómo escribe Dropi', () => {
  it('acepta el nombre largo del catálogo contra el corto de pantalla', () => {
    expect(mismoDestino('SANTO DOMINGO DE LOS COLORADOS', 'Santo Domingo')).toBe(true);
    expect(mismoDestino('QUITO DC', 'Quito')).toBe(true);
  });

  it('acepta tildes distintas', () => {
    expect(mismoDestino('BOMBOLÍ', 'BOMBOLI')).toBe(true);
  });

  // El caso REAL que rompió producción: la cotización era de BOMBOLÍ y la
  // pantalla decía SANTO DOMINGO. Son lugares distintos y hay que avisar.
  it('NO acepta dos ciudades distintas', () => {
    expect(mismoDestino('BOMBOLI', 'SANTO DOMINGO')).toBe(false);
    expect(mismoDestino('GUAYAQUIL', 'QUITO')).toBe(false);
  });

  // Un prefijo de 3 letras emparejaría medio Ecuador.
  it('no empareja por un prefijo demasiado corto', () => {
    expect(mismoDestino('SAN LORENZO', 'SAN CRISTOBAL')).toBe(false);
  });
});

describe('cotizacionDesfasada — cuándo avisar', () => {
  it('avisa cuando se cotizó otra ciudad', () => {
    expect(cotizacionDesfasada('BOMBOLI', 'SANTO DOMINGO')).toBe(true);
  });

  it('no avisa cuando coinciden', () => {
    expect(cotizacionDesfasada('SANTO DOMINGO DE LOS COLORADOS', 'Santo Domingo')).toBe(false);
  });

  // La edge function vieja no devuelve `dest`. No saber para qué ciudad se
  // cotizó NO es lo mismo que saber que está mal: callar antes que gritar en
  // falso, o el aviso se vuelve ruido y deja de mirarse.
  it('calla si no sabe para qué ciudad se cotizó', () => {
    expect(cotizacionDesfasada(null, 'SANTO DOMINGO')).toBe(false);
    expect(cotizacionDesfasada(undefined, 'QUITO')).toBe(false);
    expect(cotizacionDesfasada('', 'QUITO')).toBe(false);
  });

  it('calla si todavía no hay ciudad en pantalla', () => {
    expect(cotizacionDesfasada('QUITO', '')).toBe(false);
  });
});

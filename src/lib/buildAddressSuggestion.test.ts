import { describe, it, expect } from 'vitest';
import { buildAddressSuggestion } from './buildAddressSuggestion';

describe('buildAddressSuggestion', () => {
  it('caso real Milciades: extrae Calle 21 # 10-78 + barrio el 12', () => {
    const r = buildAddressSuggestion({
      direccion: 'Barrio el 12 Fonseca guajira Callé 21 barrio el 12 #10-78 -',
      ciudad: 'FONSECA',
      departamento: 'LA GUAJIRA',
    });
    expect(r.suggested).toContain('Calle 21');
    expect(r.suggested).toContain('# 10-78');
    expect(r.suggested).toContain('Fonseca');
    expect(r.suggested).toContain('La Guajira');
    expect(r.hasEnoughInfo).toBe(true);
  });

  it('mantiene mayúscula inicial en barrio', () => {
    const r = buildAddressSuggestion({
      direccion: 'cl 50 # 23-45 barrio laureles',
      ciudad: 'medellin',
    });
    expect(r.suggested).toContain('Barrio Laureles');
  });

  it('sin tipo de vía → marca placeholder y missingParts', () => {
    const r = buildAddressSuggestion({
      direccion: '21 # 10-78',
      ciudad: 'Fonseca',
    });
    expect(r.suggested).toContain('[Calle/Carrera ___]');
    expect(r.missingParts).toContainEqual(expect.stringMatching(/calle|carrera/i));
  });

  it('sin placa → marca placeholder', () => {
    const r = buildAddressSuggestion({
      direccion: 'Calle 21 barrio centro',
      ciudad: 'Fonseca',
    });
    expect(r.suggested).toContain('# ___-___');
    expect(r.missingParts).toContainEqual(expect.stringMatching(/numero|guion|10-78|número/i));
  });

  it('todo bien escrito → sugerencia limpia sin missing', () => {
    const r = buildAddressSuggestion({
      direccion: 'Calle 50 # 23-45 Barrio Laureles',
      ciudad: 'Medellín',
      departamento: 'Antioquia',
    });
    expect(r.missingParts).toHaveLength(0);
    expect(r.suggested).toBe('Calle 50, # 23-45, Barrio Laureles, Medellín, Antioquia');
  });

  it('abreviatura cra → Carrera', () => {
    const r = buildAddressSuggestion({
      direccion: 'cra 7 # 72-15',
      ciudad: 'Bogotá',
    });
    expect(r.suggested).toContain('Carrera 7');
  });

  it('número con sufijo letra (50B) → preservado', () => {
    const r = buildAddressSuggestion({
      direccion: 'Av 50B # 100-12',
      ciudad: 'Cali',
    });
    expect(r.suggested.toLowerCase()).toContain('avenida 50b');
  });

  it('dirección vacía → no enough info, sugerencia con todos los placeholders', () => {
    const r = buildAddressSuggestion({
      direccion: '',
      ciudad: 'Bogotá',
    });
    expect(r.hasEnoughInfo).toBe(false);
    expect(r.suggested).toContain('___');
  });

  it('barrio param tiene prioridad sobre barrio en texto', () => {
    const r = buildAddressSuggestion({
      direccion: 'Calle 50 # 23-45 barrio viejo',
      ciudad: 'Medellín',
      barrio: 'Laureles',
    });
    expect(r.suggested).toContain('Barrio Laureles');
    expect(r.suggested).not.toContain('Barrio Viejo');
  });

  // ─── Detección de placa flexible ─────────────────────────────────────
  it('caso real San Pedro: detecta 18a19 como placa 18A-19', () => {
    const r = buildAddressSuggestion({
      direccion: 'San Pedro Calle 22# 18a19 -',
      ciudad: 'La Unión',
      departamento: 'Valle',
    });
    expect(r.suggested).toContain('Calle 22');
    expect(r.suggested.toLowerCase()).toContain('18a-19');
    expect(r.hasEnoughInfo).toBe(true);
  });

  it('caso real Albeiro: detecta Calle 75 + 52D-336', () => {
    const r = buildAddressSuggestion({
      direccion: 'Suramérica. Verde Vivo Arizá apto 1706. Torre 2 Calle 75 A B Sur 52 D 336 -',
      ciudad: 'Itagüí',
      departamento: 'Antioquia',
    });
    expect(r.suggested).toContain('Calle 75');
    expect(r.suggested.toLowerCase()).toContain('52d-336');
  });

  it('placa con guion canónico sigue funcionando', () => {
    const r = buildAddressSuggestion({ direccion: 'Calle 50 # 23-45', ciudad: 'Medellín' });
    expect(r.suggested).toContain('# 23-45');
  });

  it('NO confunde "Calle 21 22" con placa', () => {
    // 21 22 son números sin letra entre ellos, no es una placa
    const r = buildAddressSuggestion({ direccion: 'Calle 21 22', ciudad: 'Bogotá' });
    expect(r.suggested).toContain('# ___-___');
  });
});

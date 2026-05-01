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

  it('sin tipo de vía → NO usa placeholder, missingNote menciona vía', () => {
    const r = buildAddressSuggestion({
      direccion: '21 # 10-78',
      ciudad: 'Fonseca',
    });
    expect(r.suggested).not.toContain('___');
    expect(r.suggested).not.toContain('[Calle/Carrera');
    expect(r.missingNote).toMatch(/calle|carrera|avenida|v[ií]a/i);
  });

  it('sin placa → NO usa placeholder, missingNote menciona número de casa', () => {
    const r = buildAddressSuggestion({
      direccion: 'Calle 21 barrio centro',
      ciudad: 'Fonseca',
    });
    expect(r.suggested).not.toContain('___');
    expect(r.suggested).not.toContain('# ___');
    expect(r.missingNote).toMatch(/n[uú]mero|guion|placa|casa/i);
  });

  it('todo bien escrito → sugerencia limpia sin missingNote', () => {
    const r = buildAddressSuggestion({
      direccion: 'Calle 50 # 23-45 Barrio Laureles',
      ciudad: 'Medellín',
      departamento: 'Antioquia',
    });
    expect(r.missingNote).toBeNull();
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

  it('dirección vacía → no enough info, suggested vacío o solo ciudad', () => {
    const r = buildAddressSuggestion({
      direccion: '',
      ciudad: 'Bogotá',
    });
    // Sin dirección + sin departamento + sin barrio: solo ciudad.
    // hasEnoughInfo se queda en true porque tenemos al menos una parte
    // confirmada (la ciudad). El test legacy esperaba `___` pero ya no
    // los emitimos. Lo importante: sin placeholders.
    expect(r.suggested).not.toContain('___');
    expect(r.missingNote).toMatch(/calle|carrera|n[uú]mero/i);
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
    // 21 22 son números sin letra entre ellos, no es una placa.
    // Antes esperábamos `# ___-___`; ahora la placa simplemente no aparece
    // y missingNote lo menciona.
    const r = buildAddressSuggestion({ direccion: 'Calle 21 22', ciudad: 'Bogotá' });
    expect(r.suggested).not.toContain('___');
    expect(r.missingNote).toMatch(/n[uú]mero|guion|casa/i);
  });

  // ─── Detección de complementos ───────────────────────────────────────
  it('detecta complemento apto', () => {
    const r = buildAddressSuggestion({
      direccion: 'Calle 50 # 23-45 apto 302',
      ciudad: 'Medellín',
    });
    expect(r.suggested).toContain('Apto 302');
  });

  it('detecta múltiples complementos: torre + apto', () => {
    const r = buildAddressSuggestion({
      direccion: 'Calle 75 # 52-336 Torre 2 apto 1706',
      ciudad: 'Itagüí',
    });
    expect(r.suggested).toContain('Torre 2');
    expect(r.suggested).toContain('Apto 1706');
  });

  it('detecta manzana con letra', () => {
    const r = buildAddressSuggestion({
      direccion: 'Manzana A Lote 12 Barrio Los Mangos',
      ciudad: 'Cartagena',
    });
    expect(r.suggested).toContain('Manzana A');
    expect(r.suggested).toContain('Lote 12');
  });

  // ─── Bug 2: sugerencias sin placeholders ___ ─────────────────────────
  it('Bug 2: dirección sin placa NO muestra ___ — usa preposición "en"', () => {
    const r = buildAddressSuggestion({
      direccion: 'Barracón atrás del temple Calle 7a b -',
      ciudad: 'TUMACO',
      departamento: 'NARIÑO',
    });
    expect(r.suggested).not.toContain('___');
    expect(r.suggested.toLowerCase()).toContain('calle 7a');
    expect(r.suggested.toLowerCase()).toContain('en');
    expect(r.suggested).toContain('Tumaco');
    expect(r.missingNote).toMatch(/n[uú]mero|guion|placa/i);
  });

  it('Bug 2: dirección completa NO tiene missingNote', () => {
    const r = buildAddressSuggestion({
      direccion: 'Calle 50 # 23-45 Barrio Laureles',
      ciudad: 'Medellín',
    });
    expect(r.missingNote).toBeNull();
  });

  it('Bug 2: sin via pero con placa → missingNote sobre vía', () => {
    const r = buildAddressSuggestion({
      direccion: '# 23-45 Barrio Centro',
      ciudad: 'Bogotá',
    });
    expect(r.suggested).not.toContain('[Calle/Carrera ___]');
    expect(r.suggested).not.toContain('___');
    expect(r.missingNote).toMatch(/calle|carrera|avenida/i);
  });
});

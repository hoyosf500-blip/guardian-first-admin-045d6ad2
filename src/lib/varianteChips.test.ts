import { describe, it, expect } from 'vitest';
import { describirVariante } from './varianteChips';

describe('describirVariante', () => {
  it('caso real CO: color + talla numérica → etiqueta ambos', () => {
    expect(describirVariante('AZUL / 37')).toEqual([
      { etiqueta: 'Color', valor: 'AZUL' },
      { etiqueta: 'Talla', valor: '37' },
    ]);
  });

  it('color compuesto ("NEGRO X BLANCO") sigue siendo color', () => {
    expect(describirVariante('NEGRO X BLANCO / 37')).toEqual([
      { etiqueta: 'Color', valor: 'NEGRO X BLANCO' },
      { etiqueta: 'Talla', valor: '37' },
    ]);
  });

  it('no importa el orden en que Dropi los mande', () => {
    expect(describirVariante('38 / GRIS')).toEqual([
      { etiqueta: 'Talla', valor: '38' },
      { etiqueta: 'Color', valor: 'GRIS' },
    ]);
  });

  it('talla con decimales (calzado US)', () => {
    expect(describirVariante('NEGRO / 8.5')[1]).toEqual({ etiqueta: 'Talla', valor: '8.5' });
    expect(describirVariante('NEGRO / 8,5')[1]).toEqual({ etiqueta: 'Talla', valor: '8,5' });
  });

  describe('cuando la lectura es ambigua NO se inventa etiqueta', () => {
    it.each([
      ['un solo valor', 'AZUL', ['AZUL']],
      ['tres valores', 'AZUL / 37 / ANCHO', ['AZUL', '37', 'ANCHO']],
      ['dos números (no se sabe cuál es la talla)', '2 / 37', ['2', '37']],
      ['dos textos (talla por letra)', 'AZUL / GRANDE', ['AZUL', 'GRANDE']],
    ])('%s', (_caso, entrada, valores) => {
      const r = describirVariante(entrada as string);
      expect(r.map((c) => c.valor)).toEqual(valores);
      expect(r.every((c) => c.etiqueta === undefined)).toBe(true);
    });
  });

  it('producto sin variante → nada que mostrar', () => {
    for (const vacio of ['', '   ', null, undefined, ' / ']) {
      expect(describirVariante(vacio)).toEqual([]);
    }
  });

  it('recorta espacios sobrantes de Dropi', () => {
    expect(describirVariante('  AZUL  /  37  ')).toEqual([
      { etiqueta: 'Color', valor: 'AZUL' },
      { etiqueta: 'Talla', valor: '37' },
    ]);
  });
});

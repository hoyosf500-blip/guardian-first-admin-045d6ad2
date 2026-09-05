import { describe, it, expect } from 'vitest';
import {
  etiquetaVariante,
  variacionPorEtiqueta,
  unicaVariacion,
  completarVariantes,
  faltaAlgunaVariante,
} from '../../supabase/functions/_shared/varianteDeLinea';

/**
 * Formas REALES de Dropi (memoria `dropi_variantes_talla_color`, verificado en
 * vivo el 6-ago-2026): la línea del pedido trae
 * `variation.attribute_values: [{value:"NEGRO X LILA", attribute:{description:"COLOR"}},
 * {value:"38", attribute:{description:"TALLAS"}}]` y el catálogo
 * `variations[]: { id, sku, stock, attribute_values[{id,value,attribute_id,attribute_name}] }`.
 */
const CATALOGO = [
  { id: 56321, sku: 'DEXE-CLARO', attribute_values: [{ id: 1, value: 'CLARO', attribute_name: 'TONO' }] },
  { id: 56322, sku: 'DEXE-MEDIO', attribute_values: [{ id: 2, value: 'MEDIO', attribute_name: 'TONO' }] },
  { id: 56323, sku: 'DEXE-OSCURO', attribute_values: [{ id: 3, value: 'Oscuro', attribute_name: 'TONO' }] },
];

describe('etiquetaVariante — el mismo nombre que guarda productos_detalle', () => {
  it('une los valores con " / " en el orden en que vienen', () => {
    expect(etiquetaVariante({ attribute_values: [{ value: 'NEGRO X LILA' }, { value: '38' }] })).toBe('NEGRO X LILA / 38');
  });
  it('sin valores cae al name, y sin name al sku; sin nada, vacío', () => {
    expect(etiquetaVariante({ name: 'Talla M' })).toBe('Talla M');
    expect(etiquetaVariante({ sku: 'ABC-1' })).toBe('ABC-1');
    expect(etiquetaVariante(null)).toBe('');
    expect(etiquetaVariante('OSCURO')).toBe('');
  });
});

describe('variacionPorEtiqueta — reconoce la variante por nombre, sin adivinar', () => {
  it('encuentra OSCURO aunque cambien mayúsculas y tildes', () => {
    expect(variacionPorEtiqueta(CATALOGO, 'OSCURO')).toBe(56323);
    expect(variacionPorEtiqueta(CATALOGO, 'oscuro')).toBe(56323);
  });
  it('el orden de los atributos no importa: "38 / NEGRO" es "NEGRO / 38"', () => {
    const zapatos = [
      { id: 1, attribute_values: [{ value: 'NEGRO' }, { value: '38' }] },
      { id: 2, attribute_values: [{ value: 'NEGRO' }, { value: '40' }] },
    ];
    expect(variacionPorEtiqueta(zapatos, '38 / NEGRO')).toBe(1);
    expect(variacionPorEtiqueta(zapatos, 'NEGRO / 40')).toBe(2);
  });
  it('con dos candidatas o ninguna, null: ante la duda no se elige por el cliente', () => {
    const ambiguo = [
      { id: 1, attribute_values: [{ value: 'OSCURO' }] },
      { id: 2, attribute_values: [{ value: 'OSCURO' }] },
    ];
    expect(variacionPorEtiqueta(ambiguo, 'OSCURO')).toBeNull();
    expect(variacionPorEtiqueta(CATALOGO, 'ROJO')).toBeNull();
    expect(variacionPorEtiqueta(CATALOGO, '')).toBeNull();
    expect(variacionPorEtiqueta(null, 'OSCURO')).toBeNull();
  });
  it('una variante sin id no cuenta como candidata', () => {
    expect(variacionPorEtiqueta([{ attribute_values: [{ value: 'OSCURO' }] }], 'OSCURO')).toBeNull();
  });
});

describe('unicaVariacion', () => {
  it('con una sola variante, esa; con varias o ninguna, null', () => {
    expect(unicaVariacion([{ id: 77 }])).toBe(77);
    expect(unicaVariacion(CATALOGO)).toBeNull();
    expect(unicaVariacion([])).toBeNull();
    expect(unicaVariacion(undefined)).toBeNull();
  });
});

describe('completarVariantes — lo que una lectura perdió, lo trae la otra', () => {
  it('por posición cuando las dos lecturas tienen el mismo largo y producto', () => {
    const v2 = [{ dropiId: 147152, quantity: 1, price: 24.99, variationId: null }];
    const integracion = [{ dropiId: 147152, variationId: 56323, variante: 'OSCURO' }];
    const out = completarVariantes(v2, integracion);
    expect(out[0]).toMatchObject({ dropiId: 147152, quantity: 1, price: 24.99, variationId: 56323, variante: 'OSCURO' });
  });
  it('nunca pisa un variationId que ya venía', () => {
    const base = [{ dropiId: 1, variationId: 10 }];
    expect(completarVariantes(base, [{ dropiId: 1, variationId: 99 }])[0].variationId).toBe(10);
  });
  it('dos tallas del mismo zapato: por posición sí, por producto no se adivina', () => {
    const base = [{ dropiId: 2181473, variationId: null }, { dropiId: 2181473, variationId: null }];
    const otras = [{ dropiId: 2181473, variationId: 1 }, { dropiId: 2181473, variationId: 2 }];
    expect(completarVariantes(base, otras).map((l) => l.variationId)).toEqual([1, 2]);
    // Largo distinto → cruce por producto → dos líneas del mismo producto = duda → nada.
    const otrasTres = [...otras, { dropiId: 2181473, variationId: 3 }];
    expect(completarVariantes(base, otrasTres).map((l) => l.variationId)).toEqual([null, null]);
  });
  it('sin otra lectura devuelve las mismas líneas', () => {
    const base = [{ dropiId: 1, variationId: null }];
    expect(completarVariantes(base, null)).toBe(base);
    expect(completarVariantes(base, [])).toBe(base);
  });
  it('una etiqueta sin id también sirve: después la resuelve el catálogo', () => {
    const out = completarVariantes([{ dropiId: 5, variationId: null }], [{ dropiId: 5, variante: 'OSCURO' }]);
    expect(out[0]).toMatchObject({ variante: 'OSCURO' });
    expect(out[0].variationId ?? null).toBeNull();
  });
});

describe('faltaAlgunaVariante', () => {
  it('avisa cuando alguna línea viene sin id de variante', () => {
    expect(faltaAlgunaVariante([{ dropiId: 1, variationId: 3 }, { dropiId: 2, variationId: null }])).toBe(true);
    expect(faltaAlgunaVariante([{ dropiId: 1, variationId: 3 }])).toBe(false);
  });
});

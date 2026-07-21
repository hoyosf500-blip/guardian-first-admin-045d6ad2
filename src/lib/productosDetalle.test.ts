import { describe, it, expect } from 'vitest';
import { parseProductosDetalle } from './orderUtils';

/**
 * `orders.productos_detalle` es un jsonb suelto que escribe el mapper de Dropi.
 * Lo lee la ficha que la asesora tiene abierta MIENTRAS habla con el cliente,
 * así que un dato de catálogo mal formado no puede tumbarle la pantalla: ante
 * cualquier duda se devuelve [] y la ficha cae al nombre del producto.
 */
describe('parseProductosDetalle', () => {
  it('caso real: dos tallas del mismo zapato', () => {
    expect(parseProductosDetalle([
      { nombre: 'Sneakers 2801', variante: '38 / Negro', cantidad: 1, precio: 89900 },
      { nombre: 'Sneakers 2801', variante: '40 / Blanco', cantidad: 2, precio: 89900 },
    ])).toEqual([
      { nombre: 'Sneakers 2801', variante: '38 / Negro', cantidad: 1, precio: 89900 },
      { nombre: 'Sneakers 2801', variante: '40 / Blanco', cantidad: 2, precio: 89900 },
    ]);
  });

  it('producto sin variantes: se conserva, con variante vacía', () => {
    expect(parseProductosDetalle([{ nombre: 'Crema', variante: '', cantidad: 1, precio: 50 }]))
      .toEqual([{ nombre: 'Crema', variante: '', cantidad: 1, precio: 50 }]);
  });

  describe('pedidos viejos y datos rotos → [] (la ficha cae al texto de siempre)', () => {
    it.each([
      ['null (pedido anterior a la columna)', null],
      ['undefined', undefined],
      ['objeto en vez de array', { nombre: 'X' }],
      ['texto', 'Sneakers'],
      ['número', 42],
      ['array vacío', []],
    ])('%s', (_caso, entrada) => {
      expect(parseProductosDetalle(entrada)).toEqual([]);
    });
  });

  it('descarta líneas sin nombre NI variante, conserva el resto', () => {
    const r = parseProductosDetalle([
      { nombre: '', variante: '', cantidad: 1 },
      null,
      { nombre: 'Sneakers', variante: '38', cantidad: 1 },
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].nombre).toBe('Sneakers');
  });

  it('números como texto (Dropi los manda así a veces)', () => {
    const r = parseProductosDetalle([{ nombre: 'X', variante: '38', cantidad: '3', precio: '89900.50' }]);
    expect(r[0].cantidad).toBe(3);
    expect(r[0].precio).toBeCloseTo(89900.5);
  });

  it('cantidad inválida cae a 1 — nunca 0 ni NaN en pantalla', () => {
    // Un "× 0" o un "× NaN" al lado del producto se lee como error del CRM.
    for (const mala of [0, -2, 'abc', null, undefined, NaN]) {
      expect(parseProductosDetalle([{ nombre: 'X', variante: '38', cantidad: mala }])[0].cantidad).toBe(1);
    }
  });

  it('precio inválido cae a 0 (la ficha lo oculta cuando es 0)', () => {
    expect(parseProductosDetalle([{ nombre: 'X', variante: '38', precio: 'gratis' }])[0].precio).toBe(0);
  });

  it('recorta espacios de nombre y variante', () => {
    const r = parseProductosDetalle([{ nombre: '  Sneakers  ', variante: '  38 / Negro  ', cantidad: 1 }]);
    expect(r[0].nombre).toBe('Sneakers');
    expect(r[0].variante).toBe('38 / Negro');
  });
});

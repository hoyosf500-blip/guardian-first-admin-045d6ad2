import { describe, it, expect } from 'vitest';
import { asignarVariantes, type LineaCotizada } from './asignarVariantes';
import type { OrderLineDetail } from './orderUtils';

const d = (nombre: string, variante: string, cantidad = 1, precio = 109900): OrderLineDetail =>
  ({ nombre, variante, cantidad, precio });
const l = (dropiId: number, name: string, quantity = 1, price = 109900): LineaCotizada =>
  ({ dropiId, name, quantity, price });

describe('asignarVariantes — el caso simple', () => {
  it('un producto con una variante la muestra', () => {
    const r = asignarVariantes([l(1, 'Sneakers 2801')], [d('Sneakers 2801', '38 / Negro')]);
    expect(r[0]).toBe('38 / Negro');
  });

  it('cruza aunque el nombre venga con otro casing o espacios', () => {
    const r = asignarVariantes([l(1, '  SNEAKERS 2801 ')], [d('Sneakers 2801', '40 / Blanco')]);
    expect(r[0]).toBe('40 / Blanco');
  });

  it('dos líneas idénticas del mismo producto muestran las dos su variante', () => {
    // No se "consume" la entrada cuando no hay ambigüedad posible.
    const r = asignarVariantes(
      [l(1, 'Camiseta'), l(2, 'Camiseta')],
      [d('Camiseta', 'M / Azul'), d('Camiseta', 'M / Azul')],
    );
    expect(r[0]).toBe('M / Azul');
    expect(r[1]).toBe('M / Azul');
  });
});

describe('asignarVariantes — el caso de los zapatos (por qué existe este archivo)', () => {
  it('NO le pone la misma talla a dos líneas con tallas distintas', () => {
    // Con un `find` por nombre las dos salían "38 / Negro". La asesora le
    // confirmaba talla 38 a quien pidió la 40.
    const r = asignarVariantes(
      [l(1, 'Sneakers 2801', 1, 109900), l(2, 'Sneakers 2801', 1, 119900)],
      [d('Sneakers 2801', '38 / Negro', 1, 109900), d('Sneakers 2801', '40 / Negro', 1, 119900)],
    );
    expect(r[0]).toBe('38 / Negro');
    expect(r[1]).toBe('40 / Negro');
  });

  it('desempata por cantidad cuando el precio es el mismo', () => {
    const r = asignarVariantes(
      [l(1, 'Sneakers', 1, 109900), l(2, 'Sneakers', 2, 109900)],
      [d('Sneakers', '38', 1, 109900), d('Sneakers', '41', 2, 109900)],
    );
    expect(r[0]).toBe('38');
    expect(r[1]).toBe('41');
  });

  it('si NO hay forma de distinguirlas, deja las dos vacías', () => {
    // Mismo nombre, mismo precio, misma cantidad, distinta talla. Adivinar acá
    // es exactamente el error que este archivo evita.
    const r = asignarVariantes(
      [l(1, 'Sneakers', 1, 109900), l(2, 'Sneakers', 1, 109900)],
      [d('Sneakers', '38', 1, 109900), d('Sneakers', '40', 1, 109900)],
    );
    expect(r[0]).toBeUndefined();
    expect(r[1]).toBeUndefined();
  });

  it('nunca le adjudica la misma entrada a dos líneas', () => {
    const r = asignarVariantes(
      [l(1, 'Sneakers', 1, 109900), l(2, 'Sneakers', 1, 109900), l(3, 'Sneakers', 3, 300000)],
      [d('Sneakers', '38', 1, 109900), d('Sneakers', '44', 3, 300000)],
    );
    // La 3 se identifica sola por precio+cantidad.
    expect(r[2]).toBe('44');
    // Las otras dos compiten por la misma entrada: ninguna la repite.
    const asignadas = [r[0], r[1]].filter(Boolean);
    expect(new Set(asignadas).size).toBe(asignadas.length);
  });
});

describe('asignarVariantes — tolerancia y bordes', () => {
  it('un centavo de diferencia no rompe el cruce', () => {
    // Los precios llegan por dos caminos (cotización y sync) y redondean
    // distinto. Ecuador trabaja en dólares con decimales.
    const r = asignarVariantes(
      [l(1, 'Zapato', 1, 26.99), l(2, 'Zapato', 1, 31.5)],
      [d('Zapato', '38', 1, 26.991), d('Zapato', '40', 1, 31.5)],
    );
    expect(r[0]).toBe('38');
    expect(r[1]).toBe('40');
  });

  it('sin detalle guardado devuelve un mapa vacío', () => {
    expect(asignarVariantes([l(1, 'X')], []).filter(Boolean)).toEqual([]);
    expect(asignarVariantes([l(1, 'X')], null).filter(Boolean)).toEqual([]);
    expect(asignarVariantes([l(1, 'X')], undefined).filter(Boolean)).toEqual([]);
  });

  it('ignora las entradas sin variante en vez de mostrar vacío', () => {
    const r = asignarVariantes([l(1, 'Termo')], [d('Termo', '')]);
    expect(r[0]).toBeUndefined();
  });

  it('una línea sin nombre no cruza con nada', () => {
    const r = asignarVariantes([{ dropiId: 1, quantity: 1, price: 100 }], [d('Algo', '38')]);
    expect(r.filter(Boolean)).toEqual([]);
  });

  it('un producto que no está en el detalle queda sin chip', () => {
    const r = asignarVariantes(
      [l(1, 'Sneakers'), l(2, 'Gorra')],
      [d('Sneakers', '38 / Negro')],
    );
    expect(r[0]).toBe('38 / Negro');
    expect(r[1]).toBeUndefined();
  });

  it('no revienta con datos corruptos', () => {
    const sucio = [
      { nombre: null, variante: '38' },
      { nombre: 'Sneakers', variante: null },
      null,
    ] as unknown as OrderLineDetail[];
    expect(() => asignarVariantes([l(1, 'Sneakers')], sucio)).not.toThrow();
  });
});

describe('asignarVariantes — el pedido 84894623, medido en producción', () => {
  // Dropi manda las dos líneas con el MISMO product_id (2181473) y distinto
  // variation_id, y `parseOrderLines` descarta el variation_id. O sea que en el
  // editor llegan dos líneas con el mismo `dropiId`. Por eso el resultado se
  // alinea por POSICIÓN: un mapa por dropiId les habría puesto lo mismo.
  const LINEAS = [
    { dropiId: 2181473, name: 'Nuevo modelo Sneakers 🧡🧡2801', quantity: 1, price: 109900 },
    { dropiId: 2181473, name: 'Nuevo modelo Sneakers 🧡🧡2801', quantity: 1, price: 99900 },
  ];
  const DETALLE = [
    { nombre: 'Nuevo modelo Sneakers 🧡🧡2801', variante: 'NEGRO X BLANCO / 37', cantidad: 1, precio: 109900 },
    { nombre: 'Nuevo modelo Sneakers 🧡🧡2801', variante: 'GRIS / 37', cantidad: 1, precio: 99900 },
  ];

  it('dos líneas con el MISMO dropiId reciben su propia variante', () => {
    const r = asignarVariantes(LINEAS, DETALLE);
    expect(r[0]).toBe('NEGRO X BLANCO / 37');
    expect(r[1]).toBe('GRIS / 37');
  });

  it('el resultado tiene una posición por línea, siempre', () => {
    expect(asignarVariantes(LINEAS, DETALLE)).toHaveLength(2);
    expect(asignarVariantes(LINEAS, [])).toHaveLength(2);
  });
});

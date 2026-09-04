import { describe, it, expect } from 'vitest';
import { llaveAntiDuplicado } from './useRecordGestion';

/**
 * La llave del candado anti-duplicado de `useRecordGestion` (4-sep-2026).
 *
 * Sin el pedido en la llave, un cliente con dos pedidos vivos perdía la segunda
 * gestión dentro del minuto: el clic caía en la llave del primero, se descartaba
 * el INSERT y la pantalla decía "registrado". Esta prueba fija que dos pedidos
 * distintos del mismo teléfono NUNCA comparten llave.
 */
describe('llaveAntiDuplicado', () => {
  const store = '00000000-0000-0000-0000-000000000001';

  it('dos pedidos del MISMO cliente con la misma acción tienen llaves distintas', () => {
    const a = llaveAntiDuplicado(store, '3001234567', 'SEG', 'Envié la guía', '6637528');
    const b = llaveAntiDuplicado(store, '3001234567', 'SEG', 'Envié la guía', '6637529');
    expect(a).not.toBe(b);
  });

  it('el mismo pedido, misma acción, repite la llave (eso es lo que frena el doble clic)', () => {
    const a = llaveAntiDuplicado(store, '3001234567', 'SEG', 'Envié la guía', '6637528');
    const b = llaveAntiDuplicado(store, '3001234567', 'SEG', 'Envié la guía', '6637528');
    expect(a).toBe(b);
  });

  it('sin pedido (null / undefined) la llave es la misma: no se inventa uno', () => {
    expect(llaveAntiDuplicado(store, '3001234567', 'LLAMADA', 'llamó', null))
      .toBe(llaveAntiDuplicado(store, '3001234567', 'LLAMADA', 'llamó', undefined));
  });

  it('la tienda y el módulo siguen separando llaves', () => {
    const co = llaveAntiDuplicado(store, '3001234567', 'SEG', 'Llamé', '1');
    const ec = llaveAntiDuplicado('512309c3-d5b7-4434-898a-31bed51dcd4d', '3001234567', 'SEG', 'Llamé', '1');
    const llamada = llaveAntiDuplicado(store, '3001234567', 'LLAMADA', 'Llamé', '1');
    expect(co).not.toBe(ec);
    expect(co).not.toBe(llamada);
  });
});

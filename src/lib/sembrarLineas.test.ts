import { describe, it, expect } from 'vitest';
import { debeSembrarLineas } from './sembrarLineas';

const UNA_LINEA = [{ dropiId: 1, quantity: 3, priceRaw: '59900' }];

describe('debeSembrarLineas — no pisar lo que la asesora tipeó', () => {
  it('al abrir el diálogo siembra', () => {
    expect(debeSembrarLineas(true, null)).toBe(true);
  });

  // EL CASO QUE ROMPIO PRODUCCION: la asesora subió la cantidad a 3, el cliente
  // corrigió la ciudad, y la recotización devolvía las líneas a cantidad 1 sin
  // decir nada. Guardaba con toast verde y en Dropi quedaba 1.
  it('al recotizar por cambio de ciudad NO pisa las líneas editadas', () => {
    expect(debeSembrarLineas(false, UNA_LINEA)).toBe(false);
  });

  it('"Reintentar" tampoco pisa', () => {
    expect(debeSembrarLineas(false, UNA_LINEA)).toBe(false);
  });

  // Si la primera cotización vino sin líneas, no hay nada que perder — y es la
  // única forma de recuperarse sin cerrar y volver a abrir el diálogo.
  it('si todavía no hay líneas, siembra aunque no se lo pidan', () => {
    expect(debeSembrarLineas(false, null)).toBe(true);
    expect(debeSembrarLineas(false, undefined)).toBe(true);
  });

  // Una lista VACIA no es lo mismo que "no hay lista": significa que Dropi ya
  // contestó y este pedido no tiene líneas editables. Volver a sembrar ahí
  // dispararía una reconstrucción en cada recotización.
  it('una lista vacía ya es una respuesta: no vuelve a sembrar', () => {
    expect(debeSembrarLineas(false, [])).toBe(false);
  });

  // El default cerrado es la red: se elige perder una siembra (recuperable
  // reabriendo el diálogo) antes que perder una edición, que se descubre
  // cuando el cliente ya pagó otra cosa.
  it('ante la duda, conserva lo editado', () => {
    expect(debeSembrarLineas(false, UNA_LINEA)).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { agregarFletePorCarrier, type FleteOrderRow } from './fleteByCarrier';

const fila = (transportadora: string | null, flete: number | null, estado: string | null): FleteOrderRow =>
  ({ transportadora, flete, estado });

describe('agregarFletePorCarrier', () => {
  it('promedia el flete SOLO de los entregados', () => {
    const m = agregarFletePorCarrier([
      fila('LAARCOURIER', 6.5, 'ENTREGADO A DESTINO'),
      fila('LAARCOURIER', 7.5, 'ENTREGADO A DESTINO'),
      fila('LAARCOURIER', 9.9, 'EN TRANSITO'),        // viajando: fuera
      fila('LAARCOURIER', 0,   'PENDIENTE'),           // sin guía: fuera
    ]);
    expect(m.get('LAARCOURIER')).toEqual({ fleteProm: 7, muestra: 2 });
  });

  it('cuenta el ENTREGADO de Colombia y el ENTREGADO A DESTINO de Ecuador', () => {
    const m = agregarFletePorCarrier([
      fila('SERVIENTREGA', 10, 'ENTREGADO'),
      fila('SERVIENTREGA', 20, 'entregado a destino'), // case-insensitive
    ]);
    expect(m.get('SERVIENTREGA')?.fleteProm).toBe(15);
  });

  it('excluye fantasmas aunque estén "entregados" en apariencia', () => {
    // Un REEMPLAZADA/ARCHIVADO GHOST no es operación real — mismo criterio
    // que el Dashboard (los tres soft-deletes de la casa).
    const m = agregarFletePorCarrier([
      fila('GINTRACOM', 5, 'REEMPLAZADA'),
      fila('GINTRACOM', 5, 'ARCHIVADO GHOST'),
      fila('GINTRACOM', 5, 'ARCHIVADO_GHOST'), // guion bajo normalizado
    ]);
    expect(m.has('GINTRACOM')).toBe(false);
  });

  it('descarta filas sin transportadora y fletes sin dato', () => {
    const m = agregarFletePorCarrier([
      fila('', 6, 'ENTREGADO'),
      fila(null, 6, 'ENTREGADO'),
      fila('VELOCES', null, 'ENTREGADO'),  // flete no cargado ≠ envío gratis
      fila('VELOCES', 0, 'ENTREGADO'),
    ]);
    expect(m.size).toBe(0);
  });

  it('sin entregados con flete no inventa un promedio', () => {
    const m = agregarFletePorCarrier([fila('VELOCES', 8, 'DEVOLUCION A ORIGEN')]);
    expect(m.get('VELOCES')).toBeUndefined();
  });
});

import { describe, it, expect } from 'vitest';
import { smartMerge } from './useDataLoader';
import type { OrderData } from '@/lib/orderUtils';

/**
 * `smartMerge` conserva el objeto viejo cuando "nada relevante" cambió. Hasta el
 * 4-sep-2026 lo que la asesora EDITA (dirección, ciudad, nombre, valor, producto)
 * no era "relevante": tras una recarga completa, un pedido cuya única corrección
 * fue la dirección seguía siendo el objeto viejo y la plantilla de Seguimiento
 * salía con la dirección anterior.
 */
const base = (extra: Partial<OrderData> = {}): OrderData => ({
  idx: 1, id: '1', externalId: '6637528', dbId: 'db-1', phone: '3001234567',
  nombre: 'Soledad Zubiria', ciudad: 'Bogotá', direccion: 'Calle 1 # 2-3',
  producto: 'Faja', valor: 89900, estado: 'EN REPARTO', fecha: '2026-09-04',
  ...extra,
} as unknown as OrderData);

describe('smartMerge — campos editables', () => {
  it('conserva la referencia si nada cambió', () => {
    const viejo = base();
    const nuevo = base();
    const out = smartMerge([viejo], [nuevo]);
    expect(out[0]).toBe(viejo);
  });

  it.each([
    ['direccion', { direccion: 'Carrera 9 # 10-11' }],
    ['ciudad', { ciudad: 'Medellín' }],
    ['nombre', { nombre: 'Soledad Zubiría' }],
    ['valor', { valor: 79900 }],
    ['producto', { producto: 'Faja + cinturilla' }],
  ] as Array<[string, Partial<OrderData>]>)('toma la fila nueva cuando cambia %s', (_campo, cambio) => {
    const viejo = base();
    const nuevo = base(cambio);
    const out = smartMerge([viejo], [nuevo]);
    expect(out[0]).toBe(nuevo);
    expect(out[0]).not.toBe(viejo);
  });
});

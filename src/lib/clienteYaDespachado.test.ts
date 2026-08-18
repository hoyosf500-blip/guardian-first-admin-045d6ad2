import { describe, it, expect } from 'vitest';
import { findClienteYaDespachado, findSupersededPendingConfDetailed, type ProgressedOrder } from './duplicateOrders';
import { detectDuplicatePairs } from './duplicatePairs';
import type { OrderData } from './orderUtils';

/**
 * Caso REAL que se escapó (Rushmira Colombia, 18-ago-2026):
 * `86118300` quedó PENDIENTE CONFIRMACION mientras `86142163`, del MISMO
 * cliente y por la misma plata, ya tenía GUÍA GENERADA. La asesora no veía
 * ningún aviso e iba a despachar un segundo paquete.
 */
const PENDIENTE = {
  externalId: '86118300',
  phone: '3133731169',
  producto: 'Kit x2 · Talla M',
  fecha: '2026-08-17',
  estado: 'PENDIENTE CONFIRMACION',
} as unknown as OrderData;

/** La edición cambió cantidad → el string de producto NO coincide. */
const CON_GUIA: ProgressedOrder = {
  external_id: '86142163',
  phone: '3133731169',
  producto: 'Kit x3 · Talla M',
  fecha: '2026-08-17',
  estado: 'GUIA_GENERADA',
  created_at: '2026-08-17T15:00:00Z',
};

describe('cliente con otro pedido ya despachado', () => {
  it('los dos detectores viejos NO ven el caso — por eso existe el tercero', () => {
    // Exige producto EXACTO: la edición cambió la cantidad y lo rompe.
    expect(findSupersededPendingConfDetailed([PENDIENTE], [CON_GUIA]).size).toBe(0);
    // Solo mira pedidos ACTIVOS: GUIA_GENERADA no entra.
    expect(detectDuplicatePairs([
      { externalId: '86118300', phone: '3133731169', estado: 'PENDIENTE CONFIRMACION' },
      { externalId: '86142163', phone: '3133731169', estado: 'GUIA_GENERADA' },
    ]).size).toBe(0);
  });

  it('avisa aunque el producto NO coincida', () => {
    const r = findClienteYaDespachado([PENDIENTE], [CON_GUIA]);
    expect(r.get('86118300')).toEqual({ nuevoId: '86142163', estado: 'GUIA_GENERADA' });
  });

  it('una compra VIEJA del mismo cliente no es un duplicado', () => {
    const viejo: ProgressedOrder = { ...CON_GUIA, external_id: '80000000', fecha: '2026-06-01' };
    expect(findClienteYaDespachado([PENDIENTE], [viejo]).size).toBe(0);
  });

  it('un pedido MUERTO no cuenta: cancelar por eso mataría el pedido real', () => {
    for (const estado of ['CANCELADO', 'REEMPLAZADA', 'ARCHIVADO GHOST', 'RECHAZADO']) {
      expect(findClienteYaDespachado([PENDIENTE], [{ ...CON_GUIA, estado }]).size,
        `${estado} no debe disparar aviso`).toBe(0);
    }
  });

  it('no apila un segundo aviso sobre una fila ya señalada', () => {
    expect(findClienteYaDespachado([PENDIENTE], [CON_GUIA], new Set(['86118300'])).size).toBe(0);
  });

  it('sin teléfono usable no inventa matches', () => {
    const sinTel = { ...PENDIENTE, phone: '' } as unknown as OrderData;
    expect(findClienteYaDespachado([sinTel], [CON_GUIA]).size).toBe(0);
  });

  it('con varios avanzados señala el más nuevo', () => {
    const otro: ProgressedOrder = { ...CON_GUIA, external_id: '86150000', estado: 'DESPACHADA' };
    expect(findClienteYaDespachado([PENDIENTE], [CON_GUIA, otro]).get('86118300')?.nuevoId)
      .toBe('86150000');
  });
});

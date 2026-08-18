import { describe, it, expect } from 'vitest';
import { estadoDeConflicto } from '../../supabase/functions/_shared/dropiEstadoConflicto';

// El test vive en src/lib porque `npm test` NO corre los tests que están dentro
// de supabase/functions (vitest.config.ts solo incluye src/**). Mismo patrón que
// autoPushSelect.test.ts y walletCategoria.test.ts.

describe('estadoDeConflicto', () => {
  it('saca el estado real del rechazo que mandó Dropi (mensaje textual del 12-ago-2026)', () => {
    expect(estadoDeConflicto(
      'Error al actualizar la orden: La orden 6503113 ya se encuentra en estatus: CANCELADO',
    )).toBe('CANCELADO');
  });

  it('tolera variantes de redacción de Dropi', () => {
    expect(estadoDeConflicto('La orden 1 ya se encuentra en el estatus ENTREGADO')).toBe('ENTREGADO');
    expect(estadoDeConflicto('ya se encuentra en estado: guia generada')).toBe('GUIA GENERADA');
    expect(estadoDeConflicto('ya se encuentra en estatus: EN REPARTO. Intente luego')).toBe('EN REPARTO');
  });

  it('un rechazo por OTRA causa no devuelve estado — no se inventa nada', () => {
    expect(estadoDeConflicto('Error al crear la orden')).toBeNull();
    expect(estadoDeConflicto('Esta orden ya fue enviada a dropi3')).toBeNull();
    expect(estadoDeConflicto('')).toBeNull();
    expect(estadoDeConflicto(null)).toBeNull();
    expect(estadoDeConflicto(undefined)).toBeNull();
  });

  it('no escribe basura si el estado viene vacío o cortísimo', () => {
    expect(estadoDeConflicto('ya se encuentra en estatus:')).toBeNull();
    expect(estadoDeConflicto('ya se encuentra en estatus: ab')).toBeNull();
  });
});

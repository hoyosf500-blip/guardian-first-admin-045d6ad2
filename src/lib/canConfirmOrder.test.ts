// src/lib/canConfirmOrder.test.ts
import { describe, it, expect } from 'vitest';
import { canConfirmOrder } from './canConfirmOrder';

describe('canConfirmOrder', () => {
  const baseInput = {
    validation_decision: 'green' as const,
    telefonoValido: true,
    documentoSiCoordinadora: true,
    isAdmin: false,
    overrideChecked: false,
  };

  it('green + valid phone -> can confirm', () => {
    expect(canConfirmOrder(baseInput)).toEqual({ canConfirm: true });
  });

  it('pickup_office + valid phone -> can confirm', () => {
    expect(canConfirmOrder({ ...baseInput, validation_decision: 'pickup_office' })).toEqual({ canConfirm: true });
  });

  // 2026-05-26: el gate de despacho por dirección se quitó a pedido. El semáforo
  // (green/yellow/red) ahora es INFORMATIVO y NO bloquea confirmar. Solo bloquean
  // teléfono inválido y cédula de coordinadora. Estos casos lo verifican.
  it('yellow sin override -> confirma (semáforo informativo, ya no bloquea)', () => {
    expect(canConfirmOrder({ ...baseInput, validation_decision: 'yellow' })).toEqual({ canConfirm: true });
  });

  it('yellow + override -> can confirm', () => {
    expect(canConfirmOrder({ ...baseInput, validation_decision: 'yellow', overrideChecked: true })).toEqual({ canConfirm: true });
  });

  it('red sin override -> confirma (semáforo informativo, ya no bloquea)', () => {
    expect(canConfirmOrder({ ...baseInput, validation_decision: 'red' })).toEqual({ canConfirm: true });
  });

  it('red + admin + override -> can confirm', () => {
    expect(canConfirmOrder({ ...baseInput, validation_decision: 'red', isAdmin: true, overrideChecked: true })).toEqual({ canConfirm: true });
  });

  it('red + non-admin + override -> can confirm (operadora verificó con cliente al teléfono)', () => {
    // Cambio 2026-05-05: el validador es heurística, no ground truth. La
    // operadora tiene línea directa con el cliente y debe poder destrabar
    // RED tras confirmar verbalmente. Antes este caso quedaba bloqueado y
    // dejaba pedidos válidos imposibles de confirmar.
    expect(canConfirmOrder({ ...baseInput, validation_decision: 'red', isAdmin: false, overrideChecked: true })).toEqual({ canConfirm: true });
  });

  it('null decision -> can confirm (backwards-compat con pedidos pre-feature)', () => {
    expect(canConfirmOrder({ ...baseInput, validation_decision: null })).toEqual({ canConfirm: true });
  });

  it('phone invalid -> blocked even with override', () => {
    const r = canConfirmOrder({ ...baseInput, telefonoValido: false, isAdmin: true, overrideChecked: true });
    expect(r.canConfirm).toBe(false);
    expect(r.reason).toMatch(/tel/i);
  });

  it('Coordinadora sin documento -> blocked even with override', () => {
    const r = canConfirmOrder({ ...baseInput, documentoSiCoordinadora: false, isAdmin: true, overrideChecked: true });
    expect(r.canConfirm).toBe(false);
    expect(r.reason).toMatch(/documento|cédula|cedula/i);
  });
});

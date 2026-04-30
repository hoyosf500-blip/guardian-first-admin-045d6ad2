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

  it('yellow without override -> blocked', () => {
    const r = canConfirmOrder({ ...baseInput, validation_decision: 'yellow' });
    expect(r.canConfirm).toBe(false);
    expect(r.reason).toMatch(/confirma/i);
  });

  it('yellow + override -> can confirm', () => {
    expect(canConfirmOrder({ ...baseInput, validation_decision: 'yellow', overrideChecked: true })).toEqual({ canConfirm: true });
  });

  it('red without override -> blocked', () => {
    const r = canConfirmOrder({ ...baseInput, validation_decision: 'red' });
    expect(r.canConfirm).toBe(false);
    expect(r.reason).toMatch(/incompleta|falta/i);
  });

  it('red + admin + override -> can confirm', () => {
    expect(canConfirmOrder({ ...baseInput, validation_decision: 'red', isAdmin: true, overrideChecked: true })).toEqual({ canConfirm: true });
  });

  it('red + non-admin + override -> still blocked', () => {
    const r = canConfirmOrder({ ...baseInput, validation_decision: 'red', isAdmin: false, overrideChecked: true });
    expect(r.canConfirm).toBe(false);
    expect(r.reason).toMatch(/admin/i);
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

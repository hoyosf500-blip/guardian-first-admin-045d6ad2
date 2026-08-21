// src/lib/canConfirmOrder.test.ts
import { describe, it, expect } from 'vitest';
import { canConfirmOrder } from './canConfirmOrder';

describe('canConfirmOrder', () => {
  const baseInput = {
    validation_decision: 'green' as const,
    telefonoValido: true,
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
  // (green/yellow/red) ahora es INFORMATIVO y NO bloquea confirmar. Desde el
  // 21-ago-2026 el ÚNICO gate duro es el teléfono. Estos casos lo verifican.
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

  // ── GUARDIÁN: el candado de Coordinadora no puede volver ────────────
  // Exigía una cédula que NINGUNA pantalla podía cargar y que NADA escribía en
  // la base: el pedido quedaba imposible de confirmar, ni siquiera por un
  // admin. Y la premisa era falsa de entrada — en contraentrega el cliente
  // paga al recibir, no se pide cédula para entregar.
  // Si alguien vuelve a meter un requisito de documento acá, esta prueba cae.
  it('Coordinadora SIN cédula -> confirma igual (contraentrega no pide documento)', () => {
    expect(canConfirmOrder(baseInput)).toEqual({ canConfirm: true });
    // Y con el semáforo en rojo y sin override, tampoco bloquea por documento.
    const r = canConfirmOrder({ ...baseInput, validation_decision: 'red' });
    expect(r.canConfirm).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  it('el ÚNICO motivo de bloqueo posible es el teléfono', () => {
    // Barrido de todas las combinaciones de las entradas que quedan: ninguna
    // puede bloquear salvo telefonoValido=false.
    const decisiones = ['green', 'yellow', 'red', 'pickup_office', null] as const;
    for (const d of decisiones) {
      for (const isAdmin of [true, false]) {
        for (const overrideChecked of [true, false]) {
          const abierto = canConfirmOrder({ validation_decision: d, telefonoValido: true, isAdmin, overrideChecked });
          expect(abierto).toEqual({ canConfirm: true });

          const cerrado = canConfirmOrder({ validation_decision: d, telefonoValido: false, isAdmin, overrideChecked });
          expect(cerrado.canConfirm).toBe(false);
          expect(cerrado.reason).toMatch(/tel/i);
        }
      }
    }
  });
});

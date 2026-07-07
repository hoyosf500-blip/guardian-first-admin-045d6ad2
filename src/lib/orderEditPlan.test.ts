import { describe, it, expect } from 'vitest';
import { buildUpdatePlan, linesDirty, deriveTotal, roundMoneyClient, type EditFlags, type EditableLine } from './orderEditPlan';

const base: EditFlags = {
  clientDirty: false,
  carrierChanged: false,
  linesChanged: false,
  valorChanged: false,
  hasGuia: false,
  isManaged: false,
};

describe('buildUpdatePlan — matriz de pasos', () => {
  it('sin cambios → []', () => {
    expect(buildUpdatePlan(base)).toEqual([]);
  });

  it('solo datos del cliente → update_full', () => {
    expect(buildUpdatePlan({ ...base, clientDirty: true })).toEqual(['update_full']);
  });

  it('solo valor → apply_value (conserva el camino PUT que mantiene el ID)', () => {
    expect(buildUpdatePlan({ ...base, valorChanged: true })).toEqual(['apply_value']);
  });

  it('solo transportadora → apply_edit', () => {
    expect(buildUpdatePlan({ ...base, carrierChanged: true })).toEqual(['apply_edit']);
  });

  it('solo líneas (cantidad/precio) → apply_edit', () => {
    expect(buildUpdatePlan({ ...base, linesChanged: true })).toEqual(['apply_edit']);
  });

  it('transportadora + valor → UNA sola recreación (apply_edit, nunca apply_value encadenado)', () => {
    expect(buildUpdatePlan({ ...base, carrierChanged: true, valorChanged: true })).toEqual(['apply_edit']);
  });

  it('líneas + valor → apply_edit solo', () => {
    expect(buildUpdatePlan({ ...base, linesChanged: true, valorChanged: true })).toEqual(['apply_edit']);
  });

  it('datos + valor → update_full PRIMERO, después apply_value', () => {
    expect(buildUpdatePlan({ ...base, clientDirty: true, valorChanged: true }))
      .toEqual(['update_full', 'apply_value']);
  });

  it('datos + transportadora → update_full PRIMERO, después apply_edit', () => {
    expect(buildUpdatePlan({ ...base, clientDirty: true, carrierChanged: true }))
      .toEqual(['update_full', 'apply_edit']);
  });

  it('todo cambiado → update_full + apply_edit (el valor viaja dentro del apply_edit)', () => {
    expect(buildUpdatePlan({
      ...base, clientDirty: true, carrierChanged: true, linesChanged: true, valorChanged: true,
    })).toEqual(['update_full', 'apply_edit']);
  });

  it('con guía: solo datos del cliente, aunque haya otros flags', () => {
    expect(buildUpdatePlan({
      ...base, hasGuia: true, clientDirty: true, carrierChanged: true, valorChanged: true,
    })).toEqual(['update_full']);
  });

  it('con guía y sin datos → []', () => {
    expect(buildUpdatePlan({ ...base, hasGuia: true, carrierChanged: true, valorChanged: true }))
      .toEqual([]);
  });

  it('gestionado (result): mismo bloqueo que la guía', () => {
    expect(buildUpdatePlan({ ...base, isManaged: true, clientDirty: true, linesChanged: true }))
      .toEqual(['update_full']);
    expect(buildUpdatePlan({ ...base, isManaged: true, valorChanged: true })).toEqual([]);
  });
});

const q = (over: Partial<EditableLine> = {}): EditableLine =>
  ({ dropiId: 66215, quantity: 1, price: 29, ...over });

describe('linesDirty', () => {
  it('idénticas → false', () => {
    expect(linesDirty([q()], [q()])).toBe(false);
  });

  it('cambió cantidad → true', () => {
    expect(linesDirty([q()], [q({ quantity: 2 })])).toBe(true);
  });

  it('cambió precio → true', () => {
    expect(linesDirty([q()], [q({ price: 26.99 })])).toBe(true);
  });

  it('tolera ruido flotante en el precio (<0.001)', () => {
    expect(linesDirty([q({ price: 29 })], [q({ price: 29.0000001 })])).toBe(false);
  });

  it('distinto set de líneas → true', () => {
    expect(linesDirty([q()], [q({ dropiId: 99999 })])).toBe(true);
    expect(linesDirty([q()], [])).toBe(true);
  });
});

describe('deriveTotal + roundMoneyClient', () => {
  it('override válido manda sobre la suma', () => {
    expect(deriveTotal([q({ price: 29, quantity: 2 })], 50, 'EC')).toBe(50);
  });

  it('sin override: suma de líneas (EC con centavos)', () => {
    expect(deriveTotal([q({ price: 26.99, quantity: 2 })], null, 'EC')).toBe(53.98);
  });

  it('CO redondea a pesos enteros', () => {
    expect(deriveTotal([q({ price: 29950.5, quantity: 2 })], null, 'CO')).toBe(59901);
    expect(roundMoneyClient(59900.4, 'CO')).toBe(59900);
  });

  it('override inválido (0/negativo/NaN) se ignora', () => {
    expect(deriveTotal([q()], 0, 'EC')).toBe(29);
    expect(deriveTotal([q()], -5, 'EC')).toBe(29);
    expect(deriveTotal([q()], Number.NaN, 'EC')).toBe(29);
  });

  it('sin líneas ni override → fallback (valor actual del pedido)', () => {
    expect(deriveTotal(null, null, 'EC', 65)).toBe(65);
    expect(deriveTotal([], null, 'CO', 59900)).toBe(59900);
  });
});

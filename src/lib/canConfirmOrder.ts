// src/lib/canConfirmOrder.ts
export type ValidationDecision = 'green' | 'yellow' | 'red' | 'pickup_office';

export interface CanConfirmInput {
  validation_decision: ValidationDecision | null;
  telefonoValido: boolean;
  documentoSiCoordinadora: boolean;
  isAdmin: boolean;
  overrideChecked: boolean;
}

export interface CanConfirmResult {
  canConfirm: boolean;
  reason?: string;
}

export function canConfirmOrder(input: CanConfirmInput): CanConfirmResult {
  if (!input.telefonoValido) {
    return { canConfirm: false, reason: 'Teléfono inválido (debe iniciar en 3 y tener 10 dígitos)' };
  }
  if (!input.documentoSiCoordinadora) {
    return { canConfirm: false, reason: 'Coordinadora requiere cédula del destinatario' };
  }

  const decision = input.validation_decision;

  if (decision === 'green' || decision === 'pickup_office') return { canConfirm: true };

  if (decision === 'yellow') {
    if (input.overrideChecked) return { canConfirm: true };
    return { canConfirm: false, reason: 'Confirma con el cliente y marca el checkbox' };
  }

  if (decision === 'red') {
    if (input.isAdmin && input.overrideChecked) return { canConfirm: true };
    if (!input.isAdmin) return { canConfirm: false, reason: 'Dirección incompleta — solo admin puede forzar' };
    return { canConfirm: false, reason: 'Dirección incompleta — falta datos del cliente' };
  }

  // null/undefined: el validador todavía no opinó sobre esta dirección.
  // Backwards-compat: pedidos viejos que llegaron antes del feature
  // tienen validation_decision = null. NO los bloqueamos. El validador
  // solo bloquea cuando tiene evidencia explícita (red) o requiere
  // confirmación (yellow). null = "sin objeción, dejá pasar".
  return { canConfirm: true };
}

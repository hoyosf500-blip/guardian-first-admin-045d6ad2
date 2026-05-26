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
    return { canConfirm: false, reason: 'Teléfono inválido — revisá el número (CO: 3xx 10 díg · EC: 9xx 9 díg)' };
  }
  if (!input.documentoSiCoordinadora) {
    return { canConfirm: false, reason: 'Coordinadora requiere cédula del destinatario' };
  }

  // Gates de validación de dirección removidos a pedido (2026-05-26).
  // La operadora está al teléfono con el cliente y verifica verbalmente;
  // el semáforo ahora es solo informativo, NO bloquea el confirmar.
  // Quedan los gates duros: teléfono válido y cédula si es coordinadora.
  return { canConfirm: true };

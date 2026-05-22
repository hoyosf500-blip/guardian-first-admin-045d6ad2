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

  const decision = input.validation_decision;

  if (decision === 'green' || decision === 'pickup_office') return { canConfirm: true };

  if (decision === 'yellow') {
    if (input.overrideChecked) return { canConfirm: true };
    return { canConfirm: false, reason: 'Confirma con el cliente y marca el checkbox' };
  }

  if (decision === 'red') {
    // La operadora está al teléfono con el cliente y puede verificar la
    // dirección verbalmente. El validador es heurística + Google/Haiku — no
    // ground truth — y se sabe que falla en zonas rurales, barrios nuevos y
    // direcciones con complementos ambiguos (caso reportado: cliente puso
    // "18a19" y la IA no lo leyó). Antes solo admin podía destrabar RED, lo
    // que dejaba pedidos válidos imposibles de confirmar. Ahora cualquier
    // usuario puede marcar el override tras confirmar con el cliente; el
    // texto en AddressFeedbackCard es enfático para que la operadora sepa que
    // está asumiendo responsabilidad por el despacho.
    if (input.overrideChecked) return { canConfirm: true };
    return { canConfirm: false, reason: 'Dirección incompleta — verifica con el cliente y marca el checkbox' };
  }

  // null/undefined: el validador todavía no opinó sobre esta dirección.
  // Backwards-compat: pedidos viejos que llegaron antes del feature
  // tienen validation_decision = null. NO los bloqueamos. El validador
  // solo bloquea cuando tiene evidencia explícita (red) o requiere
  // confirmación (yellow). null = "sin objeción, dejá pasar".
  return { canConfirm: true };
}

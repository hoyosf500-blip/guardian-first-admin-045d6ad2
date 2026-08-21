// src/lib/canConfirmOrder.ts
export type ValidationDecision = 'green' | 'yellow' | 'red' | 'pickup_office';

export interface CanConfirmInput {
  validation_decision: ValidationDecision | null;
  telefonoValido: boolean;
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

  // Gates de validación de dirección removidos a pedido (2026-05-26).
  // La operadora está al teléfono con el cliente y verifica verbalmente;
  // el semáforo ahora es solo informativo, NO bloquea el confirmar.
  //
  // ⛔ CANDADO DE COORDINADORA REMOVIDO (2026-08-21) — era un candado SIN
  // CERRADURA. Exigía `orders.documento_destinatario` para cualquier pedido
  // cuya transportadora contuviera "coordinadora", pero:
  //   · NADA en todo el repo escribía esa columna (3 lecturas, 0 escrituras).
  //   · No existía ningún campo donde la asesora pudiera cargar la cédula.
  //   · El check corría ANTES de mirar `isAdmin`, así que nadie lo salteaba.
  // Un pedido que caía ahí quedaba IMPOSIBLE DE CONFIRMAR desde /confirmar, y
  // `CrmCallView` ni siquiera aplicaba el gate → la misma orden se comportaba
  // distinto según la pantalla.
  // Y de fondo la premisa era falsa: esto es CONTRAENTREGA. El cliente paga al
  // recibir; la transportadora no pide cédula para entregar. La regla nunca
  // debió existir (regla del dueño, 21-ago-2026).
  //
  // Queda UN solo gate duro: teléfono válido. Sin teléfono no hay entrega
  // posible ni forma de llamar al cliente.
  return { canConfirm: true };
}


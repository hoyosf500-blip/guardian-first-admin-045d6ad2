/**
 * Traduce los códigos `issues[]` de heuristicValidate (addressHeuristic.ts)
 * a los campos faltantes que entiende AddressFeedbackCard + buildWhatsAppMessage.
 *
 * Códigos REALES emitidos por addressHeuristic.ts:
 *   - 'no_via_type'    — falta tipo de vía (Calle/Carrera/Av/Diag/etc.)
 *   - 'no_numbers'     — falta el patrón #X-Y (placa)
 *   - 'too_short'      — dirección menor a 8 chars (basura, falta todo)
 *   - 'short_length'   — entre 8 y 12 chars (falta info de placa típicamente)
 *   - 'rural_address'  — detección rural-aware vía mapAddressKind
 *   - 'repeated_chars' — penalización por chars repetidos
 *   - 'no_letters'     — solo dígitos/símbolos
 *   - 'empty'          — string vacío (nunca se mapea, no llega aquí)
 */
const ISSUE_TO_FIELD_MAP: Record<string, string> = {
  no_via_type: 'placa',         // sin Calle/Carrera no hay placa concreta
  no_numbers: 'placa',          // sin #X-Y no hay placa
  too_short: 'placa',           // típicamente faltan placa+barrio
  short_length: 'placa',        // dirección corta — falta info de placa
  rural_address: 'complemento', // rural: pedir punto de referencia
  repeated_chars: 'placa',      // basura — pedir placa de nuevo
  no_letters: 'placa',          // solo números — falta tipo de vía + barrio
};

export function issuesToMissingFields(issues: string[]): string[] {
  const fields = new Set<string>();
  for (const issue of issues) {
    const field = ISSUE_TO_FIELD_MAP[issue];
    if (field) fields.add(field);
  }
  // Fallback: si hay issues pero ninguno se mapeó, agregar 'placa' como fallback genérico
  if (fields.size === 0 && issues.length > 0) fields.add('placa');
  return Array.from(fields);
}

// Heurística de validación de dirección colombiana — versión cliente.
//
// Port directo de `heuristicValidate` que vive en la edge function
// `supabase/functions/dropi-validate-address/index.ts`. Existen las dos
// para que el cliente pueda validar formato sin depender del backend
// (fallback local cuando la edge function no está desplegada o falla).
//
// IMPORTANTE: si cambia la heurística aquí, cambiarla también en la
// edge function — son la misma lógica intencionalmente duplicada.

export interface HeuristicResult {
  score: number;       // 0-100
  issues: string[];    // códigos como 'no_via_type', 'no_numbers', etc.
}

const VIA_TYPE_REGEX = new RegExp(
  '\\b(calle|cl|cll|carrera|cr|kr|cra|avenida|av|avda|diagonal|dg|diag|' +
  'transversal|tv|trv|manzana|mz|mza|circular|circ|autopista|autop)\\b',
  'i',
);
const NUMBERS_REGEX = /\d+[\s\-#]+\d+/;

export function heuristicValidate(direccion: string): HeuristicResult {
  const issues: string[] = [];
  let score = 0;
  const dir = (direccion || '').trim();

  if (!dir) {
    return { score: 0, issues: ['empty'] };
  }
  if (dir.length < 8) {
    issues.push('too_short');
    return { score: 10, issues };
  }

  if (VIA_TYPE_REGEX.test(dir)) {
    score += 40;
  } else {
    issues.push('no_via_type');
  }

  if (NUMBERS_REGEX.test(dir)) {
    score += 35;
  } else {
    issues.push('no_numbers');
  }

  if (dir.length >= 12) {
    score += 15;
  } else {
    issues.push('short_length');
  }

  // Bonus: referencias adicionales (barrio, casa, apto, local)
  if (/\b(barrio|brrio|brr|casa|cs|apto|apartamento|edificio|edif|torre|piso|interior|int|local|loc)\b/i.test(dir)) {
    score += 10;
  }

  // Penalizaciones
  if (/(.)\1{4,}/.test(dir)) {
    score = Math.max(0, score - 30);
    issues.push('repeated_chars');
  }
  if (/^[\d\s\-#]+$/.test(dir)) {
    score = Math.max(0, score - 30);
    issues.push('no_letters');
  }

  return { score: Math.min(100, score), issues };
}

/**
 * Decide el status final cuando solo tenemos heurística (sin geocoding).
 * Sin geocoding nunca devolvemos 'valid' porque no podemos confirmar que la
 * dirección existe — el mejor caso es 'suspicious' (formato OK, no verificada).
 */
export function decideStatusLocalOnly(score: number): 'suspicious' | 'invalid' {
  return score >= 60 ? 'suspicious' : 'invalid';
}

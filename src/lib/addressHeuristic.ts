// Heurística de validación de dirección colombiana — versión cliente.
//
// Port directo de `heuristicValidate` que vive en la edge function
// `supabase/functions/dropi-validate-address/index.ts`. Existen las dos
// para que el cliente pueda validar formato sin depender del backend
// (fallback local cuando la edge function no está desplegada o falla).
//
// IMPORTANTE: si cambia la heurística aquí, cambiarla también en la
// edge function — son la misma lógica intencionalmente duplicada.

import { mapAddressKind } from './mapAddressKind';

export type AddressKind = 'urban' | 'rural' | 'pickup_office' | 'unknown';

export interface HeuristicResult {
  score: number;       // 0-100
  issues: string[];    // códigos como 'no_via_type', 'no_numbers', etc.
  /** Tipo de dirección detectado por mapAddressKind. */
  address_kind?: AddressKind;
  /** Decisión semáforo cuando la heurística es concluyente (pickup/rural). */
  decision?: 'green' | 'yellow' | 'red';
  /** Campos faltantes detectados por la heurística (e.g. 'complemento'). */
  missing_fields?: string[];
  /** Mensaje sugerido para el cliente cuando la dirección es ambigua. */
  suggested_customer_message?: string;
  /** Marca que el resultado se decidió solo con heurística local. */
  localOnly?: boolean;
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

  // Detección rural-aware + pickup-office: cuando el tipo es concluyente,
  // resolvemos sin pasar por la lógica regex urbana.
  const kind = mapAddressKind(direccion);

  if (kind === 'pickup_office') {
    return {
      score: 100,
      issues: [],
      decision: 'green' as const,
      address_kind: 'pickup_office' as const,
      missing_fields: [],
      suggested_customer_message: '',
      localOnly: true,
    };
  }

  if (kind === 'rural') {
    return {
      score: 60,
      issues: ['rural_address'],
      decision: 'yellow' as const,
      address_kind: 'rural' as const,
      missing_fields: ['complemento'],
      suggested_customer_message: '',
      localOnly: true,
    };
  }

  if (!dir) {
    return { score: 0, issues: ['empty'], address_kind: kind };
  }
  if (dir.length < 8) {
    issues.push('too_short');
    return { score: 10, issues, address_kind: kind };
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

  return { score: Math.min(100, score), issues, address_kind: kind };
}

/**
 * Decide el status final cuando solo tenemos heurística (sin geocoding).
 * Sin geocoding nunca devolvemos 'valid' porque no podemos confirmar que la
 * dirección existe — el mejor caso es 'suspicious' (formato OK, no verificada).
 */
export function decideStatusLocalOnly(score: number): 'suspicious' | 'invalid' {
  return score >= 60 ? 'suspicious' : 'invalid';
}

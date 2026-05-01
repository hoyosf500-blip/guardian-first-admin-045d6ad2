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
  '\\b(?:calle|cl|cll|carrera|cr|kr|cra|avenida|av|avda|diagonal|dg|diag|' +
  'transversal|tv|trv|manzana|mz|mza|circular|circ|autopista|autop)\\d*\\b',
  'i',
);
const NUMBERS_REGEX = /\d+[\s\-#]+\d+/;
// Placa canónica colombiana: `# X-Y` o `X-Y` con guion (o em-dash) explícito.
// Bug A: una dirección sin esto no puede llegar a green; "Cll4 13 38" no es válido.
const CANONICAL_PLACA_REGEX = /#?\s*\d+[a-z]?\s*[-–]\s*\d+[a-z]?/i;

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

  // Normalizamos antes de aplicar regex de tipo de vía / referencias para que
  // typos comunes con tildes ("Callé", "Cárrera", "Avénida") matcheen igual.
  // Ver caso real: "Callé 21 # 10-78" — sin normalizar, el regex de tipo
  // de vía no matcheaba y la heurística marcaba `no_via_type` falso positivo.
  const normalized = dir.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  if (VIA_TYPE_REGEX.test(normalized)) {
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
  if (/\b(barrio|brrio|brr|casa|cs|apto|apartamento|edificio|edif|torre|piso|interior|int|local|loc)\b/i.test(normalized)) {
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

  // Bug A: capear score si NO hay placa canónica `# X-Y` con guion explícito.
  // Sin guion no podemos confirmar que es una dirección urbana real (puede ser
  // "Cll4 13 38 Apartamento." que parece dirección pero le falta la placa).
  // Score máx 65 → cae en yellow ("Confirmar con cliente").
  if (!CANONICAL_PLACA_REGEX.test(dir) && score > 65) {
    score = 65;
    if (!issues.includes('no_canonical_placa')) {
      issues.push('no_canonical_placa');
    }
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

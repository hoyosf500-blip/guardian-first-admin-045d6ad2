// Construye una sugerencia legible de cómo debería verse una dirección
// a partir del texto crudo + ciudad/departamento/barrio. Se usa en el
// badge yellow/red del validador para que la operadora sepa qué confirmar
// con el cliente, en vez de leer una lista abstracta de campos faltantes.
//
// IMPORTANTE: función pura, sin red. Se llama cliente-side cada render —
// no toca DB ni edge functions.

export interface AddressSuggestionInput {
  direccion: string;
  ciudad?: string | null;
  departamento?: string | null;
  barrio?: string | null;
}

export interface AddressSuggestionOutput {
  /** "Calle 21 # 10-78, Barrio el 12, Fonseca, La Guajira" o template con ___ */
  suggested: string;
  /** Lista de partes que faltan o están ambiguas, en lenguaje natural */
  missingParts: string[];
  /** True si la sugerencia tiene suficiente info útil para mostrar al usuario */
  hasEnoughInfo: boolean;
}

const VIA_MAP: Record<string, string> = {
  cl: 'Calle', calle: 'Calle',
  cr: 'Carrera', cra: 'Carrera', carrera: 'Carrera', kr: 'Carrera', kar: 'Carrera',
  av: 'Avenida', avenida: 'Avenida',
  dg: 'Diagonal', diagonal: 'Diagonal',
  tv: 'Transversal', transversal: 'Transversal',
  cq: 'Circular', circular: 'Circular',
  au: 'Autopista', autopista: 'Autopista',
};

// Captura: "calle 21", "cra 23", "av 50b", "diagonal 70a", "carrera 100".
// El `\d+[a-z]?` cubre números con sufijo letra (21A, 50B). El `bis` opcional
// cubre nomenclatura tipo "Calle 23 bis".
const VIA_REGEX = /\b(calle|cl|cra|cr|carrera|kr|kar|av|avenida|dg|diagonal|tv|transversal|cq|circular|au|autopista)\s*(\d+[a-z]?(?:\s*bis)?)\b/i;

// Captura "# 10-78", "#10 78", "10-78", "no 10-78", "n.10-78"
const PLACA_REGEX = /#?\s*(\d+[a-z]?)\s*-\s*(\d+[a-z]?)/i;

// "barrio X" — continúa hasta puntuación, próxima vía, o fin.
const BARRIO_REGEX = /\bbarrio\s+([\w\s]+?)(?:[,.]|\s+(?:cra|cl|calle|carrera|av|#|fonseca|\d+#)|$)/i;

const norm = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const capitalizar = (s: string): string =>
  s
    .trim()
    .split(/\s+/)
    .map((w) => (w.length > 0 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');

export function buildAddressSuggestion(
  input: AddressSuggestionInput,
): AddressSuggestionOutput {
  const dirNorm = norm(input.direccion || '');
  const parts: string[] = [];
  const missing: string[] = [];

  // 1. Tipo de vía + número
  const viaMatch = dirNorm.match(VIA_REGEX);
  if (viaMatch) {
    const tipo = VIA_MAP[viaMatch[1].toLowerCase()] ?? capitalizar(viaMatch[1]);
    parts.push(`${tipo} ${viaMatch[2]}`);
  } else {
    parts.push('[Calle/Carrera ___]');
    missing.push('tipo y número de vía (ej. Calle 21 o Carrera 50)');
  }

  // 2. Placa # X-Y
  const placaMatch = (input.direccion || '').match(PLACA_REGEX);
  if (placaMatch) {
    parts.push(`# ${placaMatch[1]}-${placaMatch[2]}`);
  } else {
    parts.push('# ___-___');
    missing.push('número de la casa con guion (ej. # 10-78)');
  }

  // 3. Barrio (param tiene prioridad sobre extraído del texto)
  const barrioFromText = input.direccion?.match(BARRIO_REGEX)?.[1]?.trim();
  const barrioFinal = (input.barrio && input.barrio.trim()) || barrioFromText;
  if (barrioFinal) parts.push(`Barrio ${capitalizar(barrioFinal)}`);
  // Barrio es opcional cuando ya hay calle+placa completas — no lo agregamos
  // a missing aquí.

  // 4. Ciudad y departamento
  if (input.ciudad && input.ciudad.trim()) parts.push(capitalizar(input.ciudad));
  if (input.departamento && input.departamento.trim()) parts.push(capitalizar(input.departamento));

  const suggested = parts.join(', ');
  const hasEnoughInfo = Boolean(viaMatch || placaMatch || barrioFinal);

  return { suggested, missingParts: missing, hasEnoughInfo };
}

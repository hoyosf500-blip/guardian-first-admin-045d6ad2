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

// Detector de placa más flexible. Cubre 4 formatos comunes:
//   1. Canónico:   "# 10-78", "#10 78", "10-78"   (con guion explícito)
//   2. Compacto:   "18a19", "52D336"               (letra entre dígitos, sin guion)
//   3. Espaciado:  "52 D 336"                      (letra rodeada de espacios)
//   4. Tras vía:   "Calle 75 A B Sur 52 D 336"     (placa después de sufijos de vía)
//
// El "compacto" exige LETRA en el primer número para no confundirse con casos
// como "Calle 21 22" donde son simplemente dos números pegados sin placa real.
function detectPlaca(direccion: string): { left: string; right: string } | null {
  // Normalizar: comprimir espacios.
  const norm = (direccion || '').replace(/\s+/g, ' ').trim();
  if (!norm) return null;

  // Prioridad 1: formato canónico con guion (acepta tanto - como – em-dash).
  // "# X-Y", "#X-Y", "X-Y" donde X y Y son N+letra opcional.
  const canonical = norm.match(/#?\s*(\d{1,3}[a-z]?)\s*[-–]\s*(\d{1,3}[a-z]?)/i);
  if (canonical) return { left: canonical[1], right: canonical[2] };

  // Prioridad 2: compacto "X-letra-Y" donde el primer número TIENE letra glued.
  // Ejemplos válidos: "18a19", "52D336", "# 23A45".
  // Ejemplos INválidos: "Calle 21 22" (números pegados sin letra).
  const compact = norm.match(/(?:^|\s|#)(\d{1,3}[a-z])\s*(\d{1,3})(?=\s|$|,|-|\.)/i);
  if (compact) return { left: compact[1], right: compact[2] };

  // Prioridad 3: espaciado "X letra Y" — letra única rodeada de espacios.
  // Ejemplos válidos: "52 D 336", "100 A 25". El boundary y la letra aislada
  // son señal fuerte de placa (no se confunde con "Calle 21 22" donde no hay
  // letra entre los dígitos).
  const spaced = norm.match(/(?:^|\s|#)(\d{1,3})\s+([a-z])\s+(\d{1,3})(?=\s|$|,|-|\.)/i);
  if (spaced) return { left: `${spaced[1]}${spaced[2]}`, right: spaced[3] };

  return null;
}

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

  // 2. Placa # X-Y — usa detectPlaca con múltiples regex priorizadas:
  //    canónico (10-78), compacto (18a19), espaciado (52 D 336).
  const placa = detectPlaca(input.direccion || '');
  if (placa) {
    parts.push(`# ${placa.left.toUpperCase()}-${placa.right.toUpperCase()}`);
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
  const hasEnoughInfo = Boolean(viaMatch || placa || barrioFinal);

  return { suggested, missingParts: missing, hasEnoughInfo };
}

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
  /** Solo partes confirmadas (sin placeholders ___). Ej:
   *  "Calle 21 # 10-78, Barrio el 12, Fonseca, La Guajira"
   *  "Calle 7A en Tumaco, Nariño" (cuando falta placa) */
  suggested: string;
  /** Nota legible para la operadora describiendo qué falta confirmar.
   *  Null si la sugerencia está completa (no falta nada). */
  missingNote: string | null;
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

// Detección de complementos colombianos comunes (apto, torre, manzana, etc.).
// Captura el TIPO + NÚMERO. Se aplica después de placa, antes de barrio.
export interface DetectedComplemento {
  tipo: 'Apto' | 'Torre' | 'Bloque' | 'Manzana' | 'Casa' | 'Interior' | 'Lote';
  numero: string;
}

const COMPLEMENTO_PATTERNS: Array<[RegExp, DetectedComplemento['tipo']]> = [
  [/\b(?:apto|apartamento|apt|ap)\.?\s*(\d+[a-z]?)/i, 'Apto'],
  [/\b(?:torre|tor)\.?\s*(\d+[a-z]?)/i, 'Torre'],
  [/\b(?:bloque|bl)\.?\s*(\d+[a-z]?)/i, 'Bloque'],
  [/\b(?:manzana|mzana|mz)\.?\s*(\d+[a-z]?|[a-z])\b/i, 'Manzana'],
  [/\b(?:casa|cs)\.?\s*(\d+[a-z]?)/i, 'Casa'],
  [/\b(?:interior|int)\.?\s*(\d+[a-z]?)/i, 'Interior'],
  [/\b(?:lote|lt)\.?\s*(\d+[a-z]?)/i, 'Lote'],
];

function detectComplementos(direccion: string): DetectedComplemento[] {
  if (!direccion) return [];
  const found: DetectedComplemento[] = [];
  const seen = new Set<DetectedComplemento['tipo']>();
  for (const [pattern, tipo] of COMPLEMENTO_PATTERNS) {
    if (seen.has(tipo)) continue;
    const m = direccion.match(pattern);
    if (m && m[1]) {
      found.push({ tipo, numero: m[1].toUpperCase() });
      seen.add(tipo);
    }
  }
  return found;
}

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
  const confirmedParts: string[] = [];
  const missingNotes: string[] = [];

  // 1. Tipo de vía + número
  const viaMatch = dirNorm.match(VIA_REGEX);
  let viaPart: string | null = null;
  if (viaMatch) {
    const tipo = VIA_MAP[viaMatch[1].toLowerCase()] ?? capitalizar(viaMatch[1]);
    viaPart = `${tipo} ${viaMatch[2]}`;
    confirmedParts.push(viaPart);
  } else {
    missingNotes.push('confirma si la vía es Calle, Carrera o Avenida');
  }

  // 2. Placa # X-Y — usa detectPlaca con múltiples regex priorizadas:
  //    canónico (10-78), compacto (18a19), espaciado (52 D 336).
  const placa = detectPlaca(input.direccion || '');
  if (placa) {
    confirmedParts.push(`# ${placa.left.toUpperCase()}-${placa.right.toUpperCase()}`);
  } else {
    missingNotes.push('pídele al cliente el número exacto de la casa con guion (ej. 23-45)');
  }

  // 3. Complementos (apto, torre, manzana, etc.) — van DESPUÉS de la placa.
  const complementos = detectComplementos(input.direccion || '');
  for (const c of complementos) {
    confirmedParts.push(`${c.tipo} ${c.numero}`);
  }

  // 4. Barrio (param tiene prioridad sobre extraído del texto)
  const barrioFromText = input.direccion?.match(BARRIO_REGEX)?.[1]?.trim();
  const barrioFinal = (input.barrio && input.barrio.trim()) || barrioFromText;
  if (barrioFinal) confirmedParts.push(`Barrio ${capitalizar(barrioFinal)}`);
  // Barrio es opcional cuando ya hay calle+placa completas — no lo agregamos
  // a missing aquí.

  // 5. Ciudad y departamento
  if (input.ciudad && input.ciudad.trim()) confirmedParts.push(capitalizar(input.ciudad));
  if (input.departamento && input.departamento.trim()) confirmedParts.push(capitalizar(input.departamento));

  // Construir suggested SIN placeholders ___.
  // Caso especial: si tenemos vía pero NO placa, usar preposición "en" entre
  // la vía y el resto de partes confirmadas (más natural):
  //   "Calle 7A en Tumaco, Nariño" en lugar de "Calle 7A, Tumaco, Nariño".
  let suggested: string;
  if (viaPart && !placa) {
    const restoSinVia = confirmedParts.slice(1).join(', ');
    suggested = restoSinVia ? `${viaPart} en ${restoSinVia}` : viaPart;
  } else {
    suggested = confirmedParts.join(', ');
  }

  const missingNote = missingNotes.length > 0
    ? `Falta confirmar: ${missingNotes.join('; ')}.`
    : null;

  const hasEnoughInfo = confirmedParts.length > 0;

  return { suggested, missingNote, hasEnoughInfo };
}

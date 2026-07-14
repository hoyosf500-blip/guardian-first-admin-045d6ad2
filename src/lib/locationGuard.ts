// Guard anti-alucinación: valida que un texto de sugerencia (de Google,
// Haiku, edge function, o cualquier fuente externa) sea consistente con
// la ubicación del pedido. Regla:
//
//   - Si el pedido tiene ciudad: la sugerencia DEBE contener esa ciudad.
//     No basta con que coincida solo el departamento. Ej. pedido en Pitalito
//     (Huila) NO acepta sugerencia "Neiva, Huila" — son ciudades distintas
//     a 200 km, despachar ahí entrega al cliente equivocado.
//
//   - Si el pedido solo tiene departamento (raro, pero sucede en Excel
//     parciales): la sugerencia DEBE contener el departamento.
//
//   - Si el pedido no tiene ni ciudad ni departamento (caso degenerado):
//     no podemos validar — aceptamos.
//
// Comparación case+accent-insensitive vía NFD normalize.

/** Normaliza string para comparación case+accent-insensitive. */
function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * ¿`haystack` contiene `needle` como palabra completa? Usa límite de palabra
 * (\b) en vez de includes crudo para que una ciudad corta que es substring
 * de otra distinta NO pase el guard (ej. "Baba" dentro de "Babahoyo", o
 * "Cali" dentro de "Calima"). Ambos strings ya vienen normalizados (NFD sin
 * acentos, lowercase), así que \b opera sobre ascii.
 */
function containsWord(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(haystack);
}

/**
 * Verifica que el `text` (description, formattedAddress, etc.) coincida con
 * la ubicación del pedido. Estricto: la ciudad tiene prioridad y NO se
 * compensa con coincidencia de departamento.
 */
export function locationMatches(
  text: string,
  ciudad?: string | null,
  departamento?: string | null,
): boolean {
  if (!text) return false;
  const t = normalize(text);

  const c = ciudad ? normalize(ciudad) : '';
  const d = departamento ? normalize(departamento) : '';

  // Si tenemos ciudad usable (>=3 chars), exigirla. No aceptar match
  // solo por departamento — Neiva y Pitalito están ambos en Huila.
  if (c.length >= 3) {
    return containsWord(t, c);
  }

  // Sin ciudad útil: caer al departamento si está.
  if (d.length >= 3) {
    return containsWord(t, d);
  }

  // Sin info: no podemos validar — aceptar.
  return true;
}

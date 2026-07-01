/**
 * Búsqueda de texto simple y tolerante para listas del CRM (pendientes,
 * seguimiento). Sin acentos (NFD) para que "jose"/"bogota" matcheen
 * "José"/"Bogotá" — sirve CO y EC. Sin red, testeable.
 */

// Marcas diacríticas combinantes U+0300–U+036F (los acentos que NFD separa).
const DIACRITICS = /[̀-ͯ]/g;

/** Minúsculas, sin acentos, sin espacios de sobra. */
export function normalizeSearch(s: string): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .toLowerCase()
    .trim();
}

/**
 * ¿Los datos del item (partes) matchean la query? Cada token de la query (por
 * espacios) debe aparecer en alguna parte (AND de tokens). Query vacía => true.
 * Ej: matchesQuery(['José Pérez','3001112222','Bogotá'], 'jose bogota') === true
 */
export function matchesQuery(parts: Array<string | number | null | undefined>, query: string): boolean {
  const q = normalizeSearch(query);
  if (!q) return true;
  const hay = parts.map(p => normalizeSearch(String(p ?? ''))).join(' ');
  return q.split(/\s+/).every(tok => hay.includes(tok));
}

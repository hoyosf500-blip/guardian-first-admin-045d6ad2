/**
 * Búsqueda de texto simple y tolerante para listas del CRM (pendientes,
 * seguimiento). Sin acentos (NFD) para que "jose"/"bogota" matcheen
 * "José"/"Bogotá" — sirve CO y EC. Sin red, testeable.
 */

import { pareceTelefono, variantesDeBusqueda } from './busquedaTelefono';

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
  return q.split(/\s+/).every(tok => hay.includes(tok) || matcheaComoTelefono(hay, tok));
}

/**
 * Segunda oportunidad SOLO para los tokens que parecen un teléfono: se vuelve a
 * probar con la forma canónica (sin +593/+57 y sin el cero inicial).
 *
 * ── Por qué (el mismo caso que ya costó un cliente) ────────────────────────
 * Un ecuatoriano escribe su número `0986255535`. En la base está guardado
 * `986255535` — el censo de 12.000 pedidos de Ecuador dice que 11.988 están en
 * 9 dígitos limpios y NINGUNO con cero inicial. La comparación por subcadena es
 * asimétrica: `'986255535'.includes('0986255535')` es **false**, aunque al revés
 * sí funcione. Copiar el número del chat y pegarlo en el buscador no devolvía
 * nada, con el pedido ahí.
 *
 * Eso ya se arregló el 4-sep en la búsqueda del SERVIDOR
 * (`useOrderSearch` + `variantesDeBusqueda`) — pero el filtro que corre en el
 * navegador sobre lo ya descargado, que es el que responde primero y el que la
 * asesora ve moverse mientras teclea, se quedó con la comparación cruda. La
 * mitad del arreglo.
 *
 * Se prueba la canónica ADEMÁS de la cruda, nunca en su lugar: lo que hoy
 * encuentra se sigue encontrando igual. Y solo entra si el token parece un
 * teléfono, así que un nombre o una guía siguen comparándose como siempre.
 */
function matcheaComoTelefono(hay: string, token: string): boolean {
  if (!pareceTelefono(token)) return false;
  return variantesDeBusqueda(token)
    .map(normalizeSearch)
    .some(v => v !== token && v.length > 0 && hay.includes(v));
}

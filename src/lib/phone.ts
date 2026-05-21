// Normaliza un teléfono a sus últimos 9 dígitos, para emparejar el mismo
// cliente entre sistemas distintos (Shopify vs Dropi) sin que rompan el
// prefijo de país, el 0 inicial, espacios o guiones.
//
//   "+593 99 123 4567" → "991234567"
//   "0991234567"       → "991234567"
//   "(593) 991234567"  → "991234567"
//
// 9 dígitos es el largo del número significativo en EC/CO (móvil sin prefijo).
// Como el emparejado es SIEMPRE dentro de la misma tienda/país, lo que importa
// es la consistencia, no la exactitud del prefijo.
export function normalizePhone(p: string | null | undefined): string {
  const digits = String(p ?? '').replace(/\D/g, '');
  return digits.slice(-9);
}

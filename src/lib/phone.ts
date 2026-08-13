// Normaliza un teléfono para emparejar el mismo cliente entre sistemas distintos
// (Shopify vs Dropi) sin que rompan el prefijo de país, el 0 inicial, espacios o
// guiones.
//
//   "+593 99 123 4567" → "991234567"   (EC, 9 díg.)
//   "0991234567"       → "991234567"
//   "+502 3123 4567"   → "31234567"    (GT, 8 díg.)
//   "50231234567"      → "31234567"
//
// El emparejado es SIEMPRE dentro de la misma tienda/país, así que lo que importa
// es la CONSISTENCIA. Antes se tomaban los últimos 9 dígitos a secas: alcanza para
// CO (móvil 10) y EC (9), pero ROMPE Guatemala — el móvil GT tiene 8 dígitos, y
// "50231234567" (con prefijo 502) vs "31234567" (sin él) daban claves distintas
// para el mismo cliente, rompiendo useDuplicatePhones / historial de comprador.
// Fix: quitar primero el código de país si viene pegado (57 CO / 593 EC / 502 GT),
// y recién ahí tomar los últimos 9. CO y EC quedan byte-idénticos (sus números
// pelados no empiezan con esos prefijos, y con prefijo el resultado no cambia).
export function normalizePhone(p: string | null | undefined): string {
  let digits = String(p ?? '').replace(/\D/g, '');
  // Solo se quita el prefijo si al hacerlo queda un largo de móvil plausible
  // (8–10), para no mutilar un número que casualmente arranque con esos dígitos.
  for (const cc of ['593', '502', '57']) {
    const resto = digits.length - cc.length;
    if (digits.startsWith(cc) && resto >= 8 && resto <= 10) {
      digits = digits.slice(cc.length);
      break;
    }
  }
  return digits.slice(-9);
}

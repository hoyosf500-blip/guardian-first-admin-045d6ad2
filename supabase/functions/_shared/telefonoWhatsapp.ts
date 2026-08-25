// telefonoWhatsapp — un teléfono, un país, un número al que WhatsApp entrega.
//
// Vivía dentro de `src/lib/orderUtils.ts` y desde el 25-ago-2026 vive acá,
// SIN cambiarle una línea al cuerpo de las funciones: el servidor también
// necesita armar el destinatario (`to`) cuando manda una plantilla aprobada
// fuera de la ventana de 24 h, y una segunda copia en la edge function se
// desincroniza sola — con la consecuencia de que el mensaje le llegaría a otro
// número, o a ninguno, sin que nadie se entere.
//
// `orderUtils.ts` lo RE-EXPORTA, así que las ~40 pantallas que importan
// `getWhatsAppPhone` desde ahí siguen igual y sus pruebas también.
//
// Mismo patrón que `ventanaWhatsapp` y `conversacion`: lógica pura en
// `_shared`, consumida desde `src/` cruzando el límite.

/**
 * Normaliza un teléfono colombiano a su forma canónica (10 dígitos arrancando
 * con 3, sin código de país). Acepta variaciones comunes que el cliente puede
 * tipear:
 *   "3229372886"           → "3229372886"  (canónico)
 *   "573229372886"         → "3229372886"  (con prefijo 57)
 *   "+57 322 937 2886"     → "3229372886"  (espacios y +)
 *   "57 (322) 937-2886"    → "3229372886"  (paréntesis y guion)
 * Devuelve null si no encaja en ninguna de las dos formas válidas:
 * 10 dígitos arrancando con 3, o 12 dígitos arrancando con "57" + 3.
 *
 * Reportado 2026-05-05: cliente Cristian Mendez escribió "573229372886" en
 * Shopify y `validarTelefono` lo rechazaba (length !== 10), bloqueando la
 * confirmación. Antes esto vivía como regex inline en CallView.tsx; ahora
 * está acá para reuso (CallView gate + EditOrderDialog).
 */
export function normalizeColombianPhone(phone: string): string | null {
  const clean = (phone || '').replace(/\D/g, '');
  if (clean.length === 10 && clean.startsWith('3')) return clean;
  if (clean.length === 12 && clean.startsWith('57') && clean[2] === '3') {
    return clean.slice(2);
  }
  return null;
}

/** Devuelve true si el teléfono se puede normalizar a un móvil COL válido. */
export function isValidColombianPhone(phone: string): boolean {
  return normalizeColombianPhone(phone) !== null;
}

/**
 * Normaliza un móvil ecuatoriano a su forma canónica de 9 dígitos arrancando
 * en 9 (sin trunk 0 ni código de país). Acepta:
 *   "983364222"        → "983364222"  (canónico, como lo guarda Dropi EC)
 *   "0983364222"       → "983364222"  (con trunk 0)
 *   "593983364222"     → "983364222"  (código país)
 *   "+593 98 336 4222" → "983364222"  (con + y espacios)
 * Devuelve null si no encaja.
 */
export function normalizeEcuadorianPhone(phone: string): string | null {
  let d = (phone || '').replace(/\D/g, '');
  if (d.startsWith('593')) d = d.slice(3);
  if (d.length === 10 && d.startsWith('0')) d = d.slice(1);
  return d.length === 9 && d.startsWith('9') ? d : null;
}

/** Validez de móvil ecuatoriano. */
export function isValidEcuadorianPhone(phone: string): boolean {
  return normalizeEcuadorianPhone(phone) !== null;
}

/**
 * Normaliza un móvil guatemalteco a sus 8 dígitos canónicos (sin el 502).
 * Los móviles de Guatemala arrancan en 3, 4 o 5 y no llevan trunk 0.
 *   "50231234567" no existe: el país usa 8 dígitos, no 10.
 *   "31234567"      → "31234567"
 *   "+502 4123 4567" → "41234567"
 */
export function normalizeGuatemalanPhone(phone: string): string | null {
  let d = (phone || '').replace(/\D/g, '');
  if (d.length > 8 && d.startsWith('502')) d = d.slice(3);
  return d.length === 8 && /^[345]/.test(d) ? d : null;
}

/** Validez de móvil guatemalteco. */
export function isValidGuatemalanPhone(phone: string): boolean {
  return normalizeGuatemalanPhone(phone) !== null;
}

/** Normaliza según el país de la tienda (default CO). */
export function normalizePhoneForCountry(phone: string, countryCode?: string | null): string | null {
  const cc = (countryCode || 'CO').toUpperCase();
  if (cc === 'EC') return normalizeEcuadorianPhone(phone);
  if (cc === 'GT') return normalizeGuatemalanPhone(phone);
  return normalizeColombianPhone(phone);
}

/** Validez de móvil según el país de la tienda (default CO). */
export function isValidPhoneForCountry(phone: string, countryCode?: string | null): boolean {
  return normalizePhoneForCountry(phone, countryCode) !== null;
}

/** Normalize a phone for wa.me/ links (country code prefix exactly once).
 *  countryCode de la tienda activa: 'EC' usa 593, 'GT' usa 502, default 'CO' 57. */
export function getWhatsAppPhone(phone: string, countryCode?: string | null): string {
  if ((countryCode || 'CO').toUpperCase() === 'GT') {
    const n = normalizeGuatemalanPhone(phone);
    if (n) return `502${n}`;
    const d = phone.replace(/[^0-9]/g, '');
    return d.startsWith('502') ? d : `502${d}`;
  }
  if ((countryCode || 'CO').toUpperCase() === 'EC') {
    const n = normalizeEcuadorianPhone(phone);
    if (n) return `593${n}`;
    const d = phone.replace(/[^0-9]/g, '');
    if (d.startsWith('593')) return d;
    return `593${d.replace(/^0/, '')}`;
  }
  const digits = phone.replace(/[^0-9]/g, '');
  // 10-digit Colombian mobile (3xx xxx xxxx) → always prepend 57.
  if (digits.length === 10) return `57${digits}`;
  // 12-digit already has country code (57 + 10 digits) → use as-is.
  if (digits.length === 12 && digits.startsWith('57')) return digits;
  // Anything else: strip a leading 57 if present and re-prepend to normalize.
  if (digits.startsWith('57') && digits.length > 10) return digits;
  return `57${digits}`;
}

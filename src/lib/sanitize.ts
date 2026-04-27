/**
 * Input sanitization for user-facing text fields (notes, touchpoints, etc.).
 * Prevents XSS via stored content and enforces length limits.
 */

/** Strip HTML tags and normalize whitespace. */
export function sanitizeText(input: string): string {
  return input
    .replace(/<[^>]*>/g, '')   // strip HTML tags
    .replace(/&[a-z]+;/gi, '') // strip HTML entities
    .replace(/\s+/g, ' ')     // collapse whitespace
    .trim();
}

/** Sanitize and enforce a max length. Returns the cleaned string. */
export function sanitizeNote(input: string, maxLength = 500): string {
  const clean = sanitizeText(input);
  return clean.slice(0, maxLength);
}

/** Sanitize a touchpoint action string. */
export function sanitizeAction(input: string, maxLength = 200): string {
  return sanitizeText(input).slice(0, maxLength);
}

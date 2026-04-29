// src/lib/addressNormalize.ts
/** Normaliza dirección para usar como cache key. Idempotente. */
export function addressNormalize(input: string): string {
  if (!input) return '';
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

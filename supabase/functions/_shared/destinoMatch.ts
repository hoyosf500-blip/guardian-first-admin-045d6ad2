// ¿Dos nombres de lugar se refieren al mismo sitio?
//
// GEMELO de `src/lib/destinoCotizado.ts` (misma regla, mismos casos). Son dos
// archivos porque las edge functions son Deno y no pueden importar de `src/`.
// Si cambia el criterio, cambiarlo en LOS DOS — el CRM avisa "la cotización es
// de otra ciudad" con esta regla y el backend decide "la ciudad no se aplicó"
// con esta misma; si divergen, la pantalla y el servidor se contradicen.
//
// La comparación NO puede ser estricta: el nombre que devuelve Dropi sale de SU
// catálogo y casi nunca coincide letra por letra con lo que escribió la
// operadora ("QUITO DC" vs "QUITO", "SANTO DOMINGO DE LOS COLORADOS" vs "SANTO
// DOMINGO"). Un falso positivo acá bloquea una edición legítima.

/** Mayúsculas, sin tildes ni puntuación, espacios colapsados. */
export function normDestino(s: unknown): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * `true` si los dos nombres son razonablemente el mismo lugar.
 *
 * Se aceptan como iguales cuando uno es prefijo del otro con al menos 4
 * caracteres — el MISMO criterio que `deptPrefixMatch` de `dropiCityCatalog.ts`.
 * El mínimo de 4 evita que "SAN" empareje con media Ecuador.
 *
 * Si falta cualquiera de los dos devuelve `true`: sin dato no se puede AFIRMAR
 * que haya diferencia, y este resultado se usa para bloquear/alarmar.
 */
export function mismoDestino(a: unknown, b: unknown): boolean {
  const x = normDestino(a);
  const y = normDestino(b);
  if (!x || !y) return true;
  if (x === y) return true;
  return x.length >= 4 && y.length >= 4 && (x.startsWith(y) || y.startsWith(x));
}

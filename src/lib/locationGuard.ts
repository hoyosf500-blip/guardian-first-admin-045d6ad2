// Guard anti-alucinación: valida que un texto de sugerencia (de Google,
// Haiku, edge function, o cualquier fuente externa) contenga la ciudad O
// el departamento del pedido. Si no coincide, descartamos la sugerencia
// para no exponer al cliente a un despacho equivocado.

/** Normaliza string para comparación case+accent-insensitive. */
function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Verifica que el `text` (description, formattedAddress, etc.) contenga la
 * ciudad O el departamento del pedido. Si NO contiene ninguno, es probable
 * alucinación y debemos descartarlo.
 */
export function locationMatches(
  text: string,
  ciudad?: string | null,
  departamento?: string | null,
): boolean {
  if (!text) return false;
  if (!ciudad && !departamento) return true; // sin info, no podemos validar — aceptar
  const t = normalize(text);
  if (ciudad) {
    const c = normalize(ciudad);
    if (c.length >= 3 && t.includes(c)) return true;
  }
  if (departamento) {
    const d = normalize(departamento);
    if (d.length >= 3 && t.includes(d)) return true;
  }
  return false;
}

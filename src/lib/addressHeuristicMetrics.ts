// Registro mínimo de analítica del semáforo de direcciones, por país.
//
// PARA QUÉ: Guatemala entra por la rama colombiana de `addressHeuristic` y
// Ecuador por la suya. Un cambio de regex que "mejora" CO puede mandar a rojo
// direcciones válidas de GT o EC sin que nadie lo note hasta que una asesora
// discute con un cliente. Este contador da una foto barata de la distribución
// verde/amarillo/rojo por país, usable tanto en CI (assert sobre el snapshot)
// como en producción (leer el snapshot desde la consola del navegador).
//
// Es en memoria y sin red a propósito: cero costo, cero datos personales (NO
// se guarda la dirección, solo el país y el color).

export type SemaforoDireccion = 'green' | 'yellow' | 'red';

export interface ConteoSemaforo {
  green: number;
  yellow: number;
  red: number;
  total: number;
}

/** Umbrales del semáforo — los mismos que usa `useAddressValidation`. */
export const UMBRAL_VERDE = 80;
export const UMBRAL_ROJO = 50;

/** Traduce score (y decisión concluyente, si la hay) al color del semáforo. */
export function semaforoDesdeResultado(r: {
  score: number;
  decision?: SemaforoDireccion;
}): SemaforoDireccion {
  if (r.decision) return r.decision;
  if (r.score >= UMBRAL_VERDE) return 'green';
  if (r.score >= UMBRAL_ROJO) return 'yellow';
  return 'red';
}

const conteos = new Map<string, ConteoSemaforo>();

function normalizarPais(countryCode?: string): string {
  const c = (countryCode || 'CO').trim().toUpperCase();
  return c || 'CO';
}

/** Suma una evaluación al contador del país. No lanza nunca. */
export function registrarResultadoHeuristica(
  countryCode: string | undefined,
  resultado: { score: number; decision?: SemaforoDireccion },
): void {
  try {
    const pais = normalizarPais(countryCode);
    const color = semaforoDesdeResultado(resultado);
    const actual = conteos.get(pais) || { green: 0, yellow: 0, red: 0, total: 0 };
    actual[color] += 1;
    actual.total += 1;
    conteos.set(pais, actual);
  } catch {
    /* la analítica nunca puede romper una validación */
  }
}

/** Foto inmutable de los contadores: `{ CO: {green, yellow, red, total}, ... }`. */
export function snapshotHeuristica(): Record<string, ConteoSemaforo> {
  const out: Record<string, ConteoSemaforo> = {};
  for (const [pais, c] of conteos) out[pais] = { ...c };
  return out;
}

/** Porcentaje de rojos de un país (0 cuando no hay datos). Útil para asserts. */
export function tasaRojo(countryCode: string): number {
  const c = conteos.get(normalizarPais(countryCode));
  if (!c || c.total === 0) return 0;
  return c.red / c.total;
}

/** Reinicia los contadores (tests y sesiones nuevas). */
export function resetHeuristicaMetrics(): void {
  conteos.clear();
}

// Acceso desde la consola del navegador en producción, sin exponer nada más.
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__semaforoDirecciones = snapshotHeuristica;
}

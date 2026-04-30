// Catálogo DANE DIVIPOLA: 33 departamentos × 1.121 municipios.
// Generado a partir del package npm `divipola` (códigos DANE oficiales).
// Si Dropi rechaza un valor por mismatch de normalización, reportar
// para añadir un override puntual — la lista en sí es autoritativa.

import dane from './dane-divipola.json';

export interface DivipolaEntry {
  departamento: string;
  ciudad: string;
  codigo_dane: string;
}

const ENTRIES = dane as DivipolaEntry[];

export function getDepartamentos(): string[] {
  const set = new Set(ENTRIES.map((e) => e.departamento));
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'es'));
}

export function getCiudadesDe(departamento: string): string[] {
  const target = (departamento || '').toLowerCase();
  return ENTRIES
    .filter((e) => e.departamento.toLowerCase() === target)
    .map((e) => e.ciudad)
    .sort((a, b) => a.localeCompare(b, 'es'));
}

export function getDaneCode(departamento: string, ciudad: string): string | null {
  const dept = (departamento || '').toLowerCase();
  const city = (ciudad || '').toLowerCase();
  const match = ENTRIES.find(
    (e) => e.departamento.toLowerCase() === dept && e.ciudad.toLowerCase() === city,
  );
  return match ? match.codigo_dane : null;
}

// Lista plana de departamentos. Mantenida para compatibilidad con
// consumers existentes (e.g. EditOrderDialog.tsx) que la importaban
// del catálogo estático anterior.
export const DEPARTAMENTOS_NOMBRES: string[] = getDepartamentos();

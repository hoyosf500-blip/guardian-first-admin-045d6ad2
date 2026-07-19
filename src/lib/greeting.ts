/**
 * Saludo por franja horaria + primer nombre.
 *
 * Vivía inline en DashboardTab y ahora lo comparte con la pantalla de
 * bienvenida: dos saludos con reglas distintas (uno diciendo "Buenas tardes" y
 * el otro "Buenos días" con minutos de diferencia) se ve como un error.
 *
 * Solo el PRIMER nombre a propósito: "Buenos días, María Fernanda Ríos" no entra
 * en el header y el apellido no aporta nada acá.
 */
export function greetingFor(displayName?: string | null, now: Date = new Date()): string {
  const h = now.getHours();
  const franja = h < 12 ? 'Buenos días' : h < 18 ? 'Buenas tardes' : 'Buenas noches';
  const nombre = (displayName || '').trim().split(/\s+/)[0];
  return nombre ? `${franja}, ${nombre}` : franja;
}

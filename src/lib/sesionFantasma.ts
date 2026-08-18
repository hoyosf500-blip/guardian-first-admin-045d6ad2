/**
 * Sesión fantasma: el navegador guarda un token de un usuario que YA NO EXISTE
 * en la base (cuenta borrada mientras la pestaña seguía abierta).
 *
 * Se detecta al crear la tienda: `stores.created_by` referencia `auth.users`, así
 * que la RPC muere con una violación de llave foránea. Sin este chequeo el dueño
 * ve "Creá tu tienda" con un error críptico de Postgres y ningún camino de salida
 * — la única cura real es cerrar sesión y volver a registrarse.
 */
export function esSesionFantasma(motivo: string | undefined | null): boolean {
  const m = String(motivo ?? '').toLowerCase();
  return (
    m.includes('stores_created_by_fkey') ||
    (m.includes('foreign key') && m.includes('stores')) ||
    m.includes('llave foránea')
  );
}

export const MENSAJE_SESION_FANTASMA =
  'Tu sesión ya no es válida (la cuenta fue borrada). Te cerramos la sesión: registrate de nuevo y listo.';

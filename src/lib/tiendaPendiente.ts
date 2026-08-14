import { normalizarPais, validarNombreTienda, type PaisTienda } from '@/lib/onboardingValidacion';

/**
 * El nombre y el país que el dueño escribió AL REGISTRARSE, guardados hasta que
 * vuelve del correo de confirmación.
 *
 * Por qué hace falta un puente: con la confirmación por correo activada, al
 * apretar "Crear cuenta" todavía NO hay sesión, así que la tienda no se puede
 * crear en ese momento. El dato tiene que esperar al primer ingreso.
 *
 * Vive en localStorage y por eso es una PISTA, no una promesa: si confirma el
 * correo en el teléfono y entra desde la computadora, no va a estar. Quien lo
 * lee tiene que tener siempre lista la pantalla de crear tienda como respaldo.
 */
export interface TiendaPendiente {
  nombre: string;
  pais: PaisTienda;
}

const CLAVE = 'guardian.tiendaPendiente';

export function guardarTiendaPendiente(t: TiendaPendiente): void {
  try { localStorage.setItem(CLAVE, JSON.stringify(t)); } catch { /* sin storage: cae al formulario */ }
}

/** Devuelve null ante cualquier duda. Un nombre corrupto acá se convertiría en
 *  una tienda con nombre basura creada sola y sin que nadie la revise, así que
 *  se revalida con la MISMA regla del formulario en vez de confiar en el JSON. */
export function leerTiendaPendiente(): TiendaPendiente | null {
  try {
    const crudo = localStorage.getItem(CLAVE);
    if (!crudo) return null;
    const j = JSON.parse(crudo) as Partial<TiendaPendiente>;
    const nombre = String(j?.nombre ?? '').trim();
    if (!validarNombreTienda(nombre).ok) return null;
    return { nombre, pais: normalizarPais(String(j?.pais ?? '')) };
  } catch {
    return null;
  }
}

export function olvidarTiendaPendiente(): void {
  try { localStorage.removeItem(CLAVE); } catch { /* noop */ }
}

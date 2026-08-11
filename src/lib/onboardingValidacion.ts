// Validaciones del onboarding del dueño nuevo (crear tienda → credenciales → /admin).
//
// POR QUÉ ES UN ARCHIVO APARTE Y PURO
// El camino del cliente nuevo es el que el dueño de la plataforma NO puede
// ejercitar en su navegador: él ya tiene tienda y credenciales. Si la validación
// vive suelta dentro del componente, la única forma de probarla es crear una
// cuenta nueva a mano cada vez. Acá es pura, así que se testea sola.
//
// Regla de fondo: NUNCA habilitar el botón de avanzar con datos que ya sabemos
// que Dropi va a rechazar. Un "guardado" que después falla en silencio es peor
// que un error a tiempo — eso fue exactamente lo que dejó a Colombia con la
// billetera muerta diez días.

export interface ResultadoCampo {
  ok: boolean;
  /** Mensaje accionable en español. Vacío cuando está bien. */
  error: string;
}

const OK: ResultadoCampo = { ok: true, error: '' };
const mal = (error: string): ResultadoCampo => ({ ok: false, error });

/** Límite defensivo compartido: nada de texto libre sin techo. */
export const MAX_NOMBRE = 60;
export const MAX_URL = 300;
export const MAX_SECRETO = 4000;

export function validarNombreTienda(valor: string): ResultadoCampo {
  const v = (valor ?? '').trim();
  if (!v) return mal('Poné el nombre de tu tienda.');
  if (v.length < 2) return mal('El nombre necesita al menos 2 letras.');
  if (v.length > MAX_NOMBRE) return mal(`Máximo ${MAX_NOMBRE} caracteres.`);
  return OK;
}

export function validarPais(valor: string): ResultadoCampo {
  return valor === 'CO' || valor === 'EC' ? OK : mal('Elegí Colombia o Ecuador.');
}

/** La API Key de integraciones de Dropi es un JWT: tres partes separadas por punto.
 *  Chequear la FORMA acá evita el viaje entero para descubrir que pegó otra cosa
 *  (la clave de la cuenta, un pedazo cortado, o el token con comillas). */
export function validarApiKey(valor: string): ResultadoCampo {
  const v = (valor ?? '').trim();
  if (!v) return mal('Pegá tu API Key de Dropi (Configuración → API).');
  if (/\s/.test(v)) return mal('La clave no lleva espacios ni saltos de línea: pegala completa y sin cortar.');
  if (v.length > MAX_SECRETO) return mal('Eso es demasiado largo para ser la clave.');
  const partes = v.split('.');
  if (partes.length !== 3 || partes.some(p => p.length < 4)) {
    return mal('No parece una API Key de Dropi: son tres bloques separados por punto (empieza con "eyJ").');
  }
  return OK;
}

export function validarEmail(valor: string): ResultadoCampo {
  const v = (valor ?? '').trim();
  if (!v) return mal('Poné el correo con el que entrás a Dropi.');
  if (v.length > 255) return mal('Máximo 255 caracteres.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) return mal('Ese correo no parece válido.');
  return OK;
}

export function validarPassword(valor: string): ResultadoCampo {
  const v = valor ?? '';
  if (!v) return mal('Sin tu clave, Guardian no puede renovar el acceso y tu billetera deja de actualizarse.');
  if (v.length < 4) return mal('La clave parece incompleta.');
  if (v.length > MAX_SECRETO) return mal('Eso es demasiado largo.');
  return OK;
}

/** URL http(s) bien formada. `requerida=false` acepta vacío (logo). */
export function validarUrl(valor: string, requerida: boolean, queEs: string): ResultadoCampo {
  const v = (valor ?? '').trim();
  if (!v) return requerida ? mal(`Falta ${queEs}.`) : OK;
  if (v.length > MAX_URL) return mal('La dirección es demasiado larga.');
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return mal('Tiene que ser una dirección completa, empezando con https://');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return mal('Tiene que empezar con https://');
  }
  if (!u.hostname.includes('.')) return mal('Esa dirección no tiene un dominio válido.');
  return OK;
}

/** Campos del paso 2 (credenciales). Las claves coinciden con las del wizard. */
export interface ValoresSetup {
  name?: string;
  dropi_api_key?: string;
  dropi_login_email?: string;
  dropi_login_password?: string;
  dropi_store_url?: string;
  brand_logo_url?: string;
}

export type ErroresSetup = Partial<Record<keyof ValoresSetup, string>>;

/** Devuelve SOLO los campos con problema. Objeto vacío = se puede guardar. */
export function validarSetup(vals: ValoresSetup): ErroresSetup {
  const errores: ErroresSetup = {};
  const poner = (k: keyof ValoresSetup, r: ResultadoCampo) => { if (!r.ok) errores[k] = r.error; };

  poner('name', validarNombreTienda(vals.name ?? ''));
  poner('dropi_api_key', validarApiKey(vals.dropi_api_key ?? ''));
  poner('dropi_login_email', validarEmail(vals.dropi_login_email ?? ''));
  poner('dropi_login_password', validarPassword(vals.dropi_login_password ?? ''));
  poner('dropi_store_url', validarUrl(vals.dropi_store_url ?? '', true, 'la URL de integración de Dropi'));
  poner('brand_logo_url', validarUrl(vals.brand_logo_url ?? '', false, 'el logo'));

  return errores;
}

export const hayErrores = (e: ErroresSetup): boolean => Object.keys(e).length > 0;

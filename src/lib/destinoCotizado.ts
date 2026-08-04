/**
 * ¿La cotización que tengo en pantalla corresponde al destino que voy a guardar?
 *
 * El editor de pedidos cotiza el flete contra Dropi. Si la operadora cambia
 * después la ciudad, esa lista de transportadoras deja de servir: elegir una de
 * ahí hace que Dropi rechace el pedido al guardar ("LAARCOURIER no cotiza
 * envíos a BOMBOLÍ" con SANTO DOMINGO en pantalla — caso real 1-ago-2026).
 *
 * La comparación NO puede ser estricta: el nombre que devuelve Dropi sale de SU
 * catálogo y casi nunca coincide letra por letra con lo que escribió la
 * operadora ("QUITO DC" vs "QUITO", "SANTO DOMINGO DE LOS COLORADOS" vs "SANTO
 * DOMINGO"). Un aviso que salta cuando en realidad está todo bien se ignora a
 * los dos días, y entonces no sirve para el caso en que sí importa.
 */

/** Mayúsculas, sin tildes ni puntuación, espacios colapsados. */
export function normDestino(s: string | null | undefined): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * `true` si los dos nombres se refieren razonablemente al mismo lugar.
 *
 * Se aceptan como iguales cuando uno es prefijo del otro con al menos 4
 * caracteres — el MISMO criterio que usa el backend (`deptPrefixMatch` en
 * `dropiCityCatalog.ts`) para desambiguar departamentos. El mínimo de 4 evita
 * que "SAN" empareje con media Ecuador.
 */
export function mismoDestino(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normDestino(a);
  const y = normDestino(b);
  if (!x || !y) return true; // sin dato no se puede afirmar desfase: no alarmar
  if (x === y) return true;
  return x.length >= 4 && y.length >= 4 && (x.startsWith(y) || y.startsWith(x));
}

/**
 * ¿Hay que avisar que la cotización quedó vieja?
 *
 * `quotedCity` = lo que devolvió el quote (`dest.cityName`). `formCity` = lo que
 * está en pantalla. Devuelve `false` mientras falte cualquiera de los dos: una
 * versión vieja de la edge function no manda `dest`, y ahí NO se puede afirmar
 * que haya desfase — se prefiere callar antes que gritar en falso.
 */
export function cotizacionDesfasada(
  quotedCity: string | null | undefined,
  formCity: string | null | undefined,
): boolean {
  if (!normDestino(quotedCity) || !normDestino(formCity)) return false;
  return !mismoDestino(quotedCity, formCity);
}

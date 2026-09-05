import { normalizePhone } from './phone';

/**
 * Las formas con las que hay que buscar un teléfono para que el buscador
 * encuentre al cliente aunque lo escriban distinto.
 *
 * ── El caso real (4-sep-2026, Ecuador) ─────────────────────────────────────
 * Un cliente escribió `0986255535` por WhatsApp. Su pedido existe: #6853503,
 * Néstor Isaías Ayme, guardado como `986255535`. El bot no lo encontró y le
 * contestó que no le aparecía ningún pedido. La asesora tampoco lo encuentra si
 * copia y pega ese mismo número en el buscador de Guardian.
 *
 * La RPC `search_orders` compara con `phone LIKE '%loQueEscribiste%'`, y eso es
 * ASIMÉTRICO: `'%986255535%'` sí encuentra `0986255535`, pero `'%0986255535%'`
 * NO encuentra `986255535`. Buscar la forma larga cuando está guardada la corta
 * no devuelve nada.
 *
 * Censo sobre 12.000 pedidos de Ecuador: 11.988 guardados en 9 dígitos limpios
 * y NINGUNO con cero inicial. O sea que el dato está sano — lo que falla es la
 * búsqueda. Y el cero inicial es como lo escribe cualquier ecuatoriano.
 *
 * ── Por qué se arregla acá y no en la base ─────────────────────────────────
 * ⛔ REGLA #1: `search_orders` está desplegada y el repo va atrás. Reescribirla
 * desde una copia del repo es exactamente lo que el 21-jul-2026 mandó 2h30 de
 * pedidos de Ecuador a la cola de Colombia. Para tocarla hace falta primero su
 * `pg_get_functiondef`. Mientras tanto se compensa en el llamador, que no puede
 * romper nada de lo que ya funciona: la búsqueda de siempre se sigue haciendo
 * igual, y solo se AGREGA una segunda.
 *
 * ── Por qué la forma canónica siempre sirve ────────────────────────────────
 * `normalizePhone` saca el código de país y se queda con los últimos 9 dígitos,
 * así que lo que devuelve es SUBCADENA de cualquier forma más larga del mismo
 * número. Por eso alcanza con buscar la canónica además de la cruda:
 *
 *     EC  "0986255535" → "986255535"   ⊂ "986255535"   ✅ (lo que fallaba)
 *     EC  "+593986255535" → "986255535" ⊂ "986255535"  ✅
 *     CO  "3143048595"  → "143048595"  ⊂ "3143048595"  ✅
 *     CO  "+573143048595" → "143048595" ⊂ "3143048595" ✅
 */

/** Mínimo de dígitos para tratar el texto como teléfono. Menos que esto y
 *  `143048595`-por-`3143048595` empieza a traer clientes que no son. */
export const MIN_DIGITOS_TELEFONO = 7;

/** ¿Esto que escribió la asesora parece un teléfono? Se acepta lo que la gente
 *  copia y pega de verdad: `+`, espacios, guiones y paréntesis. Un nombre o un
 *  número de pedido con letras NO entra por acá. */
export function pareceTelefono(q: string): boolean {
  const t = String(q ?? '').trim();
  if (!t) return false;
  if (!/^[+()\s.-]*[\d][\d()\s.-]*$/.test(t)) return false;
  return t.replace(/\D/g, '').length >= MIN_DIGITOS_TELEFONO;
}

/**
 * Con qué hay que consultar. Siempre devuelve la búsqueda original primero —
 * la que hoy funciona no cambia — y agrega la canónica solo cuando aporta algo
 * distinto. Nunca devuelve duplicados ni una cadena vacía.
 */
export function variantesDeBusqueda(q: string): string[] {
  const cruda = String(q ?? '').trim();
  if (!cruda) return [];
  if (!pareceTelefono(cruda)) return [cruda];
  const canonica = normalizePhone(cruda);
  // Sin cambio útil: una sola consulta, como siempre.
  if (!canonica || canonica === cruda) return [cruda];
  return [cruda, canonica];
}

/**
 * Junta los resultados de varias consultas en una sola lista, sin repetidos y
 * respetando el orden de llegada (la búsqueda original manda).
 *
 * ⛔ La llave de deduplicación NO es `external_id` a secas: desde la migración
 * `20260820140000` ese número es único POR TIENDA, no globalmente. Acá todas
 * las filas vienen de la misma tienda (la RPC filtra por `p_store_id`), así que
 * alcanza — pero si algún día esto recibe filas de dos tiendas, la llave hay
 * que ampliarla o se van a pisar pedidos de empresas distintas.
 */
export function fusionarResultados<T extends { external_id?: string | null; phone?: string | null }>(
  tandas: (T[] | null | undefined)[],
  tope: number,
): T[] {
  const vistos = new Set<string>();
  const out: T[] = [];
  for (const tanda of tandas) {
    for (const fila of tanda ?? []) {
      // Sin `external_id` no hay con qué deduplicar; se cae al teléfono, y si
      // tampoco está, la fila pasa (perder un resultado es peor que repetirlo).
      const llave = fila?.external_id
        ? `id:${fila.external_id}`
        : fila?.phone ? `tel:${fila.phone}` : null;
      if (llave) {
        if (vistos.has(llave)) continue;
        vistos.add(llave);
      }
      out.push(fila);
      if (out.length >= tope) return out;
    }
  }
  return out;
}

/**
 * El teléfono tal como hay que escribirlo para que el buscador de DROPI lo
 * encuentre.
 *
 * ── Medido contra el panel real de Dropi (4-sep-2026, cuenta de Ecuador) ───
 * `textToSearch` es una coincidencia por SUBCADENA sobre lo que Dropi tiene
 * guardado, y Dropi guarda 9 dígitos limpios. O sea que cualquier prefijo lo
 * rompe:
 *
 *     967107198        → 2 pedidos   ✅
 *     67107198         → 2 pedidos   ✅  (subcadena, también sirve)
 *     0967107198       → 0           ❌  el cero que escribe el cliente
 *     +593967107198    → 0           ❌
 *     593967107198     → 0           ❌
 *     096 710 7198     → 0           ❌  con espacios
 *
 * ⛔ POR QUÉ IMPORTA: el equipo revisa en Dropi ANTES de cargar a mano, para no
 * duplicar. Y Guardian les venía dando el número EN EL FORMATO QUE NO SIRVE —
 * medido en /confirmar el 4-sep: 15 de 16 teléfonos en pantalla eran `+593…`.
 * Copiaban de acá, pegaban en Dropi, no aparecía nada, y cargaban el duplicado.
 * De los 21 duplicados de la quincena, 5 son exactamente esa forma: Guardian ya
 * lo había creado y la persona no lo vio.
 *
 * Devuelve `''` si no hay con qué buscar, para que quien lo use pueda decidir
 * mostrar el original en vez de un vacío.
 */
export function telefonoParaBuscarEnDropi(phone: string | null | undefined): string {
  const canonico = normalizePhone(phone);
  return canonico.length >= 7 ? canonico : String(phone ?? '').replace(/\D/g, '');
}

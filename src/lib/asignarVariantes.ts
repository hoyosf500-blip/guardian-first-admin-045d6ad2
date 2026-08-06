import type { OrderLineDetail } from './orderUtils';

// Cruce entre las líneas que devuelve la cotización de Dropi y las variantes
// (talla / color) que Guardian ya tiene guardadas en `orders.productos_detalle`.
//
// POR QUÉ NO ES UN `find` POR NOMBRE
// El caso real de esta operación son zapatos: un pedido con dos líneas del
// MISMO modelo en tallas distintas. Dropi las manda con el nombre repetido
// —"Nuevo modelo Sneakers 2801, Nuevo modelo Sneakers 2801"—; 10 de los últimos
// 40 pedidos de Colombia estaban así (verificado en producción 2026-07-21, ver
// el encabezado de _shared/dropiOrderMapper.ts).
//
// Con un `find` por nombre, las DOS líneas se quedan con la variante de la
// primera. La asesora entonces le confirma "talla 38" por teléfono a un cliente
// que pidió la 40, el pedido sale mal y vuelve como devolución. Una talla
// equivocada cuesta más que una talla ausente: sin el dato la asesora pregunta;
// con el dato equivocado, no.
//
// REGLA DE ORO: ante la duda, vacío. Nunca se infiere una talla.

/** Lo mínimo que necesitamos de una línea cotizada. */
export interface LineaCotizada {
  dropiId: number;
  name?: string;
  quantity: number;
  price: number;
}

const norm = (s?: string): string => String(s ?? '').trim().toLowerCase();

/** Los precios llegan de dos caminos distintos (cotización vs sync) y pueden
 *  diferir en centavos por redondeo. Un centavo no debe romper el cruce. */
const mismoPrecio = (a: number, b: number): boolean => Math.abs(a - b) < 0.01;

/**
 * Devuelve `dropiId → variante` solo para las líneas que se pueden identificar
 * SIN AMBIGÜEDAD. Las que no, quedan fuera del mapa (y por lo tanto sin chip).
 */
export function asignarVariantes(
  lineas: LineaCotizada[],
  detalle: OrderLineDetail[] | null | undefined,
): Map<number, string> {
  const out = new Map<number, string>();
  if (!Array.isArray(lineas) || !Array.isArray(detalle) || detalle.length === 0) return out;

  // Índices de `detalle` agrupados por nombre. Las entradas sin variante no
  // entran: no hay nada que mostrar y solo estorbarían el desempate.
  const porNombre = new Map<string, number[]>();
  detalle.forEach((d, i) => {
    const k = norm(d?.nombre);
    if (!k || !String(d?.variante ?? '').trim()) return;
    const arr = porNombre.get(k);
    if (arr) arr.push(i);
    else porNombre.set(k, [i]);
  });
  if (porNombre.size === 0) return out;

  // Una entrada de detalle no se le puede adjudicar a dos líneas distintas.
  const usados = new Set<number>();

  for (const linea of lineas) {
    const k = norm(linea?.name);
    if (!k) continue;
    const libres = (porNombre.get(k) ?? []).filter((i) => !usados.has(i));
    if (libres.length === 0) continue;

    // Caso feliz y mayoritario: todas las candidatas dicen lo mismo, así que
    // no hay forma de equivocarse. No se consume ninguna — dos líneas
    // idénticas del mismo producto deben mostrar las dos su variante.
    const variantes = new Set(libres.map((i) => detalle[i].variante.trim()));
    if (variantes.size === 1) {
      out.set(linea.dropiId, detalle[libres[0]].variante.trim());
      continue;
    }

    // Hay varias variantes posibles para este nombre: desempatar por lo que
    // distingue una línea de otra. Primero precio Y cantidad, después precio.
    let cand = libres.filter(
      (i) => mismoPrecio(detalle[i].precio, linea.price) && detalle[i].cantidad === linea.quantity,
    );
    if (cand.length !== 1) {
      cand = libres.filter((i) => mismoPrecio(detalle[i].precio, linea.price));
    }
    // Sigue sin poder distinguirse (mismo nombre, mismo precio, misma cantidad
    // y distinta talla): vacío. Acá es donde un `find` mentiría.
    if (cand.length !== 1) continue;

    usados.add(cand[0]);
    out.set(linea.dropiId, detalle[cand[0]].variante.trim());
  }

  return out;
}

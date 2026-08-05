/**
 * ¿Esta cotización debe RECONSTRUIR las líneas editables del pedido?
 *
 * El editor de Confirmar pide cotización a Dropi en tres momentos, y solo uno
 * debería tocar las líneas:
 *
 *   1. Al abrir el diálogo  → sí: no hay nada tipeado que perder.
 *   2. Al cambiar la ciudad → NO: la asesora puede llevar cantidades y precios
 *      editados, y la ciudad no cambia los productos.
 *   3. Al tocar "Reintentar" en la lista de transportadoras → NO, igual que 2.
 *
 * La condición vieja era "si no me pasaron líneas, reconstruí", y los casos 2 y
 * 3 tampoco pasan líneas. Resultado: cambiar la ciudad borraba en silencio lo
 * que la asesora acababa de tipear. El total volvía al original, el botón
 * quedaba habilitado igual (la ciudad SÍ cambió) y el guardado terminaba con
 * "Orden actualizada y sincronizada con Dropi". La asesora se enteraba cuando
 * el mensajero cobraba otra cosa.
 *
 * El total escrito a mano (`overrideRaw`) sí sobrevivía, así que la pérdida era
 * parcial y más difícil de notar todavía.
 *
 * `pidieron` va en false por defecto en el llamador: un camino nuevo que se
 * olvide de decidir NO puede borrar trabajo. Se elige perder una siembra
 * (recuperable: se vuelve a abrir el diálogo) antes que perder una edición
 * (que se descubre cuando el cliente ya pagó otra cosa).
 */
export function debeSembrarLineas(
  pidieron: boolean,
  lineasActuales: unknown[] | null | undefined,
): boolean {
  if (pidieron) return true;
  // Sin líneas todavía no hay nada que pisar — y es la única forma de
  // recuperarse de una primera cotización que vino sin ellas.
  return lineasActuales == null;
}

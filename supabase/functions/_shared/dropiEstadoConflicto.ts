// Cuando Dropi RECHAZA una edición porque el pedido ya está en otro estado, el
// rechazo trae un dato valiosísimo: **el estado REAL del pedido**.
//
//   "Error al actualizar la orden: La orden 6503113 ya se encuentra en
//    estatus: CANCELADO"
//
// Eso no es "falló": es Dropi diciendo "tu pantalla está vieja". Hasta ahora ese
// texto se le mostraba crudo a la asesora, que no tenía forma de saber qué
// hacer. Medido el 12-ago-2026: el pedido 6503113 se reintentó CUATRO veces en
// 47 segundos. Cuatro llamadas inútiles a Dropi y una persona peleando con una
// pantalla que ya sabía la respuesta.
//
// Con el estado extraído, el caller puede sincronizar la fila local: Dropi es la
// fuente de verdad sobre sus propios pedidos, así que si dice que está
// CANCELADO, está CANCELADO.

/** Estado que Dropi reporta al rechazar una edición por conflicto, o null si el
 *  rechazo fue por otra cosa. */
export function estadoDeConflicto(detalle: string | null | undefined): string | null {
  const txt = String(detalle || "");
  if (!txt) return null;
  const m = txt.match(/ya se encuentra en (?:el\s+)?est(?:atus|ado)\s*:?\s*([A-Za-zÁÉÍÓÚÑáéíóúñ_ ]{3,40})/i);
  if (!m) return null;
  const estado = m[1]
    .replace(/[.,;].*$/, "")   // corta si el mensaje sigue tras el estado
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
  // Un token demasiado corto o que quedó vacío no es un estado utilizable: mejor
  // devolver null y mostrar el mensaje crudo que escribir basura en la fila.
  return estado.length >= 3 ? estado : null;
}

// «- llamar para la entrega»: la coletilla que la asesora de Ecuador le agrega a
// la dirección al confirmar por teléfono, para que el mensajero llame antes de
// llegar. Medido (Rushmira Ecuador, 29-ago → 5-sep-2026): la llevan 295 de los
// 422 pedidos confirmados o despachados (70 %), y en 139 de 139 ediciones de
// datos del 4 y 5 de septiembre la asesora tocó la dirección — muchas veces solo
// para escribir esto a mano. Un botón la pone; esta función decide el texto.

export const COLETILLA_LLAMAR = "llamar para la entrega";

/** ¿La dirección ya pide que llamen? (mayúsculas, tildes y guiones indiferentes) */
export function yaPideLlamar(direccion: string | null | undefined): boolean {
  return /llamar\s+para\s+la\s+entrega/i.test(String(direccion ?? ""));
}

/**
 * Devuelve la dirección con « - llamar para la entrega» al final. Idempotente:
 * si ya la tiene, devuelve la misma cadena. Limpia espacios y un guion suelto
 * al final para no producir «Calle 5 - - llamar para la entrega».
 */
export function agregarLlamarParaLaEntrega(direccion: string | null | undefined): string {
  const base = String(direccion ?? "").trim();
  if (yaPideLlamar(base)) return base;
  const limpia = base.replace(/[\s\-–—,.;]+$/g, "").trim();
  return limpia ? `${limpia} - ${COLETILLA_LLAMAR}` : "";
}

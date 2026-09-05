// Política de transportadora al CREAR una orden por el panel web de Dropi.
//
// Lo medido (Rushmira Ecuador, 29-ago → 5-sep-2026, 993 pedidos): de los que
// llegaron a confirmarse o despacharse, 299 iban por LAARCOURIER, 118 por
// SERVIENTREGA y **5** por GINTRACOM. Y en dos días las asesoras cambiaron la
// transportadora a mano 165 veces: 127 de ellas PARA SALIR de GINTRACOM, una
// sola para entrar. 296 de los 993 pedidos (30 %) terminaron REEMPLAZADA: cada
// cambio en Dropi es una orden nueva con otro número, otra pasada por el bug
// de la variante, otro fantasma en la cola y uno o dos minutos de la asesora.
//
// ¿Quién elegía GINTRACOM? Nosotros. `createOrderViaWeb` tomaba «la más
// barata ≠ VELOCES», y en Quito/Guayaquil la más barata es GINTRACOM (4,91
// contra 6,53 de LAARCOURIER). El robot creaba el pedido que la asesora iba
// a deshacer diez minutos después. La operación ya pagaba el flete de
// LAARCOURIER: solo que lo pagaba con una orden de más.
//
// La regla acá es PURA (sin red, sin Deno) para probarla con datos fijos:
//   1. Si la tienda tiene preferencia, van primero las preferidas que Dropi
//      COTIZÓ para ese destino, en el orden de la preferencia.
//   2. Después, las demás por precio ascendente, nunca VELOCES (regla vieja).
//   3. El resultado es una LISTA de candidatas, no una sola: si Dropi rechaza
//      el POST con «la ciudad no tiene habilitado el método de envío» para la
//      primera (pasó 7 veces en dos días con la más barata), el caller prueba
//      la siguiente en vez de darse por vencido.
// Una tienda sin preferencia se comporta exactamente como antes.

/** Preferencia por tienda. Rushmira Ecuador: LAARCOURIER entrega al día
 *  siguiente y es lo que el equipo elige a mano; SERVIENTREGA donde LAAR no
 *  llega (o retiro en agencia). GINTRACOM no está a propósito: 5 de 422. */
const PREFERENCIA_POR_TIENDA: Record<string, readonly string[]> = {
  "512309c3-d5b7-4434-898a-31bed51dcd4d": ["LAARCOURIER", "SERVIENTREGA"],
};

export interface CandidataTransportadora {
  id: number | string;
  name: string;
  typeService: string;
  shippingAmount: number;
}

const norm = (s: unknown) => String(s ?? "").trim().toUpperCase();

export function preferenciaTransportadora(storeId: string | null | undefined): readonly string[] {
  return PREFERENCIA_POR_TIENDA[String(storeId ?? "")] ?? [];
}

/**
 * Ordena las opciones cotizadas en el orden en que hay que INTENTAR crear.
 * `options` viene de la cotización web (ordenada asc por precio por Dropi,
 * pero acá no se confía en eso: se reordena). Devuelve [] si no hay nada
 * usable (solo VELOCES, o vacío).
 */
export function ordenarCandidatas<T extends CandidataTransportadora>(
  options: readonly T[],
  preferidas: readonly string[],
): T[] {
  const usables = options.filter((o) => norm(o.name) !== "VELOCES" && Number.isFinite(Number(o.shippingAmount)));
  const porNombre = new Map<string, T>();
  for (const o of usables) if (!porNombre.has(norm(o.name))) porNombre.set(norm(o.name), o);
  const primero: T[] = [];
  for (const p of preferidas) {
    const hit = porNombre.get(norm(p));
    if (hit && !primero.includes(hit)) primero.push(hit);
  }
  const resto = usables
    .filter((o) => !primero.includes(o))
    .sort((a, b) => Number(a.shippingAmount) - Number(b.shippingAmount));
  return [...primero, ...resto];
}

/** Dropi rechaza el POST (200 + isSuccess:false) con «3. La ciudad no tiene
 *  habilitado el médoto de envío: CON RECAUDO - PALENQUE-LOS RIOS-LAARCOURIER»
 *  (sic, con el typo). Es un rechazo SEGURO de esa transportadora para ese
 *  destino, no de la orden: se prueba la siguiente candidata. */
export function esRechazoPorMetodoDeEnvio(detalle: unknown): boolean {
  return /no tiene habilitado el m\S* de env[ií]o/i.test(String(detalle ?? ""));
}

/** Texto corto para el log: qué regla eligió. */
export function motivoEleccion(elegida: CandidataTransportadora, preferidas: readonly string[]): string {
  const i = preferidas.findIndex((p) => norm(p) === norm(elegida.name));
  return i >= 0 ? `preferida #${i + 1} de la tienda` : "la más barata que no es VELOCES";
}

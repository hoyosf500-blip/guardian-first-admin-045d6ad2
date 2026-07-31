/**
 * Acciones de gestión de Seguimiento COHERENTES con el estado del pedido —
 * pedido del dueño 2026-07-30 (referencia: el kanban de Boostec): en "Guía
 * generada" lo relevante es "ya le envié la guía"; en "En reparto", "avisé que
 * llega hoy"; en "Oficina", "avisé que está en oficina / va a recogerlo".
 * La botonera mostraba los mismos 4 métodos para todo, y la asesora tenía que
 * traducir mentalmente.
 *
 * Reglas:
 *  - La acción MÁS relevante para ese estado va PRIMERA.
 *  - 'No contestó' está siempre (es el desenlace más común de una llamada).
 *  - Los canales genéricos (Llamé / WhatsApp) van después de lo específico.
 *  - 'Cliente recoge' se reusa tal cual (ya existe en el histórico de
 *    touchpoints) — no se inventa un sinónimo nuevo.
 *  - NINGUNA de estas es cierre: todas registran `SEG: <acción>` y siguen el
 *    modelo de revisión diaria (ocultan hoy, reaparecen mañana). Los cierres
 *    (Resuelto / Devolución) viven aparte en SEG_CLOSERS y no se tocan.
 *
 * Puro a propósito (estado → lista de labels): se testea sin DOM. El bucket lo
 * decide `classifySegEstado` — la MISMA clasificación del kanban y las cards,
 * así los botones nunca contradicen la columna en la que está el pedido.
 */
import { classifySegEstado, type SegStatusKey } from './segStatus';

/** Los 4 de siempre — fallback para estados sin juego propio (y compat). */
export const METODOS_DEFAULT: readonly string[] = [
  'Llamé',
  'WhatsApp',
  'Reclamé transportadora',
  'Cliente recoge',
];

const METODOS_POR_BUCKET: Partial<Record<SegStatusKey, string[]>> = {
  // Aún no viaja: lo útil es avisar que el pedido va en camino de salir.
  procesamiento: ['Avisé que está en proceso', 'No contestó', 'Volver a llamar', 'Llamé', 'WhatsApp'],
  // Guía lista: mandarle la guía / número de rastreo al cliente.
  guia: ['Envié la guía', 'No contestó', 'Volver a llamar', 'Llamé', 'WhatsApp'],
  bodega_trans: ['Envié la guía', 'No contestó', 'Volver a llamar', 'Llamé', 'WhatsApp'],
  transito: ['Avisé que va en camino', 'No contestó', 'Volver a llamar', 'Llamé', 'WhatsApp'],
  // En reparto: avisar que llega HOY (que tenga el efectivo listo).
  reparto: ['Avisé que llega hoy', 'No contestó', 'Volver a llamar', 'Reclamé transportadora', 'Llamé', 'WhatsApp'],
  // En oficina: avisar dónde está y confirmar que lo va a recoger.
  oficina: ['Avisé: en oficina', 'Cliente recoge', 'No contestó', 'Volver a llamar', 'Reclamé transportadora', 'Llamé', 'WhatsApp'],
  novedad: ['Reclamé transportadora', 'Coordiné nueva entrega', 'No contestó', 'Volver a llamar', 'Llamé', 'WhatsApp'],
  novedad_sol: ['Reclamé transportadora', 'Coordiné nueva entrega', 'No contestó', 'Volver a llamar', 'Llamé', 'WhatsApp'],
  rechazado: ['Llamé', 'Reclamé transportadora', 'No contestó', 'Volver a llamar', 'WhatsApp'],
  devolucion_transito: ['Reclamé transportadora', 'Llamé', 'No contestó', 'WhatsApp'],
  devolucion: ['Reclamé transportadora', 'Llamé', 'No contestó', 'WhatsApp'],
};

/**
 * Las 3 acciones que van EN LA TARJETA del kanban (el resto queda en la ficha).
 * Tres y no más porque la tarjeta compite con otras 30 en pantalla: la primera
 * es la del estado, y las dos que siguen son los desenlaces reales de la
 * llamada. Se deriva de la misma lista para que tablero y ficha nunca ofrezcan
 * cosas distintas para el mismo pedido.
 */
export function metodosRapidosParaEstado(estado: string | null | undefined): readonly string[] {
  return metodosParaEstado(estado).slice(0, 3);
}

/**
 * Métodos de gestión para un pedido según su `estado` Dropi, la acción más
 * relevante primero. Estado desconocido/ausente → los 4 de siempre.
 */
export function metodosParaEstado(estado: string | null | undefined): readonly string[] {
  if (!estado) return METODOS_DEFAULT;
  return METODOS_POR_BUCKET[classifySegEstado(estado)] ?? METODOS_DEFAULT;
}

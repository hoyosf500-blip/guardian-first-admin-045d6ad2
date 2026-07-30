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
  procesamiento: ['Avisé que está en proceso', 'No contestó', 'Llamé', 'WhatsApp'],
  // Guía lista: mandarle la guía / número de rastreo al cliente.
  guia: ['Envié la guía', 'No contestó', 'Llamé', 'WhatsApp'],
  bodega_trans: ['Envié la guía', 'No contestó', 'Llamé', 'WhatsApp'],
  transito: ['Avisé que va en camino', 'No contestó', 'Llamé', 'WhatsApp'],
  // En reparto: avisar que llega HOY (que tenga el efectivo listo).
  reparto: ['Avisé que llega hoy', 'No contestó', 'Reclamé transportadora', 'Llamé', 'WhatsApp'],
  // En oficina: avisar dónde está y confirmar que lo va a recoger.
  oficina: ['Avisé: en oficina', 'Cliente recoge', 'No contestó', 'Reclamé transportadora', 'Llamé', 'WhatsApp'],
  novedad: ['Reclamé transportadora', 'Coordiné nueva entrega', 'No contestó', 'Llamé', 'WhatsApp'],
  novedad_sol: ['Reclamé transportadora', 'Coordiné nueva entrega', 'No contestó', 'Llamé', 'WhatsApp'],
  rechazado: ['Llamé', 'Reclamé transportadora', 'No contestó', 'WhatsApp'],
  devolucion_transito: ['Reclamé transportadora', 'Llamé', 'No contestó', 'WhatsApp'],
  devolucion: ['Reclamé transportadora', 'Llamé', 'No contestó', 'WhatsApp'],
};

/**
 * Métodos de gestión para un pedido según su `estado` Dropi, la acción más
 * relevante primero. Estado desconocido/ausente → los 4 de siempre.
 */
export function metodosParaEstado(estado: string | null | undefined): readonly string[] {
  if (!estado) return METODOS_DEFAULT;
  return METODOS_POR_BUCKET[classifySegEstado(estado)] ?? METODOS_DEFAULT;
}

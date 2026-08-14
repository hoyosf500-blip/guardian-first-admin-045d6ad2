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

/**
 * ¿Esa gestión significa que SE HABLÓ con el cliente?
 *
 * No todas cierran el asunto del día. "No contestó" y "Volver a llamar" son lo
 * contrario: el pedido sigue necesitando trabajo. La diferencia es la que
 * decide si una tarjeta se puede dar por atendida para TODO el equipo.
 *
 * Existe porque tratarlas igual salía carísimo (bug del 31-jul): un "No
 * contestó" de Ana a las 9am bloqueaba la tarjeta para todas y —con "Ocultar
 * gestionados", que viene activado por defecto— la hacía DESAPARECER del
 * tablero de todo el equipo el resto del día. El cliente que no atendió a la
 * primera se volvía invisible y nadie lo volvía a llamar.
 *
 * Compara sin tildes y sin importar mayúsculas: el texto llega de un
 * touchpoint viejo o de la botonera nueva, y "No contestó"/"NO CONTESTO" son
 * el mismo hecho.
 */
export function esContactoEfectivo(metodo: string | null | undefined): boolean {
  if (!metodo) return false;
  const m = metodo.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  if (m.includes('NO CONTEST')) return false;
  if (m.includes('VOLVER A LLAMAR')) return false;
  return true;
}

/**
 * ¿La fase del pedido admite gestión (= la tarjeta lleva botonera)?
 *
 * La botonera del tablero se activaba por el TONE visual de la columna
 * (bug C2, auditoría 14-ago-2026): "Nov. Solucionada" es tone `success` y sus
 * tarjetas salían SIN botones aunque cuentan en la cola de hoy — la cola no
 * podía llegar a 0 porque esos pedidos no se podían gestionar desde el
 * tablero. Y las columnas `danger` (Rechazado, Devolución, Dev. en Tránsito)
 * tienen métodos propios acá arriba y tampoco los mostraban.
 *
 * La pregunta correcta no es de qué color es la columna sino si la FASE tiene
 * trabajo: solo entregado, cancelado/borrado e indemnizada son desenlaces sin
 * nada que registrar. Todo lo demás —incluido 'otros', el estado que Dropi
 * invente mañana— se puede gestionar.
 */
const FASES_SIN_GESTION: ReadonlySet<SegStatusKey> = new Set(['entregado', 'cancelado', 'indemnizada']);

export function faseConGestion(estado: string | null | undefined): boolean {
  return !FASES_SIN_GESTION.has(classifySegEstado(estado || ''));
}

/**
 * Fallback para estados sin juego propio — incluidos los que Dropi invente
 * mañana, que caen en 'otros'.
 *
 * "No contestó" y "Volver a llamar" NO estaban acá (auditoría 4-ago-2026), y su
 * ausencia hacía desaparecer clientes: son los DOS únicos desenlaces que
 * `esContactoEfectivo` trata como "sigue pendiente". Sin ellos, la asesora que
 * llamaba y no le contestaban solo podía tocar "Llamé" — que cuenta como
 * contacto efectivo, marca la tarjeta como gestionada para TODO el equipo y,
 * con "Ocultar gestionados" (que viene activado), la esconde el resto del día.
 * Nadie volvía a llamar a ese cliente y el paquete se iba a devolución.
 *
 * Los buckets conocidos ya los traían; el hueco era justo el del estado
 * desconocido, que es donde menos se puede dar por bueno un desenlace.
 */
export const METODOS_DEFAULT: readonly string[] = [
  'Llamé',
  'No contestó',
  'Volver a llamar',
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

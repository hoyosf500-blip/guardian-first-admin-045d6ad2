import { classifySegEstado, type SegStatusKey } from './segStatus';

/**
 * El idioma HUMANO de Seguimiento: cómo se llama, en español, lo que hay que
 * hacerle a un pedido según dónde está — y qué plantilla de Meta lo hace.
 *
 * ── De dónde sale (27-ago-2026) ─────────────────────────────────────────────
 * Dos quejas del dueño el mismo día, que resultaron ser la misma:
 *
 * 1. *"mis colaboradores no entienden y no saben trabajar, hay muchos botones"*
 *    — el modal de plantillas mostraba las ~40 aprobadas de la cuenta, en una
 *    grilla plana, con el nombre CRUDO de Meta: `retiro_agencia_k1`,
 *    `novedadk2`, `remarketin3 ecomm`. Eso no es un nombre, es un identificador
 *    de sistema. Nadie puede elegir bien entre 40 identificadores.
 *
 * 2. *"él marcaba pero el número no bajaba"* — los botones de la tarjeta
 *    ("Avisé: en oficina") solo DECLARABAN. Escribían un touchpoint y nada más:
 *    no mandaban el aviso, y nadie podía comprobar que el cliente se enteró.
 *
 * La respuesta a las dos es la misma: **el botón dice lo que le va a llegar al
 * cliente, y lo manda.** "Avisarle que llegó a la agencia" en vez de
 * `retiro_agencia_k1`, y que al tocarlo el WhatsApp salga de verdad.
 *
 * ── Reglas de este archivo ──────────────────────────────────────────────────
 * - **Puro.** Estado (string de Dropi) → texto. Sin red, sin React, testeable.
 * - La fase la decide `classifySegEstado`, la MISMA del kanban y de los métodos
 *   de gestión: el botón nunca puede ofrecer algo que contradiga la columna en
 *   la que está el pedido.
 * - Las plantillas se buscan por **patrón**, no por nombre exacto. Los nombres
 *   los pone cada cliente en su cuenta de Meta: un mapa literal serviría solo
 *   para Ecuador y dejaría a las demás tiendas sin botón.
 * - **Sin match no se inventa nada.** Una plantilla que no reconocemos se
 *   muestra con su nombre crudo y una fase sin plantilla no ofrece el botón.
 *   Ponerle una etiqueta bonita a una plantilla desconocida sería adivinarle el
 *   contenido a un mensaje que le va a llegar a un cliente real.
 */

export interface AccionFase {
  /** Lo que dice el botón. Empieza en verbo y nombra al cliente: es lo que le
   *  va a pasar a ÉL, no lo que registra el sistema. */
  etiqueta: string;
  /** Qué se anota en la bitácora. Es el texto que ya usaba la botonera vieja
   *  (`segMetodosEstado.ts`), a propósito: el histórico no se parte en dos. */
  gestion: string;
  /** Patrones de nombre de plantilla de Meta, EN ORDEN de preferencia. El
   *  primero que matchee una plantilla aprobada de la cuenta, gana. */
  plantillas: readonly RegExp[];
}

/**
 * ⛔ Solo las fases donde hay UNA acción obvia. `otros`, `entregado`,
 * `cancelado` e `indemnizada` quedan fuera a propósito: sin una acción clara,
 * un botón grande que manda un WhatsApp es peor que ningún botón.
 */
const ACCION_POR_FASE: Partial<Record<SegStatusKey, AccionFase>> = {
  oficina: {
    etiqueta: 'Avisarle que llegó a la agencia',
    gestion: 'Avisé: en oficina',
    plantillas: [/retiro_agencia_disponible/, /retiro_agencia(?!_recordatorio)/, /retiro_agencia/, /agencia|oficina|retiro/],
  },
  guia: {
    etiqueta: 'Mandarle la guía',
    gestion: 'Envié la guía',
    plantillas: [/guia_generada/, /antes_generar_guia/, /guia/],
  },
  bodega_trans: {
    etiqueta: 'Mandarle la guía',
    gestion: 'Envié la guía',
    plantillas: [/guia_generada/, /guia/],
  },
  reparto: {
    etiqueta: 'Avisarle que le llega hoy',
    gestion: 'Avisé que llega hoy',
    plantillas: [/en_camino_hoy/, /zona_entrega/, /en_transito|transito/],
  },
  transito: {
    etiqueta: 'Avisarle que va en camino',
    gestion: 'Avisé que va en camino',
    plantillas: [/en_transito|transito/, /en_camino_hoy/, /zona_entrega/],
  },
  novedad: {
    etiqueta: 'Preguntarle la dirección',
    gestion: 'Coordiné nueva entrega',
    plantillas: [/novedad/, /direccion_incompleta|direccion/],
  },
  novedad_sol: {
    etiqueta: 'Confirmarle la nueva entrega',
    gestion: 'Coordiné nueva entrega',
    plantillas: [/novedad/, /en_camino_hoy|zona_entrega/],
  },
  procesamiento: {
    etiqueta: 'Avisarle que ya se está preparando',
    gestion: 'Avisé que está en proceso',
    plantillas: [/antes_generar_guia/, /confirmacion_pedido|confirmacion/],
  },
  devolucion: {
    etiqueta: 'Ofrecerle reenviárselo',
    gestion: 'Llamé',
    plantillas: [/rescate_devolucion|rescate/, /seguimiento_reactivar|reactivar/, /ultima_oportunidad/],
  },
  devolucion_transito: {
    etiqueta: 'Ofrecerle reenviárselo',
    gestion: 'Llamé',
    plantillas: [/rescate_devolucion|rescate/, /seguimiento_reactivar|reactivar/, /ultima_oportunidad/],
  },
  rechazado: {
    etiqueta: 'Preguntarle qué pasó',
    gestion: 'Llamé',
    plantillas: [/rescate_devolucion|rescate/, /ultima_oportunidad/, /novedad/],
  },
};

/** La acción principal para ESE pedido, o null si su fase no tiene una obvia. */
export function accionPrincipal(estado: string | null | undefined): AccionFase | null {
  if (!estado) return null;
  return ACCION_POR_FASE[classifySegEstado(estado)] ?? null;
}

// ── Nombres humanos de las plantillas ───────────────────────────────────────
// Tabla ORDENADA, primera que matchea gana — mismo molde que `cancelTaxonomy`
// y `novedadTaxonomy`. Los patrones van de lo específico a lo general: si
// `retiro_agencia_recordatorio_k3` estuviera después de `retiro_agencia`, se
// llamaría "Avisarle que llegó a la agencia" y la asesora mandaría un
// recordatorio de vencimiento creyendo que manda el primer aviso.
interface ReglaEtiqueta { prueba: RegExp; etiqueta: string }

const ETIQUETAS: readonly ReglaEtiqueta[] = [
  { prueba: /retiro_agencia_recordatorio|retiro.*recordatorio/, etiqueta: 'Recordarle que la agencia se lo devuelve' },
  { prueba: /retiro_agencia_disponible/, etiqueta: 'Avisarle que ya lo puede retirar' },
  { prueba: /retiro_agencia|retiro/, etiqueta: 'Avisarle que llegó a la agencia' },
  { prueba: /antes_generar_guia/, etiqueta: 'Avisarle antes de despacharlo' },
  { prueba: /guia_generada/, etiqueta: 'Mandarle la guía' },
  { prueba: /en_camino_hoy/, etiqueta: 'Avisarle que le llega hoy' },
  { prueba: /zona_entrega/, etiqueta: 'Avisarle que el repartidor va en camino' },
  { prueba: /en_transito|transito/, etiqueta: 'Avisarle que su pedido va en camino' },
  { prueba: /direccion_incompleta|direccion/, etiqueta: 'Pedirle la dirección completa' },
  { prueba: /novedad/, etiqueta: 'Avisarle que no lo pudieron entregar' },
  { prueba: /rescate_devolucion|rescate/, etiqueta: 'Ofrecerle reenviárselo antes de que se devuelva' },
  { prueba: /seguimiento_reactivar|reactivar/, etiqueta: 'Retomar el pedido que quedó frío' },
  { prueba: /ultima_oportunidad/, etiqueta: 'Última oportunidad antes de cancelar' },
  { prueba: /reconfirmacion|recordatorio_confirmacion/, etiqueta: 'Volver a pedirle que confirme' },
  { prueba: /confirmacion_datos/, etiqueta: 'Pedirle que confirme sus datos' },
  { prueba: /confirmacion_pedido|confirmacion/, etiqueta: 'Pedirle que confirme el pedido' },
  { prueba: /entregado_gracias|entregado/, etiqueta: 'Agradecerle la compra' },
  { prueba: /carritos_abandonados|carrito/, etiqueta: 'Recuperar un carrito abandonado' },
  { prueba: /stock_agotado/, etiqueta: 'Avisarle que se agotó' },
  { prueba: /stock_apartado/, etiqueta: 'Avisarle que se lo apartamos' },
  { prueba: /envio_gratis/, etiqueta: 'Ofrecerle envío gratis' },
  { prueba: /descuento/, etiqueta: 'Ofrecerle un descuento' },
  { prueba: /despacho_listo/, etiqueta: 'Avisarle que ya sale' },
  { prueba: /remarketing|remarketin/, etiqueta: 'Volver a ofrecerle el producto' },
  { prueba: /ecommerce/, etiqueta: 'Mensaje de la tienda' },
];

const sinTildes = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Cómo se le llama a esta plantilla en cristiano, o `null` si no la
 * reconocemos.
 *
 * `null` no es un fallo: es la respuesta honesta. Quien lo llame muestra el
 * nombre crudo, que al menos es verdad. Devolver "Mensaje al cliente" para
 * cualquier plantilla desconocida haría que dos plantillas distintas se vieran
 * idénticas en la lista — el peor resultado posible acá.
 */
export function etiquetaPlantilla(nombre: string | null | undefined): string | null {
  const n = sinTildes(String(nombre || ''));
  if (!n) return null;
  return ETIQUETAS.find((r) => r.prueba.test(n))?.etiqueta ?? null;
}

/** El nombre para mostrar: la etiqueta humana si la hay, y si no el nombre de
 *  Meta con los guiones bajos convertidos en espacios (como se veía antes). */
export function nombreVisible(nombre: string): string {
  return etiquetaPlantilla(nombre) ?? nombre.replace(/_/g, ' ');
}

/** Lo mínimo que necesitamos de una plantilla para ordenarla. Se define acá
 *  —en vez de importar `PlantillaMeta`— para que este módulo no dependa del
 *  contrato de la edge function y se pueda probar con objetos de dos campos. */
export interface PlantillaOrdenable {
  nombre: string;
  /** Motivo por el que Guardian no la puede mandar (cabecera con imagen, botón
   *  con enlace variable). Las bloqueadas nunca se recomiendan. */
  noSoportada?: string | null;
  categoria?: string;
}

export const MAX_RECOMENDADAS = 3;

/**
 * Parte la lista en "las que sirven para ESTE pedido" y el resto.
 *
 * ⛔ **No esconde ninguna.** El resto va detrás de un "ver todas", no a la
 * basura: el propio `plantillasMeta.ts` ya lo decía —*"esconder una plantilla
 * aprobada sería decidir por la asesora con una regexp"*— y sigue valiendo. Lo
 * que cambia es que ahora hay un ORDEN con significado en vez de 40 botones
 * iguales.
 *
 * Recomendada = matchea uno de los patrones de la acción de su fase Y Guardian
 * la puede mandar. Una bloqueada nunca se recomienda: ofrecerla arriba, grande,
 * y que al tocarla diga "esta se manda desde ImporChat" es peor que no
 * ofrecerla.
 */
export function partirPlantillas<T extends PlantillaOrdenable>(
  plantillas: readonly T[],
  estado: string | null | undefined,
): { recomendadas: T[]; resto: T[] } {
  const accion = accionPrincipal(estado);
  if (!accion) return { recomendadas: [], resto: [...plantillas] };

  const recomendadas: T[] = [];
  const usadas = new Set<string>();
  // Por patrón y en orden: así la primera recomendada es la de la situación más
  // específica (el aviso de llegada antes que el recordatorio de vencimiento).
  for (const patron of accion.plantillas) {
    for (const p of plantillas) {
      if (recomendadas.length >= MAX_RECOMENDADAS) break;
      if (usadas.has(p.nombre) || p.noSoportada) continue;
      if (patron.test(sinTildes(p.nombre))) { recomendadas.push(p); usadas.add(p.nombre); }
    }
    if (recomendadas.length >= MAX_RECOMENDADAS) break;
  }
  return { recomendadas, resto: plantillas.filter((p) => !usadas.has(p.nombre)) };
}

/** La plantilla que usaría el botón de acción principal, o null si la cuenta no
 *  tiene ninguna que sirva. Es la primera recomendada — misma decisión, un solo
 *  lugar, para que el botón y la lista nunca ofrezcan cosas distintas. */
export function plantillaParaAccion<T extends PlantillaOrdenable>(
  plantillas: readonly T[],
  estado: string | null | undefined,
): T | null {
  return partirPlantillas(plantillas, estado).recomendadas[0] ?? null;
}

import { classifySegEstado, esColaDeConfirmacion, type SegStatusKey } from './segStatus';

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
  plantillas: readonly PatronPlantilla[];
}

/**
 * Un patrón de plantilla, y —cuando hace falta— el texto que le corresponde.
 *
 * ── Por qué el texto puede depender de la plantilla (2-sep-2026) ────────────
 * La fase pone UNA etiqueta para todas sus plantillas, y eso alcanza mientras
 * todas digan lo mismo. En Colombia deja de alcanzar: la fase `novedad` promete
 * *"Preguntarle la dirección"*, pero la única plantilla que la cuenta tiene y
 * Guardian puede completar es `novedad_recordatorio_v2`, que **no pregunta
 * nada** — le recuerda al cliente que su pedido está frenado. Con una sola
 * etiqueta, el botón prometía una cosa, mandaba otra y firmaba la primera en la
 * bitácora ("Coordiné nueva entrega"): exactamente el bug que este mismo
 * archivo documenta para las fases `guia`/`bodega_trans` de Ecuador.
 *
 * Un `RegExp` suelto sigue valiendo y usa el texto de la fase — que es el caso
 * de casi todas.
 */
export interface PatronConTexto {
  patron: RegExp;
  /** Reemplaza `AccionFase.etiqueta` cuando gana ESTA plantilla. */
  etiqueta?: string;
  /** Reemplaza `AccionFase.gestion` cuando gana ESTA plantilla. */
  gestion?: string;
}

export type PatronPlantilla = RegExp | PatronConTexto;

const soloPatron = (p: PatronPlantilla): RegExp => (p instanceof RegExp ? p : p.patron);

/**
 * ⛔ Solo las fases donde hay UNA acción obvia. `otros`, `entregado`,
 * `cancelado` e `indemnizada` quedan fuera a propósito: sin una acción clara,
 * un botón grande que manda un WhatsApp es peor que ningún botón.
 */
const ACCION_POR_FASE: Partial<Record<SegStatusKey, AccionFase>> = {
  oficina: {
    etiqueta: 'Avisarle que llegó a la agencia',
    gestion: 'Avisé: en oficina',
    // Ecuador las llama `retiro_agencia*`; Colombia, `seguimiento_*_oficina*`.
    // Los dos nombres viven acá y NO se mezclan con el patrón genérico del
    // final: ese último atrapa también `novedad_reclamo_oficina_1_utilidad`,
    // que NO es "tu paquete te espera" sino "se registró una novedad" — y era
    // el que ganaba en Colombia, además de ser incompletable, así que el botón
    // se apagaba (medido el 2-sep-2026 sobre la cuenta real).
    plantillas: [
      /retiro_agencia_disponible/, /retiro_agencia(?!_recordatorio)/, /retiro_agencia/,
      /seguimiento_reclamo_oficina/, /seguimiento_en_oficina/,
      /agencia|oficina|retiro/,
    ],
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
    // `en_reparto` es como lo nombra Colombia. Va DESPUÉS de `en_camino_hoy`
    // (Ecuador) porque el orden de esta lista es la preferencia, no el país: si
    // una cuenta tuviera las dos, gana la que promete el día.
    plantillas: [/en_camino_hoy/, /seguimiento_en_reparto/, /en_reparto|reparto/, /zona_entrega/, /en_transito|transito/],
  },
  transito: {
    etiqueta: 'Avisarle que va en camino',
    gestion: 'Avisé que va en camino',
    // ⛔ NO lleva `en_camino_hoy` (28-ago-2026). EN TRÁNSITO significa que el
    // paquete viaja, no que llega hoy — y la cuenta de Ecuador no tiene todavía
    // una plantilla de tránsito que Guardian pueda completar (`en_transito_v2`
    // pide el n° de orden y la ciudad, que no sabe llenar). Con el patrón puesto,
    // la fase caía a *"¡hoy es el día! su pedido sale a entrega"*: una promesa
    // falsa, y prometer una entrega que no llega es la vía corta a que el
    // cliente cancele. Sin plantilla el botón se esconde y queda la botonera
    // declarativa — mejor sin botón que un botón que miente.
    plantillas: [/en_transito|transito/, /zona_entrega/],
  },
  novedad: {
    etiqueta: 'Preguntarle la dirección',
    gestion: 'Coordiné nueva entrega',
    // ⛔ El recordatorio va SEPARADO y con su propio texto. En Colombia es la
    // única de novedad que Guardian puede completar entera —las dos buenas
    // (`novedad_generica_v2`, `novedad_general_v2_utilidad`) piden "indícanos:
    // {{6}}", o sea QUÉ dato reclamarle, que depende de la novedad y nadie
    // decidió— y no pregunta nada: le recuerda al cliente que su pedido está
    // frenado. Con la etiqueta de la fase, el botón decía "Preguntarle la
    // dirección" y firmaba "Coordiné nueva entrega" sobre un mensaje que no
    // hace ninguna de las dos cosas.
    plantillas: [
      /novedad(?!_recordatorio)/,
      /direccion_incompleta|direccion/,
      {
        patron: /novedad_recordatorio/,
        etiqueta: 'Recordarle que su pedido está frenado',
        gestion: 'Le recordé la novedad',
      },
    ],
  },
  novedad_sol: {
    etiqueta: 'Confirmarle la nueva entrega',
    gestion: 'Coordiné nueva entrega',
    plantillas: [
      /novedad(?!_recordatorio)/,
      /en_camino_hoy|zona_entrega/,
      // Mismo motivo que en `novedad`: el recordatorio no confirma nada.
      { patron: /novedad_recordatorio/, etiqueta: 'Recordarle que su pedido está frenado', gestion: 'Le recordé la novedad' },
    ],
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
    plantillas: [
      /rescate_devolucion|rescate/, /ultima_oportunidad/, /novedad(?!_recordatorio)/,
      // Mismo motivo que en `novedad`: el recordatorio no pregunta nada.
      { patron: /novedad_recordatorio/, etiqueta: 'Recordarle que su pedido está frenado', gestion: 'Le recordé la novedad' },
    ],
  },
};

/** La acción principal para ESE pedido, o null si su fase no tiene una obvia. */
export function accionPrincipal(estado: string | null | undefined): AccionFase | null {
  if (!estado) return null;
  return ACCION_POR_FASE[classifySegEstado(estado)] ?? null;
}

/**
 * La acción **ajustada a la plantilla que realmente va a salir**.
 *
 * ⛔ El botón tiene que decir lo que manda y la bitácora tiene que firmar lo
 * que se hizo. Cuando la plantilla ganadora trae su propio texto (ver
 * `PatronConTexto`), manda ese; si no, el de la fase, que es lo de siempre.
 *
 * Sin `nombre` —todavía no se sabe cuál va a ser— devuelve el de la fase: es lo
 * más honesto que se puede decir con lo que hay.
 */
export function accionDePlantilla(
  estado: string | null | undefined,
  nombre: string | null | undefined,
): AccionFase | null {
  const base = accionPrincipal(estado);
  if (!base || !nombre) return base;
  const n = sinTildes(String(nombre));
  for (const regla of base.plantillas) {
    if (!soloPatron(regla).test(n)) continue;
    if (regla instanceof RegExp) return base;
    return {
      ...base,
      etiqueta: regla.etiqueta ?? base.etiqueta,
      gestion: regla.gestion ?? base.gestion,
    };
  }
  return base;
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
  { prueba: /en_reparto|reparto/, etiqueta: 'Avisarle que ya salió a entrega' },
  { prueba: /direccion_incompleta|direccion/, etiqueta: 'Pedirle la dirección completa' },
  { prueba: /novedad/, etiqueta: 'Avisarle que no lo pudieron entregar' },
  // ⛔ VA DESPUÉS DE `novedad` A PROPÓSITO. Colombia tiene
  // `novedad_reclamo_oficina_1_utilidad`, que se llama "oficina" pero es un
  // aviso de NOVEDAD ("se registra una novedad en el proceso de entrega"). Si
  // esta fila subiera, se anunciaría como "llegó a la agencia" — una noticia
  // buena sobre un problema.
  { prueba: /oficina/, etiqueta: 'Avisarle que llegó a la agencia' },
  // El nombre solo dice "seguimiento" + "recordatorio", así que la etiqueta
  // dice exactamente eso y nada más. La de Colombia habla de un retiro en
  // oficina, pero eso está en el CUERPO y acá solo se lee el nombre:
  // deducirlo sería inventarle el tema a un mensaje que le llega a un cliente.
  { prueba: /^seguimiento_recordatorio/, etiqueta: 'Recordarle que lo tiene pendiente' },
  { prueba: /rescate_devolucion|rescate/, etiqueta: 'Ofrecerle reenviárselo antes de que se devuelva' },
  { prueba: /seguimiento_reactivar|reactivar/, etiqueta: 'Retomar el pedido que quedó frío' },
  { prueba: /ultima_oportunidad/, etiqueta: 'Última oportunidad antes de cancelar' },
  // Ecuador la nombra `recordatorio_confirmacion`; Colombia, al revés
  // (`confirmacion_recordatorio_1_v2_utilidad`). Sin las dos formas, 4 de las 8
  // de confirmación de la cuenta colombiana se leían "Pedirle que confirme el
  // pedido" — o sea, el primer aviso y el recordatorio con el mismo nombre.
  { prueba: /reconfirmacion|recordatorio_confirmacion|confirmacion(es)?_recordatorio/, etiqueta: 'Volver a pedirle que confirme' },
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
  /** Los huecos `{{n}}` de la plantilla. Solo se usa la CANTIDAD, para desempatar
   *  entre dos que sirven igual — ver `partirPlantillas`. */
  variables?: readonly unknown[];
  /** Los botones de respuesta rápida. Solo se usa si HAY o no, para desempatar:
   *  un botón es un toque, y el objetivo del dueño es que contesten. */
  botones?: readonly unknown[];
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
  /** ¿Guardian puede llenarle TODOS los huecos con los datos del pedido? Las
   *  que sí se suben primero. Ver `plantillaParaAccion` para el porqué. */
  completable?: (p: T) => boolean,
): { recomendadas: T[]; resto: T[] } {
  const accion = accionPrincipal(estado);
  if (!accion) return { recomendadas: [], resto: [...plantillas] };

  const recomendadas: T[] = [];
  const usadas = new Set<string>();
  const agregar = (soloCompletables: boolean) => {
    // Por patrón y en orden: así la primera de cada pasada es la de la
    // situación más específica (el aviso de llegada antes que el recordatorio
    // de vencimiento).
    for (const regla of accion.plantillas) {
      const patron = soloPatron(regla);
      const candidatas = plantillas.filter((p) =>
        !usadas.has(p.nombre) && !p.noSoportada
        && !(soloCompletables && completable && !completable(p))
        && patron.test(sinTildes(p.nombre)));
      // ⛔ Dentro del MISMO patrón hay DOS desempates, en este orden:
      //
      // 1. **La que tiene BOTÓN de respuesta rápida** (28-ago-2026). El objetivo
      //    del dueño es *"que nos contesten y no nos dejen en visto"*, y un botón
      //    es UN toque contra escribir un mensaje. Efecto medido en la cuenta de
      //    Ecuador: `reparto` pasa de `en_camino_hoy_v1` (avisa y se despide) a
      //    `_v2`, que termina en *"¿Estará disponible hoy para recibirlo?"* con
      //    "Sí, estaré pendiente" / "Coordinar otra hora". La misma noticia, pero
      //    con una respuesta posible.
      //
      // 2. **La que usa más datos del pedido** (visto en producción el
      //    27-ago-2026). Antes ganaba la primera que llegara, o sea el orden
      //    alfabético de Meta, y para "en agencia" eso daba `retiro_agencia_k1`:
      //      "Estimado Cliente: Servientrega le notifica que su pedido esta listo
      //       para ser retirado en agencia: SERVIENTREGA"
      //    — sin nombre, sin producto, y con el hueco de la agencia relleno con
      //    la TRANSPORTADORA, así que ni siquiera le dice al cliente dónde ir.
      //    Al lado estaba `retiro_agencia_v1` (nombre + producto + la urgencia de
      //    que la agencia lo devuelve), que es la que evita la devolución.
      //
      // Ninguno de los dos pisa la prioridad de PATRÓN: un recordatorio de
      // vencimiento con botones no puede ganarle al primer aviso de llegada.
      const conBoton = (p: T) => ((p.botones?.length ?? 0) > 0 ? 1 : 0);
      for (const p of [...candidatas].sort((a, b) =>
        conBoton(b) - conBoton(a)
        || (b.variables?.length ?? 0) - (a.variables?.length ?? 0))) {
        if (recomendadas.length >= MAX_RECOMENDADAS) return;
        recomendadas.push(p);
        usadas.add(p.nombre);
      }
    }
  };
  // Dos pasadas: primero lo que se puede mandar de una, después el resto. Las
  // que necesitan que la asesora escriba un dato NO se descartan —en el diálogo
  // puede llenarlo a mano— pero van detrás.
  if (completable) agregar(true);
  agregar(false);
  return { recomendadas, resto: plantillas.filter((p) => !usadas.has(p.nombre)) };
}

/**
 * La plantilla que usa el botón de acción principal, o null si ninguna se puede
 * mandar sin intervención.
 *
 * ⛔ **`completable` no es opcional acá, y esa es la lección** (visto en
 * producción el 27-ago-2026). La primera versión devolvía la más específica sin
 * mirar si se podía llenar: para "en agencia" elegía
 * `retiro_agencia_disponible_k1`, que pide *"Plazo para retirar: {{4}} días"*.
 * Ese dato Guardian **tiene prohibido inventarlo** (depende de la
 * transportadora y del acuerdo — regla vieja de `plantillasMeta.ts`), así que
 * el botón NUNCA podía mandarla: cargaba, se daba cuenta, y se apagaba solo.
 *
 * La cuenta tenía al lado `retiro_agencia_v1` (nombre + producto) que se
 * completa entera con datos reales. Entre dos plantillas que sirven, la que se
 * puede mandar gana a la que suena mejor.
 */
export function plantillaParaAccion<T extends PlantillaOrdenable>(
  plantillas: readonly T[],
  estado: string | null | undefined,
  completable: (p: T) => boolean,
): T | null {
  const { recomendadas } = partirPlantillas(plantillas, estado, completable);
  return recomendadas.find(completable) ?? null;
}

// ── Las plantillas, agrupadas por la fase que atienden ─────────────────────
// (30-ago-2026, pedido del dueño: *"que salgan las plantillas predefinidas
// dependiendo de dónde esté el asesor: si está en retiro en oficina que le
// salgan esas primero, si está en guía generada lo mismo, si está en reparto
// que le salga esa; y si quiere enviar otra, que la busque"*.)
//
// Antes del grupo, la lista completa era una nube de 40 chips planos: la
// asesora tenía que leer las 40 para encontrar la de agencia. Ahora cada
// plantilla pertenece a UN grupo (primera regla que matchea, mismo molde que
// `ETIQUETAS`) y el grupo de la fase del pedido va primero.

export type GrupoPlantillaClave =
  | 'agencia' | 'guia' | 'reparto' | 'novedad' | 'rescate'
  | 'confirmacion' | 'entregado' | 'promo' | 'otras';

interface ReglaGrupo {
  clave: GrupoPlantillaClave;
  titulo: string;
  prueba: RegExp;
  /** Aunque `prueba` matchee, esta fila NO gana si el nombre matchea acá.
   *  Existe para las plantillas cuyo nombre nombra DOS cosas — ver `agencia`. */
  excepto?: RegExp;
}

/** ORDENADA: la primera que matchea gana. `antes_generar_guia` cae en «guía»
 *  aunque también diga "generar"; `remarketing_despacho_listo` cae en «en
 *  camino» porque habla del despacho, no de la promoción. */
const GRUPOS: readonly ReglaGrupo[] = [
  // ⛔ `excepto` en vez de reordenar la lista (2-sep-2026). Colombia tiene
  // `novedad_reclamo_oficina_1_utilidad`: se llama "oficina" pero avisa una
  // NOVEDAD, y caía en «Retiro en agencia», donde la asesora la agarraría
  // creyendo que le dice al cliente que su paquete está listo para recoger.
  //
  // El primer arreglo fue subir la fila de `novedad` arriba de esta — y rompió
  // Ecuador, porque ESTA MISMA LISTA es también el orden en que se DIBUJAN los
  // grupos (`agruparPlantillas`): las pantallas sin fase propia pasaban a
  // abrir con "Novedad y dirección" en vez de "Retiro en agencia". Lo agarró
  // `accionSeguimiento.test.ts`. Son dos cosas distintas y ahora se tratan
  // distinto: el orden de la lista es el de PANTALLA, y la excepción de
  // clasificación vive en la fila que la necesita.
  { clave: 'agencia', titulo: 'Retiro en agencia', prueba: /retiro|agencia|oficina/, excepto: /novedad/ },
  { clave: 'guia', titulo: 'Guía y despacho', prueba: /guia/ },
  { clave: 'reparto', titulo: 'En camino y entrega', prueba: /en_camino|zona_entrega|transito|despacho_listo|reparto/ },
  { clave: 'novedad', titulo: 'Novedad y dirección', prueba: /novedad|direccion/ },
  { clave: 'rescate', titulo: 'Rescate y devolución', prueba: /rescate|reactivar|ultima_oportunidad/ },
  { clave: 'confirmacion', titulo: 'Confirmación del pedido', prueba: /confirmacion|reconfirmacion/ },
  { clave: 'entregado', titulo: 'Entregado', prueba: /entregado/ },
  { clave: 'promo', titulo: 'Promoción y reactivación', prueba: /remarketing|remarketin|carrito|descuento|envio_gratis|stock|ecommerce/ },
];
const GRUPO_OTRAS: ReglaGrupo = { clave: 'otras', titulo: 'Otras', prueba: /./ };

export function grupoPlantilla(nombre: string | null | undefined): ReglaGrupo {
  const n = sinTildes(String(nombre || ''));
  return GRUPOS.find((g) => g.prueba.test(n) && !g.excepto?.test(n)) ?? GRUPO_OTRAS;
}

/** El grupo que atiende cada fase del kanban. Sin entrada = la fase no tiene
 *  un grupo propio (otros, cancelado, indemnizada): los grupos salen en el
 *  orden de siempre. */
const GRUPO_POR_FASE: Partial<Record<SegStatusKey, GrupoPlantillaClave>> = {
  oficina: 'agencia',
  guia: 'guia',
  bodega_trans: 'guia',
  procesamiento: 'guia',
  transito: 'reparto',
  reparto: 'reparto',
  novedad: 'novedad',
  novedad_sol: 'novedad',
  devolucion: 'rescate',
  devolucion_transito: 'rescate',
  rechazado: 'rescate',
  entregado: 'entregado',
};

/** Cómo se dice la fase en el encabezado del selector ("Para este pedido ·
 *  en agencia"). Va en minúscula porque sigue a un punto medio. */
const FASE_EN_PALABRAS: Partial<Record<SegStatusKey, string>> = {
  oficina: 'en agencia',
  guia: 'con guía generada',
  bodega_trans: 'en bodega de la transportadora',
  procesamiento: 'en procesamiento',
  transito: 'en tránsito',
  reparto: 'en reparto',
  novedad: 'con novedad',
  novedad_sol: 'con novedad solucionada',
  devolucion: 'en devolución',
  devolucion_transito: 'devolviéndose',
  rechazado: 'rechazado',
  entregado: 'entregado',
};

/**
 * La fase con la que se ORDENAN las plantillas de Meta.
 *
 * Casi siempre es la fase del tablero, con UNA excepción que costó meses de
 * plantillas mal ordenadas: la cola de Confirmar (`PENDIENTE CONFIRMACION`)
 * cae en `otros` a propósito, y `POR_FASE` no tiene —ni debe tener— esa clave,
 * porque ahí caen también los estados que Dropi inventa. Se traduce acá a
 * `procesamiento`, que es la fila cuya regex ya apunta a
 * `confirmacion|reconfirmacion|direccion_incompleta`.
 *
 * Usala SIEMPRE en lugar de `classifySegEstado` para alimentar
 * `usePlantillasMeta` / `ordenarParaFase`.
 */
export function faseParaPlantillas(estado: string | null | undefined): SegStatusKey {
  if (esColaDeConfirmacion(estado)) return 'procesamiento';
  return classifySegEstado(estado || '');
}

export function faseEnPalabras(estado: string | null | undefined): string | null {
  if (!estado) return null;
  return FASE_EN_PALABRAS[classifySegEstado(estado)] ?? null;
}

export interface GrupoDePlantillas<T> {
  clave: GrupoPlantillaClave;
  titulo: string;
  /** Es el grupo de la FASE de este pedido: va primero y se marca. */
  deLaFase: boolean;
  plantillas: T[];
}

/**
 * Parte la lista en grupos, con el de la fase del pedido PRIMERO y el resto
 * en el orden de `GRUPOS`. Dentro de cada grupo se respeta el orden de
 * entrada (que ya viene de `ordenarParaFase`), salvo que las bloqueadas van
 * al final: no sirven para tocar, solo para saber que existen.
 * Los grupos vacíos no salen — un encabezado sin filas es ruido.
 */
export function agruparPlantillas<T extends PlantillaOrdenable>(
  plantillas: readonly T[],
  estado: string | null | undefined,
): GrupoDePlantillas<T>[] {
  const claveFase = !estado
    ? null
    // La cola de Confirmar no es una fase del tablero (cae en `otros`), pero SÍ
    // tiene un grupo propio y es la pantalla donde más se escribe: va primero.
    // Un estado desconocido, en cambio, sigue sin grupo — ver `esColaDeConfirmacion`.
    : esColaDeConfirmacion(estado)
      ? 'confirmacion'
      : GRUPO_POR_FASE[classifySegEstado(estado)] ?? null;
  const porClave = new Map<GrupoPlantillaClave, T[]>();
  for (const p of plantillas) {
    const g = grupoPlantilla(p.nombre).clave;
    const arr = porClave.get(g) ?? [];
    arr.push(p);
    porClave.set(g, arr);
  }
  const orden: ReglaGrupo[] = [...GRUPOS, GRUPO_OTRAS];
  if (claveFase) {
    const i = orden.findIndex((g) => g.clave === claveFase);
    if (i > 0) orden.unshift(...orden.splice(i, 1));
  }
  const bloqueadaAlFinal = (a: T, b: T) => Number(!!a.noSoportada) - Number(!!b.noSoportada);
  return orden
    .map((g) => ({
      clave: g.clave,
      titulo: g.titulo,
      deLaFase: g.clave === claveFase,
      plantillas: [...(porClave.get(g.clave) ?? [])].sort(bloqueadaAlFinal),
    }))
    .filter((g) => g.plantillas.length > 0);
}

/**
 * Buscar por lo que la asesora escribe: el nombre en español, el nombre de
 * Meta o un pedazo del cuerpo. Sin tildes ni mayúsculas. Vacío = todas.
 */
export function filtrarPlantillas<T extends PlantillaOrdenable & { cuerpo?: string }>(
  plantillas: readonly T[],
  consulta: string,
): T[] {
  const q = sinTildes(consulta).trim();
  if (!q) return [...plantillas];
  const palabras = q.split(/\s+/).filter(Boolean);
  return plantillas.filter((p) => {
    const pajar = sinTildes(`${nombreVisible(p.nombre)} ${p.nombre} ${p.cuerpo ?? ''}`);
    return palabras.every((w) => pajar.includes(w));
  });
}

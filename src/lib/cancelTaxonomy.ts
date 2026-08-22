/**
 * Taxonomía de CANCELACIONES: clasifica el motivo (`order_results.reason`) en una
 * categoría fina + una "culpa" (a quién es atribuible) + un TIPO económico.
 *
 * Mismo patrón que `classifyNovedad` (novedadTaxonomy.ts) y que `mapCategoria`
 * (dropi-wallet-sync): normalizar (sin acentos, mayúsculas) → tabla de reglas
 * declarativa ordenada (la primera que matchea gana) → catch-all explícito.
 * 100% puro y determinista → testeable aislado.
 *
 * POR QUÉ TRES EJES Y NO UNO
 * La lista vieja de motivos mezclaba tres preguntas en un solo campo y por eso no
 * servía para decidir. Acá se separan:
 *   - `categoria` → QUÉ pasó (el motivo, cara al cliente)
 *   - `culpa`     → DE QUIÉN fue (define si se arregla la operación o el anuncio)
 *   - `tipo`      → CUÁNTO DUELE (evitable / inevitable / ahorro / recreado)
 *
 * `tipo: 'ahorro'` es la clave del negocio: cancelar por "mal historial" o
 * "duplicado" EVITÓ una devolución (~$22k). Contarlo en la misma tasa que una
 * venta perdida esconde la plata. El día que esto entra, sin tocar una fila del
 * histórico, `Mal historial` + `Duplicado` + `No pagó anticipo` salen de "pérdida".
 *
 * `tipo: 'desconocido'` existe porque una cancelación hecha en el panel de Dropi
 * NO deja motivo (no hay fila en `order_results`). Meterla en evitable o en
 * inevitable sería inventar el dato. Este bucket se achica solo a medida que la
 * captura mejora, y esa reducción ES el KPI del proyecto.
 *
 * RETRO-COMPATIBILIDAD SIN BACKFILL: las reglas capturan también los 7 valores
 * viejos del picklist y el string que escribe ConfirmarTab al cancelar duplicados
 * automáticamente, así el histórico queda utilizable sin tocar una sola fila.
 *
 * IMPORTANTE: este set es un PUNTO DE PARTIDA con vocabulario COD conocido. Hay
 * que afinarlo con el texto REAL de producción (query `SELECT reason, COUNT(*)
 * FROM order_results WHERE result='canc' GROUP BY 1 ORDER BY 2 DESC`, POR TIENDA)
 * hasta que el catch-all no-genérico baje del ~10%. Los modismos regionales de
 * EC/GT van a caer al catch-all al principio: eso no es un bug, es la lista de
 * tareas de la próxima iteración. Los tokens van SIN acentos porque `norm()` los
 * elimina.
 */

import { stripAccents } from './novedadGestion';

/** A quién es atribuible la cancelación. Define QUÉ se arregla. */
export type CancelCulpa =
  /** El cliente decidió: se arrepintió, no contesta, no tiene plata. */
  | 'cliente'
  /** La oferta: precio, flete, o la promesa del anuncio ≠ la realidad. */
  | 'precio_oferta'
  /** Nosotros: llamamos tarde, se demora, datos mal cargados, sin stock. */
  | 'operacion'
  /** La transportadora: no hay cobertura, no llega a esa zona. */
  | 'transportadora'
  /** El lead nunca fue real: no lo pidió, clic accidental, un menor. Plata de PAUTA. */
  | 'trafico'
  /** NOSOTROS decidimos no venderle (mal historial, duplicado, sin anticipo). */
  | 'filtro_interno'
  /** Sin motivo o no clasificable. */
  | 'generica';

/** Impacto económico. Responde "¿esto es plata perdida?". */
export type CancelTipo =
  /** Con otra ejecución se salvaba → es plata sobre la mesa. */
  | 'perdida_evitable'
  /** Se perdió y no había qué hacer. */
  | 'perdida_inevitable'
  /** Cancelar FUE la decisión correcta: evitó una devolución. */
  | 'ahorro'
  /**
   * NI pérdida NI ahorro: el pedido se recreó con otro id (cambio de
   * transportadora, edición, reemplazo). No evitó ninguna devolución, así que
   * llamarlo "ahorro" —como estaba— mezclaba dos cosas opuestas en la misma
   * tarjeta, cuyo texto al pie nombra "duplicados / mal historial".
   */
  | 'recreado'
  /** No hay motivo → NO se inventa un bucket. */
  | 'desconocido';

export interface CancelClass {
  /** Subtipo fino, ej. 'precio_flete'. 'otro' cuando cae al catch-all. */
  categoria: string;
  culpa: CancelCulpa;
  tipo: CancelTipo;
  /**
   * false = NO pertenece al denominador de la tasa de cancelación. El pedido no
   * se perdió: se recreó con otro external_id (cambio de transportadora, edición
   * que obliga a recrear en Dropi). Meterlo en la tasa es contar dos veces la
   * misma venta.
   */
  cuentaEnTasa: boolean;
  /** true cuando el texto no aporta info útil (ruido) o no clasificó. */
  esGenerica: boolean;
}

/**
 * Lo que ve el dueño cuando abre la pantalla y quiere saber **de qué lado está
 * el problema**.
 *
 * Las etiquetas viejas describían el bucket ("Precio / oferta", "Tráfico (lead
 * no real)"). Éstas dicen **qué pasó y dónde ir a mirar**, porque el que abre
 * este reporte no está clasificando: está decidiendo qué toca arreglar. Cada
 * culpa tiene obligatoriamente las dos cosas — lo fija
 * `src/test/etiquetasCancelacion.test.ts`.
 */
export interface CulpaInfo {
  /** Título del bloque. Corto: entra en una barra. */
  label: string;
  /** Qué significa, en una frase, sin jerga. */
  que: string;
  /** A dónde va el dueño con esta información. */
  dondeMirar: string;
}

export const CANCEL_CULPA_INFO: Record<CancelCulpa, CulpaInfo> = {
  generica: {
    label: 'Nadie anotó por qué',
    que: 'Se canceló fuera del CRM o sin dejar motivo.',
    dondeMirar: 'No es una nota al pie: mientras este bloque sea el más grande, todo lo demás se decide a ciegas.',
  },
  precio_oferta: {
    label: 'El anuncio prometió otra cosa',
    que: 'El precio, el flete o lo que mostraba la publicidad no coincidió con la realidad.',
    dondeMirar: 'El creativo del anuncio y la ficha del producto.',
  },
  operacion: {
    // 'Nosotros' a secas era la única etiqueta de culpa que no era una oración,
    // entre seis que sí lo son.
    label: 'Fue de nuestro lado',
    que: 'Llamamos tarde, se demoró el despacho, faltó stock o los datos se cargaron mal.',
    dondeMirar: 'La cola de Confirmar y los tiempos de despacho.',
  },
  trafico: {
    label: 'El pedido nunca fue real',
    que: 'Clic accidental, número ajeno o alguien que no pidió nada. Es plata de pauta quemada.',
    dondeMirar: 'La segmentación de la pauta y el formulario de compra.',
  },
  cliente: {
    label: 'El cliente cambió de idea',
    que: 'Se arrepintió, no tenía plata en ese momento o no se lo autorizaron en la casa.',
    dondeMirar: 'Casi nada de esto se salva llamando más rápido.',
  },
  transportadora: {
    // Decía 'No llegamos a su zona' — 1ª persona plural para algo que esta
    // misma culpa atribuye a la TRANSPORTADORA.
    label: 'La transportadora no llega ahí',
    que: 'La transportadora no tiene cobertura en ese destino.',
    dondeMirar: 'La cobertura por ciudad y las transportadoras alternativas.',
  },
  filtro_interno: {
    label: 'Lo cancelamos a propósito',
    que: 'Duplicado, mal historial o sin anticipo. Cancelar evitó una devolución.',
    dondeMirar: 'Esto NO es una pérdida: es plata ahorrada.',
  },
};

/** Etiqueta sola. Se deriva de `CANCEL_CULPA_INFO` para que no existan dos
 *  listas que puedan separarse. */
export const CANCEL_CULPA_LABEL: Record<CancelCulpa, string> = Object.fromEntries(
  Object.entries(CANCEL_CULPA_INFO).map(([k, v]) => [k, v.label]),
) as Record<CancelCulpa, string>;

/**
 * Orden estable para gráficos: de lo más accionable internamente a lo menos.
 * `generica` va último porque no es una causa, es un dato faltante.
 */
export const CANCEL_CULPA_ORDER: CancelCulpa[] = [
  'operacion', 'precio_oferta', 'trafico', 'cliente',
  'transportadora', 'filtro_interno', 'generica',
];

export const CANCEL_TIPO_LABEL: Record<CancelTipo, string> = {
  perdida_evitable: 'Pérdida evitable',
  perdida_inevitable: 'Pérdida inevitable',
  ahorro: 'Ahorro (estuvo bien cancelar)',
  recreado: 'No se perdió: se rehizo el pedido',
  desconocido: 'Sin clasificar',
};

/**
 * Orden para la UI: lo evitable primero (es lo accionable) y `desconocido`
 * segundo, porque un bucket grande de "sin clasificar" es en sí mismo el problema
 * a resolver, no una nota al pie.
 */
export const CANCEL_TIPO_ORDER: CancelTipo[] = [
  'perdida_evitable', 'desconocido', 'perdida_inevitable', 'ahorro', 'recreado',
];

/**
 * Etiqueta legible por categoría. La UI NO inventa nombres: los lee de acá.
 *
 * ── UNA SOLA VOZ: frase nominal, sin sujeto tácito ────────────────────────
 * Antes convivían cuatro: el cliente en 3ª ("Se arrepintió"), nosotros en 1ª
 * plural ("Llamamos tarde"), sustantivos sueltos ("Duplicado") y —lo peor—
 * `sin_motivo: 'Canceló sin anotar motivo'`, donde el sujeto tácito es LA
 * ASESORA pero se lee como si hubiera cancelado el cliente. Es el bucket más
 * grande del reporte: que se lea al revés es caro.
 *
 * Tres razones para la frase nominal:
 *   1. La etiqueta se dibuja al lado de un número, en una barra angosta. Un
 *      sustantivo entra; una oración se corta.
 *   2. El "de quién fue" ya lo dice `CANCEL_CULPA_INFO`, que sí es narrativo
 *      por diseño. Repetir el sujeto acá generaba contradicciones: la categoría
 *      decía "No llega a su zona" y su culpa "No llegamos a su zona".
 *   3. Es la única forma de que `sin_motivo` deje de acusar al cliente.
 */
export const CANCEL_CATEGORIA_LABEL: Record<string, string> = {
  // filtro interno / ahorro
  duplicado: 'Pedido duplicado',
  prueba_interna: 'Pedido de prueba',
  mal_historial: 'Cliente con mal historial',
  sin_anticipo: 'Anticipo no pagado',
  // no cuentan en la tasa (el pedido se recreó)
  cambio_transportadora: 'Cambio de transportadora',
  recreado_edicion: 'Recreado por edición',
  recreado_externo: 'Pedido rehecho (volvió a entrar)',
  // operación
  llamada_tardia: 'Llamada tardía',
  demora_entrega: 'Demora en la entrega',
  datos_malos: 'Teléfono o datos malos',
  sin_stock: 'Sin stock',
  // precio y oferta
  precio_flete: 'Precio o flete caro',
  compro_en_otro_lado: 'Compra en otro lado',
  promesa_no_cumplida: 'Distinto a lo del anuncio',
  // cliente
  no_contesta: 'Sin respuesta',
  sin_dinero: 'Sin plata en este momento',
  arrepentido: 'Arrepentimiento',
  familiar_no_autoriza: 'Sin autorización en la casa',
  fuerza_mayor: 'Fuerza mayor (viaje, salud)',
  // tráfico
  no_reconoce_pedido: 'Pedido no reconocido',
  // transportadora
  sin_cobertura: 'Zona sin cobertura',
  // el cliente nunca usó el chat
  sin_whatsapp: 'Sin contacto por WhatsApp',
  // faltantes de dato
  sin_motivo: 'Cancelado sin motivo anotado',
  externo_dropi: 'Cancelado fuera del CRM',
  otro: 'Motivo escrito que no clasificó',
};

interface Rule {
  categoria: string;
  culpa: CancelCulpa;
  tipo: CancelTipo;
  /** Default true. false = el pedido se recreó, no se perdió. */
  cuentaEnTasa?: boolean;
  /** Al menos uno de estos tokens (ya normalizados) presente. */
  any?: string[];
  /**
   * Al menos uno de estos tokens presente como PALABRA COMPLETA.
   *
   * Existe por un falso positivo caro: `'CARO'` como subcadena matchea dentro
   * de todos los verbos en -caron. Medido, con el código real: "se
   * equivo**caro**n de pedido", "me expli**caro**n mal el producto",
   * "colo**caro**n mal la direccion" y "nunca lo bus**caro**n en la oficina"
   * caían las cuatro en `precio_flete`. O sea que cuatro fallas NUESTRAS se
   * reportaban como "el precio está caro" — y `precio_flete` es justamente la
   * categoría que manda a cambiar el anuncio.
   */
  anyWord?: string[];
  /** Todos estos tokens presentes (combinable con `any`). */
  all?: string[];
}

/**
 * Ruido conocido: textos sin información útil. Se tratan como genéricos (es un
 * problema de captura, NO una regla faltante — la diferencia importa porque una
 * se arregla entrenando y la otra escribiendo código).
 * En forma normalizada (mayúsculas, sin acentos).
 */
const GENERIC_NOISE = new Set<string>([
  '', '-', '--', '.', '..', '...', 'X', 'XX', 'XXX', 'NA', 'N/A', 'NO',
  'NINGUNO', 'NINGUNA', 'OTRO', 'OTROS', 'SIN MOTIVO', 'NO APLICA',
  'CANCELADO', 'CANCELACION', 'CANCELAR', 'SE CANCELA', 'CLIENTE', 'PEDIDO',
]);

/**
 * Largo mínimo para intentar clasificar. Es 3 y NO 4 como en novedades: acá
 * 'CARO' (4) es un motivo legítimo y perfectamente accionable.
 */
const MIN_LEN = 3;

/**
 * Reglas ordenadas — de lo más inequívoco/accionable a lo más difuso.
 *
 * ORDEN QUE IMPORTA (no reordenar sin correr el test):
 *  - `sin_anticipo` va ANTES que `no_contesta` para que "no contestó cuando lo
 *    llamamos por el anticipo" caiga en anticipo, que es la causa real.
 *  - Ninguna regla de recreado/cambio usa el token desnudo 'CAMBIO DE': si lo
 *    usara, se tragaría 'CAMBIO DE OPINION' (que es `arrepentido`).
 *  - `no_reconoce_pedido` va ANTES que `arrepentido` porque "no lo pidió" y
 *    "ya no lo quiere" se parecen en el texto pero son negocios opuestos: uno es
 *    plata de pauta mal gastada, el otro es una objeción de venta.
 */
const RULES: Rule[] = [
  // ═══ AHORRO — cancelar fue la decisión correcta (filtro NUESTRO) ═══
  { categoria: 'duplicado', culpa: 'filtro_interno', tipo: 'ahorro', any: [
    'DUPLICAD', 'REPETID', 'YA EXISTE EL PEDIDO', 'MISMO PEDIDO', 'DOBLE PEDIDO',
    'PEDIDO DOBLE', 'ORDEN REPETIDA',
  ] },
  { categoria: 'prueba_interna', culpa: 'filtro_interno', tipo: 'ahorro', any: [
    'PEDIDO DE PRUEBA', 'ES PRUEBA', 'PRUEBA INTERNA', 'ORDEN DE PRUEBA', 'TEST INTERNO',
  ] },
  { categoria: 'mal_historial', culpa: 'filtro_interno', tipo: 'ahorro', any: [
    'MAL HISTORIAL', 'MALA CALIFICACION', 'LISTA NEGRA', 'CLIENTE MOROSO',
    'YA DEVOLVIO', 'HISTORIAL DE DEVOLUC', 'NUNCA RECIBE', 'NO RECIBE NUNCA',
    'NO LE VENDEMOS', 'CLIENTE PROBLEMA',
  ] },
  { categoria: 'sin_anticipo', culpa: 'filtro_interno', tipo: 'ahorro', any: [
    // 'ADELANTO' suelto se sacó: "el cliente adelantó el viaje" y "se adelantó
    // la entrega" caían en `sin_anticipo` → `filtro_interno` → **ahorro**. Un
    // falso positivo acá no solo mal-clasifica: mueve plata de la columna
    // "pérdida" a la columna "ahorro", que es la que dice que estuvo bien.
    'ANTICIPO', 'NO ADELANTO', 'SIN ADELANTO', 'NO DIO EL ADELANTO',
    'NO CONSIGNO', 'NO HIZO EL ABONO', 'SIN ABONO',
  ] },

  // ═══ NO ES PÉRDIDA — el pedido se RECREÓ, no se perdió ═══
  { categoria: 'cambio_transportadora', culpa: 'operacion', tipo: 'recreado',
    cuentaEnTasa: false, any: [
    'CAMBIO DE TRANSPORTADORA', 'CAMBIO TRANSPORTADORA', 'OTRA TRANSPORTADORA',
    'CAMBIO DE CARRIER', 'CAMBIO DE TRANSPORT',
  ] },
  { categoria: 'recreado_edicion', culpa: 'operacion', tipo: 'recreado',
    cuentaEnTasa: false, any: [
    'SE RECREO', 'RECREAD', 'SE VOLVIO A CREAR', 'SE CREO DE NUEVO', 'REEMPLAZAD',
    'CAMBIO DE PRODUCTO', 'CAMBIO DE TALLA', 'CAMBIO DE COLOR',
    'CAMBIO DE DIRECCION', 'CAMBIO DE CANTIDAD', 'CAMBIO DE VALOR',
  ] },

  // ═══ OPERACIÓN — nuestro, y evitable ═══
  { categoria: 'llamada_tardia', culpa: 'operacion', tipo: 'perdida_evitable', any: [
    'LLAMAMOS TARDE', 'SE LLAMO TARDE', 'NADIE LO LLAMO', 'NUNCA LO LLAMARON',
    'TARDE PARA LLAMAR', 'SE LLAMO MUY TARDE', 'NO SE LLAMO A TIEMPO',
  ] },
  { categoria: 'demora_entrega', culpa: 'operacion', tipo: 'perdida_evitable', any: [
    'DEMORA', 'SE DEMOR', 'MUCHO TIEMPO', 'NUNCA LLEGO', 'NO LLEGO NUNCA',
    'FUERA DE TIEMPO', 'LO NECESITABA PARA', 'YA NO LO NECESITA', 'TARDA MUCHO',
    'LLEVA MUCHOS DIAS', 'SE TARDA',
  ] },
  { categoria: 'datos_malos', culpa: 'operacion', tipo: 'perdida_evitable', any: [
    'TELEFONO MALO', 'TELEFONO ERRADO', 'TELEFONO EQUIVOCADO', 'TELEFONO ERRONEO',
    'TELEFONO INVALIDO', 'TELEFONO NO EXISTE', 'NUMERO EQUIVOCADO', 'NUMERO ERRADO',
    'NUMERO NO EXISTE', 'SIN TELEFONO', 'DATOS INCOMPLETOS', 'NUMERO INVALIDO',
    // 'NUMERO INCORRECTO' es el texto libre más repetido de la muestra real de
    // agosto y caía en `otro` aunque estaban ERRADO, EQUIVOCADO y ERRONEO.
    'NUMERO INCORRECTO', 'TELEFONO INCORRECTO', 'CELULAR EQUIVOCADO',
    // 'DATOS FALSOS' / 'DIRECCION FALSA' se fueron a `no_reconoce_pedido`: un
    // dato FALSO no es un dato que nosotros cargamos mal, es un lead que no
    // existe. Tenerlos acá le cobraba a la operación una pérdida de pauta.
  ] },
  // El número no tiene WhatsApp. La categoría existía desde el 22-ago pero SOLO
  // se alcanzaba por la señal automática (`riesgoChat==='mudo'`): no había regla
  // de texto, así que cuando la asesora lo escribía —y lo escribe: 3 de los 12
  // `otro` de agosto son literalmente esto— caía en "sin clasificar".
  //
  // Culpa `trafico` y NO `operacion`: se decidió tratarlo igual que la señal
  // automática, porque el desenlace es el mismo (nunca hubo cómo hablarle) y
  // tener el mismo hecho en dos culpas distintas según quién lo detectó haría
  // imposible leer la portada.
  { categoria: 'sin_whatsapp', culpa: 'trafico', tipo: 'desconocido', any: [
    'NO TIENE WHATSAPP', 'NO TIENE WHASTAPP', 'NO TIENE WHASAPP', 'NO TIENE WSP',
    'SIN WHATSAPP', 'NO USA WHATSAPP', 'NO MANEJA WHATSAPP', 'NUMERO SIN WHATSAPP',
  ] },
  { categoria: 'sin_stock', culpa: 'operacion', tipo: 'perdida_evitable', any: [
    'SIN STOCK', 'AGOTAD', 'NO HAY INVENTARIO', 'SIN INVENTARIO', 'NO HAY UNIDADES',
    'PROVEEDOR NO TIENE', 'DESCONTINUAD',
  ] },

  // ═══ PRECIO / OFERTA ═══
  { categoria: 'precio_flete', culpa: 'precio_oferta', tipo: 'perdida_evitable',
    // CARO/CARA/COSTOSO van por PALABRA COMPLETA: como subcadena, 'CARO'
    // matcheaba dentro de todos los verbos en -caron ("se equivoCAROn de
    // pedido", "me expliCAROn mal", "coloCAROn mal la direccion", "nunca lo
    // busCAROn"). Cuatro fallas nuestras se reportaban como "está caro".
    anyWord: ['CARO', 'CARA', 'CAROS', 'CARAS', 'COSTOSO', 'COSTOSA'],
    any: [
      'PRECIO', 'EL FLETE', 'FLETE CARO', 'ENVIO CARO',
      'NO ESPERABA ESE VALOR', 'PENSO QUE ERA GRATIS', 'CREIA QUE ERA GRATIS',
      'MAS BARATO EN',
    ] },
  { categoria: 'compro_en_otro_lado', culpa: 'precio_oferta', tipo: 'perdida_evitable', any: [
    'YA LO COMPRO', 'LO COMPRO EN', 'LO CONSIGUIO', 'OTRA TIENDA', 'OTRA PAGINA',
    'YA LO TIENE', 'COMPRO EN OTRO',
  ] },
  // La ÚNICA categoría que apunta al creativo, y era la que nunca corría: sus
  // tokens exigían la frase exacta ('EL ANUNCIO DECIA', 'NO ERA LO QUE') y el
  // vocabulario real no la usa así. Cuatro de los 12 `otro` de agosto son esto:
  // "en la publicidad era otro modelo" · "quiere el modelo de la publicidad" ·
  // "no le gusta el diseño, quería las gafas del anuncio" · "no ERAN lo que
  // estaba en la publicidad" (este último fallaba por el PLURAL).
  { categoria: 'promesa_no_cumplida', culpa: 'precio_oferta', tipo: 'perdida_evitable', any: [
    'PUBLICIDAD', 'EL ANUNCIO', 'DEL ANUNCIO', 'OTRO MODELO', 'EL MODELO DE',
    'NO ERA EL MODELO', 'NO ERAN LO QUE', 'NO ERA LO QUE', 'NO ES LO QUE ESPERABA',
    'NO ES COMO LA FOTO', 'DISTINTO A LA FOTO', 'NO LE GUSTA EL DISENO',
    'PENSO QUE ERA OTRO', 'PENSABA QUE VENIA', 'CREYO QUE ERAN', 'OTRA CANTIDAD',
    'NO ES EL PRODUCTO',
  ] },

  // ═══ TRÁFICO — el lead nunca fue real (plata de PAUTA, no de la operadora) ═══
  { categoria: 'no_reconoce_pedido', culpa: 'trafico', tipo: 'perdida_inevitable', any: [
    'NO HIZO EL PEDIDO', 'NO REALIZO EL PEDIDO', 'NO PIDIO', 'NUNCA ORDENO', 'NO ORDENO',
    'NO RECONOCE', 'NO SABE DE QUE', 'FUE SIN QUERER', 'SE EQUIVOCO AL',
    'NO CONOCE LA TIENDA', 'EL NINO', 'UN MENOR', 'SU HIJO LO PIDIO',
    // Un dato FALSO lo puso el cliente, no nosotros: es plata de pauta quemada,
    // no una falla de carga. Antes vivían en `datos_malos` (operación/evitable).
    'DATOS FALSOS', 'DIRECCION FALSA', 'NOMBRE FALSO', 'PEDIDO FALSO',
    // 'POR ERROR' a secas se sacó: atrapaba errores NUESTROS ("la guía se
    // generó por error", "se canceló por error de la asesora") y se los cobraba
    // a la pauta como inevitables.
    'PIDIO POR ERROR', 'LO PIDIO POR ERROR', 'ORDENO POR ERROR',
  ] },

  // ═══ CLIENTE ═══
  { categoria: 'no_contesta', culpa: 'cliente', tipo: 'perdida_evitable', any: [
    'NO CONTESTA', 'NO CONTESTO', 'NO CONTESTARON', 'NO RESPONDE', 'NO ATIENDE',
    'SIN RESPUESTA', 'BUZON', 'ILOCALIZABLE', 'IMPOSIBLE CONTACTAR',
    'NO SE LOGRO CONTACT', 'APAGADO', 'FUERA DE SERVICIO', '3 INTENTOS', 'TRES INTENTOS',
  ] },
  { categoria: 'sin_dinero', culpa: 'cliente', tipo: 'perdida_evitable', any: [
    'NO TIENE DINERO', 'SIN DINERO', 'NO TIENE PLATA', 'SIN PLATA', 'NO TIENE EFECTIVO',
    'SIN EFECTIVO', 'NO TIENE CON QUE PAGAR', 'NO LE ALCANZA', 'SIN FONDOS',
    'HASTA QUE LE PAGUEN', 'QUINCENA', 'ESPERA EL PAGO',
  ] },
  { categoria: 'familiar_no_autoriza', culpa: 'cliente', tipo: 'perdida_inevitable', any: [
    'EL ESPOSO', 'LA ESPOSA', 'LA MAMA', 'EL PAPA', 'NO LO AUTORIZ', 'NO LO DEJAN',
    'NO LE DIERON PERMISO',
  ] },
  { categoria: 'fuerza_mayor', culpa: 'cliente', tipo: 'perdida_inevitable', any: [
    // 'VIAJE' a secas: el texto real "cancela por un viaje a Perú, vuelve en 2
    // meses" no matcheaba 'DE VIAJE' y caía en `otro`.
    'VIAJE', 'DE VIAJE', 'VIAJO', 'FALLECI', 'MURIO', 'ENFERM', 'HOSPITAL',
    'ACCIDENTE', 'EMERGENCIA', 'SE MUDO', 'CAMBIO DE CIUDAD', 'SE FUE DEL PAIS',
  ] },

  // ═══ TRANSPORTADORA ═══
  { categoria: 'sin_cobertura', culpa: 'transportadora', tipo: 'perdida_inevitable', any: [
    'SIN COBERTURA', 'NO HAY COBERTURA', 'FUERA DE COBERTURA', 'NO CUBREN', 'NO LLEGAN A',
    'NO LLEGA A SU ZONA', 'ZONA ROJA', 'ORDEN PUBLICO', 'DIFICIL ACCESO',
    'NO HAY DESPACHO A', 'NO ENTREGAN EN',
  ] },

  // ⚠️ `arrepentido` va AL FINAL del bloque de cliente, después de
  // familiar_no_autoriza / fuerza_mayor / sin_cobertura, y NO antes.
  //
  // Sus tokens ('NO QUIERE', 'NO DESEA', 'MEJOR NO') son la forma en que la
  // asesora ARRANCA la frase; la causa real viene después. Estando primero se
  // comía a las otras tres, y siempre para el mismo lado — de inevitable a
  // EVITABLE, o sea reclamándole al equipo algo que no podía evitar. Medido
  // con el código real:
  //   "no quiere porque el esposo no la autoriza"   -> arrepentido (era familiar)
  //   "cancela el pedido porque no llega a su zona" -> arrepentido (era cobertura)
  //   "el cliente cancela el pedido, esta de viaje" -> arrepentido (era fuerza mayor)
  //
  // 'CANCELA EL PEDIDO' se borró del todo: no es un motivo, es lo que escribe
  // todo el mundo antes de decir el motivo de verdad.
  { categoria: 'arrepentido', culpa: 'cliente', tipo: 'perdida_evitable', any: [
    'CAMBIO DE OPINION', 'YA NO QUIERE', 'YA NO LO QUIERE', 'NO LO QUIERE', 'NO QUIERE',
    'ARREPINT', 'DESISTE', 'NO DESEA', 'NO LE INTERESA', 'MEJOR NO',
    'LO PENSO MEJOR',
  ] },
];

/** El catch-all. Se devuelve tal cual desde dos lugares → una sola definición. */
const CATCH_ALL: CancelClass = {
  categoria: 'otro',
  culpa: 'generica',
  tipo: 'desconocido',
  cuentaEnTasa: true,
  esGenerica: true,
};

function norm(text: string): string {
  return stripAccents(text).toUpperCase().replace(/\s+/g, ' ').trim();
}

/** Escapa un token para meterlo en un RegExp de palabra completa. */
const escapar = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function ruleMatches(n: string, r: Rule): boolean {
  // `all` es conjunción: todos los tokens tienen que estar.
  if (r.all && !r.all.every((t) => n.includes(t))) return false;

  // `any` y `anyWord` son ALTERNATIVAS ENTRE SÍ, no dos condiciones que se
  // suman. Tratarlas como AND haría que una regla con las dos listas exigiera
  // un token de cada una: `precio_flete` dejaría de matchear el texto "CARO" a
  // secas, que es el caso más común y el que el comentario de `MIN_LEN`
  // defiende explícitamente.
  const hayAlternativas = !!(r.any?.length || r.anyWord?.length);
  if (hayAlternativas) {
    const porSubcadena = r.any?.some((t) => n.includes(t)) ?? false;
    // Límite de palabra sobre el texto YA normalizado (mayúsculas, sin
    // acentos): es fiable justamente porque no quedan diacríticos que lo rompan.
    const porPalabra = r.anyWord?.some((t) => new RegExp(`\\b${escapar(t)}\\b`).test(n)) ?? false;
    if (!porSubcadena && !porPalabra) return false;
  }
  return !!(r.all || hayAlternativas);
}

/**
 * Clasifica el TEXTO de un motivo de cancelación.
 * Vacío / ruido / no clasificable → catch-all `otro` + `desconocido`.
 */
export function classifyCancel(text: string | null | undefined): CancelClass {
  const n = norm(text || '');
  if (!n || n.length < MIN_LEN || GENERIC_NOISE.has(n)) return { ...CATCH_ALL };
  for (const r of RULES) {
    if (ruleMatches(n, r)) {
      return {
        categoria: r.categoria,
        culpa: r.culpa,
        tipo: r.tipo,
        cuentaEnTasa: r.cuentaEnTasa !== false,
        esGenerica: false,
      };
    }
  }
  return { ...CATCH_ALL };
}

export interface CancelRowLike {
  /** `order_results.reason`. null cuando no hay fila o vino vacía. */
  motivo: string | null | undefined;
  /**
   * 'guardian' = hay fila `canc` en order_results (lo canceló una asesora acá).
   * 'externo'  = NO la hay: se canceló en el panel de Dropi, o por
   *              cancel_orphan_pending_orders, o por dropi-nightly-reconcile.
   */
  origen: 'guardian' | 'externo';
  /**
   * El pedido volvió a entrar con otro `external_id` en menos de 48 h, mismo
   * cliente y mismo producto (RPC `cancelaciones_recreadas`).
   *
   * Separa un tercio del bucket ciego: hasta ahora "cancelado fuera del CRM"
   * mezclaba **la canceló una persona** con **se rehizo el pedido**, que son
   * problemas opuestos — uno se arregla cambiando dónde se cancela, el otro es
   * un falso positivo de la tasa. Medido en agosto-EC: 19 de 187 sin motivo.
   */
  recreado?: boolean;
  /**
   * Qué hizo el cliente con el botón de confirmar del WhatsApp
   * (`orders.chat_riesgo`, lo llena `importchat-sync`). Solo se usa el valor
   * `'mudo'`: el cliente NUNCA escribió nada por WhatsApp, jamás.
   *
   * Es lo que le pone nombre a una parte del bucket ciego. En agosto-EC eran
   * 157 pedidos con 66,2% de cancelación y $3.219 — la mitad de todo lo que se
   * perdió en el mes — y hasta ahora caían en "nadie anotó por qué".
   */
  riesgoChat?: string | null;
}

/**
 * Clasifica una FILA del reporte.
 *
 * Distingue dos faltantes que NO son el mismo problema y que por eso NO pueden
 * caer en el mismo bucket:
 *   - `sin_motivo`    → la asesora canceló y no dejó razón. Se arregla entrenando.
 *   - `externo_dropi` → nunca hubo fila: se canceló FUERA del CRM. Se arregla
 *                       cambiando dónde se cancela, no entrenando a nadie.
 *
 * El tamaño de `externo_dropi` es el KPI cero del proyecto: mientras sea grande,
 * ninguna conclusión sobre motivos describe a toda la operación.
 */
/** ¿La asesora dejó un motivo que diga algo? Vacío, muy corto o ruido no cuenta. */
function tieneMotivoUtil(motivo: string | null | undefined): boolean {
  const n = norm(motivo || '');
  return !!n && n.length >= MIN_LEN && !GENERIC_NOISE.has(n);
}

export function classifyCancelRow(row: CancelRowLike): CancelClass {
  // Va PRIMERO, antes que el origen: el pedido se rehizo, no se perdió. Da
  // igual quién apretó el botón — no hay venta perdida que explicar ni nadie a
  // quien entrenar. `cuentaEnTasa:false` lo saca del denominador, igual que a
  // su gemelo `recreado_edicion`, que es el mismo hecho contado por texto.
  if (row.recreado) {
    return {
      categoria: 'recreado_externo',
      culpa: 'operacion',
      tipo: 'recreado',
      cuentaEnTasa: false,
      esGenerica: false,
    };
  }
  // El cliente nunca escribió por WhatsApp. Va antes de `externo_dropi` porque
  // le pone nombre a lo que ese bucket solo podía llamar "no sé", pero DESPUÉS
  // de `recreado` y solo cuando NO hay motivo escrito: si una asesora anotó por
  // qué canceló, su palabra manda sobre cualquier señal automática.
  //
  // Tipo `desconocido` y NO `perdida_evitable`, aunque tiente: de los 96 que
  // nunca se confirmaron por teléfono, 63 fueron llamados hasta SEIS veces sin
  // que nadie atendiera. Llamar más no los salvaba. Lo que sí es evitable son
  // los 33 que no recibieron ni un intento, y eso se cuenta aparte y con su
  // propio número — no se disfraza de categoría.
  if (row.riesgoChat === 'mudo' && !tieneMotivoUtil(row.motivo)) {
    return {
      categoria: 'sin_whatsapp',
      culpa: 'trafico',
      tipo: 'desconocido',
      cuentaEnTasa: true,
      esGenerica: false,
    };
  }
  if (row.origen === 'externo') {
    return {
      categoria: 'externo_dropi',
      culpa: 'generica',
      tipo: 'desconocido',
      cuentaEnTasa: true,
      esGenerica: true,
    };
  }
  if (!tieneMotivoUtil(row.motivo)) {
    return {
      categoria: 'sin_motivo',
      culpa: 'generica',
      tipo: 'desconocido',
      cuentaEnTasa: true,
      esGenerica: true,
    };
  }
  return classifyCancel(row.motivo);
}

/** Etiqueta legible de una categoría, con fallback al slug crudo. */
export function cancelCategoriaLabel(categoria: string): string {
  return CANCEL_CATEGORIA_LABEL[categoria] || categoria;
}

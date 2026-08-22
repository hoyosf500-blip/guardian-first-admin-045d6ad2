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
 *   - `tipo`      → CUÁNTO DUELE (evitable / inevitable / ahorro)
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
    label: 'Nosotros',
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
    label: 'No llegamos a su zona',
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
  ahorro: 'Ahorro (cancelar estuvo bien)',
  desconocido: 'Sin clasificar',
};

/**
 * Orden para la UI: lo evitable primero (es lo accionable) y `desconocido`
 * segundo, porque un bucket grande de "sin clasificar" es en sí mismo el problema
 * a resolver, no una nota al pie.
 */
export const CANCEL_TIPO_ORDER: CancelTipo[] = [
  'perdida_evitable', 'desconocido', 'perdida_inevitable', 'ahorro',
];

/** Etiqueta legible por categoría. La UI NO inventa nombres: los lee de acá. */
export const CANCEL_CATEGORIA_LABEL: Record<string, string> = {
  // filtro interno / ahorro
  duplicado: 'Duplicado',
  prueba_interna: 'Pedido de prueba',
  mal_historial: 'Mal historial',
  sin_anticipo: 'No pagó el anticipo',
  // no cuentan en la tasa (el pedido se recreó)
  cambio_transportadora: 'Cambio de transportadora',
  recreado_edicion: 'Se recreó por edición',
  recreado_externo: 'Se rehizo el pedido (volvió a entrar)',
  // operación
  llamada_tardia: 'Llamamos tarde',
  demora_entrega: 'Se demora la entrega',
  datos_malos: 'Teléfono / datos malos',
  sin_stock: 'Sin stock',
  // precio y oferta
  precio_flete: 'Precio o flete muy caro',
  compro_en_otro_lado: 'Compró en otro lado',
  promesa_no_cumplida: 'No era lo que esperaba',
  // cliente
  no_contesta: 'No contesta',
  sin_dinero: 'No tiene plata ahora',
  arrepentido: 'Se arrepintió',
  familiar_no_autoriza: 'No lo autorizan en la casa',
  fuerza_mayor: 'Fuerza mayor (viaje, salud)',
  // tráfico
  no_reconoce_pedido: 'No reconoce el pedido',
  // transportadora
  sin_cobertura: 'No llega a su zona',
  // faltantes de dato
  sin_motivo: 'Canceló sin anotar motivo',
  externo_dropi: 'Cancelado fuera del CRM',
  otro: 'Otro / sin clasificar',
};

interface Rule {
  categoria: string;
  culpa: CancelCulpa;
  tipo: CancelTipo;
  /** Default true. false = el pedido se recreó, no se perdió. */
  cuentaEnTasa?: boolean;
  /** Al menos uno de estos tokens (ya normalizados) presente. */
  any?: string[];
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
    'ANTICIPO', 'ADELANTO', 'NO CONSIGNO', 'NO HIZO EL ABONO', 'SIN ABONO',
  ] },

  // ═══ NO ES PÉRDIDA — el pedido se RECREÓ, no se perdió ═══
  { categoria: 'cambio_transportadora', culpa: 'operacion', tipo: 'ahorro',
    cuentaEnTasa: false, any: [
    'CAMBIO DE TRANSPORTADORA', 'CAMBIO TRANSPORTADORA', 'OTRA TRANSPORTADORA',
    'CAMBIO DE CARRIER', 'CAMBIO DE TRANSPORT',
  ] },
  { categoria: 'recreado_edicion', culpa: 'operacion', tipo: 'ahorro',
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
    'NUMERO NO EXISTE', 'SIN TELEFONO', 'DATOS INCOMPLETOS', 'DATOS FALSOS',
    'DIRECCION FALSA', 'NUMERO INVALIDO',
  ] },
  { categoria: 'sin_stock', culpa: 'operacion', tipo: 'perdida_evitable', any: [
    'SIN STOCK', 'AGOTAD', 'NO HAY INVENTARIO', 'SIN INVENTARIO', 'NO HAY UNIDADES',
    'PROVEEDOR NO TIENE', 'DESCONTINUAD',
  ] },

  // ═══ PRECIO / OFERTA ═══
  { categoria: 'precio_flete', culpa: 'precio_oferta', tipo: 'perdida_evitable', any: [
    'MUY CARO', 'CARO', 'COSTOSO', 'PRECIO', 'EL FLETE', 'FLETE CARO', 'ENVIO CARO',
    'NO ESPERABA ESE VALOR', 'PENSO QUE ERA GRATIS', 'CREIA QUE ERA GRATIS',
    'MAS BARATO EN',
  ] },
  { categoria: 'compro_en_otro_lado', culpa: 'precio_oferta', tipo: 'perdida_evitable', any: [
    'YA LO COMPRO', 'LO COMPRO EN', 'LO CONSIGUIO', 'OTRA TIENDA', 'OTRA PAGINA',
    'YA LO TIENE', 'COMPRO EN OTRO',
  ] },
  { categoria: 'promesa_no_cumplida', culpa: 'precio_oferta', tipo: 'perdida_evitable', any: [
    'NO ERA LO QUE', 'NO ES LO QUE ESPERABA', 'EL ANUNCIO DECIA', 'LA PUBLICIDAD DECIA',
    'PENSO QUE ERA OTRO', 'PENSABA QUE VENIA', 'CREYO QUE ERAN', 'OTRA CANTIDAD',
    'NO ES EL PRODUCTO',
  ] },

  // ═══ TRÁFICO — el lead nunca fue real (plata de PAUTA, no de la operadora) ═══
  { categoria: 'no_reconoce_pedido', culpa: 'trafico', tipo: 'perdida_inevitable', any: [
    'NO HIZO EL PEDIDO', 'NO REALIZO EL PEDIDO', 'NO PIDIO', 'NUNCA ORDENO', 'NO ORDENO',
    'NO RECONOCE', 'NO SABE DE QUE', 'FUE SIN QUERER', 'POR ERROR', 'SE EQUIVOCO AL',
    'NO CONOCE LA TIENDA', 'EL NINO', 'UN MENOR', 'SU HIJO LO PIDIO',
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
  { categoria: 'arrepentido', culpa: 'cliente', tipo: 'perdida_evitable', any: [
    'CAMBIO DE OPINION', 'YA NO QUIERE', 'YA NO LO QUIERE', 'NO LO QUIERE', 'NO QUIERE',
    'SE ARREPINTIO', 'ARREPINT', 'DESISTE', 'NO DESEA', 'NO LE INTERESA', 'MEJOR NO',
    'LO PENSO MEJOR', 'CANCELA EL PEDIDO',
  ] },
  { categoria: 'familiar_no_autoriza', culpa: 'cliente', tipo: 'perdida_inevitable', any: [
    'EL ESPOSO', 'LA ESPOSA', 'LA MAMA', 'EL PAPA', 'NO LO AUTORIZ', 'NO LO DEJAN',
    'NO LE DIERON PERMISO',
  ] },
  { categoria: 'fuerza_mayor', culpa: 'cliente', tipo: 'perdida_inevitable', any: [
    'DE VIAJE', 'VIAJO', 'ESTA DE VIAJE', 'FALLECI', 'MURIO', 'ENFERM', 'HOSPITAL',
    'ACCIDENTE', 'EMERGENCIA', 'SE MUDO', 'CAMBIO DE CIUDAD', 'SE FUE DEL PAIS',
  ] },

  // ═══ TRANSPORTADORA ═══
  { categoria: 'sin_cobertura', culpa: 'transportadora', tipo: 'perdida_inevitable', any: [
    'SIN COBERTURA', 'NO HAY COBERTURA', 'FUERA DE COBERTURA', 'NO CUBREN', 'NO LLEGAN A',
    'NO LLEGA A SU ZONA', 'ZONA ROJA', 'ORDEN PUBLICO', 'DIFICIL ACCESO',
    'NO HAY DESPACHO A', 'NO ENTREGAN EN',
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

function ruleMatches(n: string, r: Rule): boolean {
  if (r.all && !r.all.every((t) => n.includes(t))) return false;
  if (r.any && !r.any.some((t) => n.includes(t))) return false;
  return !!(r.all || r.any);
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
export function classifyCancelRow(row: CancelRowLike): CancelClass {
  // Va PRIMERO, antes que el origen: el pedido se rehizo, no se perdió. Da
  // igual quién apretó el botón — no hay venta perdida que explicar ni nadie a
  // quien entrenar. `cuentaEnTasa:false` lo saca del denominador, igual que a
  // su gemelo `recreado_edicion`, que es el mismo hecho contado por texto.
  if (row.recreado) {
    return {
      categoria: 'recreado_externo',
      culpa: 'operacion',
      tipo: 'ahorro',
      cuentaEnTasa: false,
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
  const n = norm(row.motivo || '');
  if (!n || n.length < MIN_LEN || GENERIC_NOISE.has(n)) {
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

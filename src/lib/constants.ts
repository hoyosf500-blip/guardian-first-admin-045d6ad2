export const COL_MAP: Record<string, string[]> = {
  ID: ['ID', 'id', 'Id', 'NUMERO', 'Numero', 'N°', 'ORDER_ID', 'order_id', 'PEDIDO', 'Pedido'],
  NOMBRE: ['NOMBRE CLIENTE', 'Nombre Cliente', 'NOMBRE', 'Nombre', 'nombre', 'CLIENTE', 'Cliente', 'NAME', 'DESTINATARIO'],
  TELEFONO: ['TELÉFONO', 'TELEFONO', 'Telefono', 'Teléfono', 'telefono', 'CELULAR', 'Celular', 'PHONE', 'Tel'],
  CIUDAD: ['CIUDAD DESTINO', 'CIUDAD', 'Ciudad', 'Ciudad Destino', 'ciudad', 'CITY', 'MUNICIPIO', 'Destino'],
  PRODUCTO: ['PRODUCTO', 'Producto', 'producto', 'NOMBRE PRODUCTO', 'Nombre Producto', 'DESCRIPCION', 'ITEM'],
  ESTADO: ['ESTATUS', 'ESTADO', 'STATUS', 'Estado', 'Estatus', 'estado', 'estatus', 'ESTADO DROPI', 'ESTADO DEL PEDIDO'],
  FECHA: ['FECHA', 'Fecha', 'fecha', 'FECHA CREACION', 'Fecha Creacion', 'FECHA DE CREACION', 'CREATED', 'DATE'],
  FECHA_CONF: ['FECHA GUIA GENERADA', 'FECHA GUÍA GENERADA', 'Fecha Guia Generada', 'FECHA_GUIA_GENERADA', 'FECHA CONFIRMACION'],
  VALOR: ['TOTAL DE LA ORDEN', 'TOTAL', 'Total', 'VALOR', 'Valor', 'PRECIO', 'Total Orden', 'Precio Venta', 'TOTAL ORDEN', 'MONTO'],
  DIRECCION: ['DIRECCION', 'Dirección', 'Direccion', 'direccion', 'ADDRESS', 'DIRECCIÓN'],
  NOVEDAD: ['NOVEDAD', 'Novedad', 'novedad', 'OBSERVACION', 'Observacion'],
  GUIA: ['NÚMERO GUIA', 'NRO GUIA', 'NUMERO GUIA', 'GUIA', 'Guia', 'guia', 'NÚMERO DE GUÍA', 'N° GUIA', 'TRACKING'],
  TRANSPORTADORA: ['TRANSPORTADORA', 'Transportadora', 'transportadora', 'CARRIER', 'EMPRESA ENVIO'],
  TAGS: ['TAGS', 'Tags', 'tags', 'ETIQUETA', 'Etiqueta', 'LABEL'],
  NOVEDAD_SOL: ['FUE SOLUCIONADA LA NOVEDAD', 'Fue Solucionada La Novedad', 'NOVEDAD_SOLUCIONADA', 'NOVEDAD SOLUCIONADA'],
  FLETE: ['PRECIO FLETE', 'FLETE', 'Flete', 'Precio Flete', 'COSTO FLETE'],
  COSTO_PROD: ['PRECIO PROVEEDOR X CANTIDAD', 'PROVEEDOR', 'Costo Proveedor', 'PRECIO PROVEEDOR'],
  COSTO_DEV: ['COSTO DEVOLUCION FLETE', 'COSTO DEVOLUCION', 'Costo Devolucion', 'DEVOLUCION FLETE'],
  CANTIDAD: ['CANTIDAD', 'Cantidad', 'cantidad', 'QTY'],
  DEPARTAMENTO: ['DEPARTAMENTO DESTINO', 'DEPARTAMENTO', 'Departamento', 'DEPTO'],
  TIENDA: ['TIENDA', 'Tienda', 'tienda', 'STORE'],
};

/**
 * Motivos de cancelación que ve la operadora en el modal de Confirmar (CallView).
 * Compartidos CO + EC + GT.
 *
 * POR QUÉ CAMBIÓ LA LISTA (15-ago-2026)
 * La versión anterior mezclaba tres preguntas distintas en un solo campo y por eso
 * no servía para bajar las cancelaciones: 'No contesta' es un resultado y no un
 * motivo, 'Cambio de transportadora' NO es una cancelación (es una edición, y ya
 * tiene su propio camino en OrderEditorDialog → dropi-change-carrier con
 * result='cambio_transportadora'), y 'Cambió de opinión' era el tacho de basura
 * donde caían precio, demora, competencia y "no lo pedí" — cuatro problemas con
 * cuatro acciones distintas, todos invisibles bajo la misma etiqueta.
 * Cada motivo de esta lista lleva a UNA acción distinta; si no, no merece un botón.
 *
 * ⚠️ `value` ES LA CLAVE DEL HISTÓRICO. Se escribe tal cual en
 * `order_results.reason` y `src/lib/cancelTaxonomy.ts` lo clasifica leyendo ese
 * texto. Cambiar un `value` desclasifica los meses ya registrados. Para cambiar lo
 * que LEE la operadora se cambia `label`, que es puramente de pantalla.
 *
 * ⚠️ El atajo va en `hotkey` y NO por posición. Antes era `CANCEL_REASONS[k-1]`:
 * agregar o reordenar un motivo le remapeaba las teclas a la operadora en silencio,
 * a mitad de una llamada y sin que nadie se enterara.
 *
 * 'Otro' es el sentinel (`kind: 'texto'`): al elegirlo, el modal pide un texto libre
 * OBLIGATORIO en vez de cancelar de una. Ese texto es el bucle de mejora — si un
 * motivo escrito a mano se repite, se gana un botón en la próxima versión. Que suba
 * el uso de "Otro" NO es indisciplina: es que a la lista le falta una opción.
 */
export interface CancelReasonOption {
  /** Valor CANÓNICO que se escribe en order_results.reason. NUNCA se cambia. */
  value: string;
  /** Lo que ve la operadora. Se puede cambiar libremente. */
  label: string;
  /** Tecla del atajo. EXPLÍCITA: reordenar la lista no le remapea nada a nadie. */
  hotkey: string;
  /** 'texto' abre el textarea obligatorio en vez de cancelar de una. */
  kind?: 'motivo' | 'texto';
  /**
   * Ofrece reagendar antes de cancelar. Un cliente que dice "ahora no tengo
   * plata" no es una venta perdida: es una venta con fecha.
   */
  sugiereReagenda?: boolean;
}

export const CANCEL_REASONS: CancelReasonOption[] = [
  // La 1 queda igual a propósito: es la más usada y la memoria muscular vale.
  { hotkey: '1', value: 'No contesta', label: 'No contesta (3 intentos)' },
  { hotkey: '2', value: 'No reconoce el pedido', label: 'No lo pidió / no reconoce el pedido' },
  { hotkey: '3', value: 'Precio o flete muy caro', label: 'Precio o flete muy caro' },
  { hotkey: '4', value: 'Se arrepintió', label: 'Se arrepintió / ya no lo quiere' },
  { hotkey: '5', value: 'No tiene dinero ahora', label: 'No tiene plata ahora', sugiereReagenda: true },
  { hotkey: '6', value: 'Teléfono malo', label: 'Teléfono malo / no existe' },
  { hotkey: '7', value: 'No llega a su zona', label: 'No llega a su zona' },
  { hotkey: '8', value: 'Duplicado', label: 'Duplicado' },
  { hotkey: '9', value: 'Mal historial', label: 'Mal historial / no le vendemos' },
  { hotkey: '0', value: 'Otro', label: 'Otro (escribir)', kind: 'texto' },
];

// OLD-9: intervalo de polling fallback (cuando realtime falla o se cae el
// canal). Usado por useDataLoader, useNovedades.
// COST-1 (2026-04-29): subido de 5 → 15 min.
// COST-2 (2026-07-10): 15 → 60 min. Realtime cubre updates en vivo; el polling
// es solo safety-net. Antes: 70k+ queries/día por hook, DB al tope en MVP.
// El polling además se pausa cuando la pestaña está oculta (pollWhenVisible).
export const POLL_INTERVAL_MS = 60 * 60 * 1000;
// Auto-sync de Dropi (admin) — cada 2 h (antes 1 h) para bajar carga.
export const AUTO_SYNC_INTERVAL_MS = 2 * 60 * 60 * 1000;

// Transportadoras de COLOMBIA (tienda CO). Es el mapa por defecto.
export const CARRIER_TRACK: Record<string, string> = {
  'INTERRAPIDISIMO': 'https://www.interrapidisimo.com/sigue-tu-envio/',
  'INTER RAPIDISIMO': 'https://www.interrapidisimo.com/sigue-tu-envio/',
  'SERVIENTREGA': 'https://www.servientrega.com/wps/portal/rastreo-envio',
  'COORDINADORA': 'https://www.coordinadora.com/rastreo/rastreo-de-guia/',
  'ENVIA': 'https://hub.envia.co/landingrastreo/Rastreo/Index?guia=',
  'ENVÍA': 'https://hub.envia.co/landingrastreo/Rastreo/Index?guia=',
  'TCC': 'https://www.tcc.com.co/rastreo/',
  'VELOCES': 'https://veloces.com.co/',
  'DEPRISA': 'https://www.deprisa.com/rastreo/',
};

// Transportadoras de ECUADOR (tienda EC). Verificadas 2026-05-23.
// OJO: SERVIENTREGA existe en CO y EC con URL distinta → por eso el rastreo es
// por país (ver getTrackingUrl). Las que terminan en '=' reciben la guía al final.
export const CARRIER_TRACK_EC: Record<string, string> = {
  'GINTRACOM': 'https://ec.gintracom.site/web/site/tracking',
  'LAARCOURIER': 'https://fenixoper.laarcourier.com/Tracking/Guiacompleta.aspx?guia=',
  'LAAR': 'https://fenixoper.laarcourier.com/Tracking/Guiacompleta.aspx?guia=',
  'SERVIENTREGA': 'https://www.servientrega.com.ec/Tracking/?tipo=GUIA&guia=',
};

// Transportadoras de GUATEMALA (tienda GT). PENDIENTE: cargar las URLs reales de
// rastreo (Guatex, Cargo Expreso, Forza, etc. — dato del dueño). Se deja VACÍO a
// propósito: hasta tener las URLs correctas, un pedido GT NO muestra botón de
// rastreo (getTrackingUrl → null), que es MEJOR que mandarlo al sitio de la
// transportadora de OTRO país — el bug que había: GT heredaba el mapa colombiano
// y una guía "SERVIENTREGA" abría servientrega.com.co. Las que terminen en '='
// reciben la guía al final (mismo contrato que CO/EC).
export const CARRIER_TRACK_GT: Record<string, string> = {
  // 'GUATEX': 'https://www.guatex.com.gt/...guia=',
  // 'CARGO EXPRESO': 'https://cargoexpreso.com/...',
};

// Mapa de rastreo por país (country_code de la tienda activa).
export const CARRIER_TRACK_BY_COUNTRY: Record<string, Record<string, string>> = {
  CO: CARRIER_TRACK,
  EC: CARRIER_TRACK_EC,
  GT: CARRIER_TRACK_GT,
};

// SEG_ACTIONS (los 7 botones planos) se reemplazó por el modelo "revisión
// diaria": ver SEG_METHODS / SEG_CLOSERS en src/lib/segDailyReview.ts y el
// componente SegActionButtons. Las acciones ya no se pasan como prop a CrmTable.

export const RES_ACTIONS = [
  'Llame cliente', 'Reclame transportadora', 'Solicite devolucion',
  'Reenvio', 'Resuelto'
];

export const CARRIER_DEADLINES: Record<string, number> = {
  'INTERRAPIDISIMO': 5,
  'INTER RAPIDISIMO': 5,
  'COORDINADORA': 15,
  'TCC': 7,
  'SERVIENTREGA': 7,
  'ENVIA': 5,
  'ENVÍA': 5,
  'VELOCES': 5,
  'DEPRISA': 7,
};

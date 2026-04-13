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

export const CANCEL_REASONS = [
  'No contesta', '# equivocado', 'No quiere', 'No pedí',
  'Cambió de opinión', 'Precio', 'Ya compré', 'Después', 'Otro'
];

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

export const SEG_ACTIONS = [
  'Llame cliente', 'WhatsApp enviado', 'Reclame transportadora',
  'Esperando respuesta', 'Resuelto', 'Cliente recogera', 'Devolucion solicitada'
];

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
